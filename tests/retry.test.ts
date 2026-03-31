import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mocked } from "./mock-helpers.js";
import { callWithRetry } from "../src/retry.js";
import type { OpenRouterCallResult } from "../src/types.js";

vi.mock("../src/openrouter.js", () => ({
  callOpenRouter: vi.fn(),
  callDirect: vi.fn(),
  shouldUseDirect: vi.fn().mockReturnValue(false),
  fetchGenerationMeta: vi.fn().mockResolvedValue(null),
  callEmbeddings: vi.fn().mockResolvedValue([[]]),
}));

const { callOpenRouter } = await import("../src/openrouter.js");

function successResult(content = "ok"): OpenRouterCallResult {
  return {
    content,
    reasoning: "",
    toolCalls: [],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    cachedTokens: 0,
    model: "test-model",
    finishReason: "stop",
    isError: false,
  };
}

function errorResult(message: string): OpenRouterCallResult {
  return {
    content: "",
    reasoning: "",
    toolCalls: [],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    cachedTokens: 0,
    model: "test-model",
    finishReason: "error",
    isError: true,
    errorMessage: message,
  };
}

const CALL_OPTS = {
  apiKey: "test-key",
  model: "test-model",
  messages: [{ role: "user" as const, content: "hi" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("callWithRetry", () => {
  // ── Success on first attempt ───────────────────────────────────────────────

  it("returns immediately on first-attempt success without retrying", async () => {
    mocked(callOpenRouter).mockResolvedValue(successResult());

    const promise = callWithRetry(CALL_OPTS, 3);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.isError).toBe(false);
    expect(mocked(callOpenRouter)).toHaveBeenCalledTimes(1);
  });

  // ── Retry on stream error result ───────────────────────────────────────────

  it("retries a transient stream error and succeeds on second attempt", async () => {
    mocked(callOpenRouter)
      .mockResolvedValueOnce(errorResult("503 service unavailable"))
      .mockResolvedValueOnce(successResult("recovered"));

    const promise = callWithRetry(CALL_OPTS, 3);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.isError).toBe(false);
    expect(result.content).toBe("recovered");
    expect(mocked(callOpenRouter)).toHaveBeenCalledTimes(2);
  });

  it("retries up to maxRetries times then returns the error result", async () => {
    mocked(callOpenRouter).mockResolvedValue(errorResult("rate limit 429"));

    const promise = callWithRetry(CALL_OPTS, 2);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.isError).toBe(true);
    // 1 initial + 2 retries = 3 total calls
    expect(mocked(callOpenRouter)).toHaveBeenCalledTimes(3);
  });

  // ── Retry on thrown exception ──────────────────────────────────────────────

  it("retries a thrown network error and succeeds", async () => {
    mocked(callOpenRouter)
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(successResult());

    const promise = callWithRetry(CALL_OPTS, 3);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.isError).toBe(false);
    expect(mocked(callOpenRouter)).toHaveBeenCalledTimes(2);
  });

  it("rethrows after exhausting retries on thrown errors", async () => {
    mocked(callOpenRouter).mockRejectedValue(new Error("timeout"));

    const promise = callWithRetry(CALL_OPTS, 1);
    // Attach a no-op catch handler early so the rejection is never "unhandled"
    // while timers are running (avoids Node/vitest unhandled-rejection warnings).
    // bun test hangs if expect(promise).rejects is created while promise is still
    // pending under fake timers, so we run timers first then assert.
    promise.catch(() => {});
    await vi.runAllTimersAsync();
    await expect(promise).rejects.toThrow("timeout");

    // 1 initial + 1 retry = 2 total calls
    expect(mocked(callOpenRouter)).toHaveBeenCalledTimes(2);
  });

  // ── Fatal errors — no retry ────────────────────────────────────────────────

  it("does not retry a 401 unauthorized error result", async () => {
    mocked(callOpenRouter).mockResolvedValue(errorResult("401 Unauthorized"));

    const promise = callWithRetry(CALL_OPTS, 3);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.isError).toBe(true);
    expect(mocked(callOpenRouter)).toHaveBeenCalledTimes(1);
  });

  it("does not retry an invalid api key error result", async () => {
    mocked(callOpenRouter).mockResolvedValue(errorResult("Invalid API key provided"));

    const promise = callWithRetry(CALL_OPTS, 3);
    await vi.runAllTimersAsync();

    await promise;
    expect(mocked(callOpenRouter)).toHaveBeenCalledTimes(1);
  });

  it("does not retry a thrown 401 error", async () => {
    mocked(callOpenRouter).mockRejectedValue(new Error("OpenRouter error 401 Unauthorized"));

    const promise = callWithRetry(CALL_OPTS, 3);
    // Attach a no-op catch handler early so the rejection is never "unhandled"
    // while timers are running (avoids Node/vitest unhandled-rejection warnings).
    promise.catch(() => {});
    await vi.runAllTimersAsync();
    await expect(promise).rejects.toThrow("401");

    expect(mocked(callOpenRouter)).toHaveBeenCalledTimes(1);
  });

  // ── maxRetries = 0 ────────────────────────────────────────────────────────

  it("with maxRetries=0 does not retry at all", async () => {
    mocked(callOpenRouter).mockResolvedValue(errorResult("503 unavailable"));

    const promise = callWithRetry(CALL_OPTS, 0);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.isError).toBe(true);
    expect(mocked(callOpenRouter)).toHaveBeenCalledTimes(1);
  });

  // ── Logging ───────────────────────────────────────────────────────────────

  it("calls onLog with retry details on each retry", async () => {
    mocked(callOpenRouter)
      .mockResolvedValueOnce(errorResult("503 unavailable"))
      .mockResolvedValueOnce(successResult());

    const logs: string[] = [];
    const promise = callWithRetry(CALL_OPTS, 3, (msg) => logs.push(msg));
    await vi.runAllTimersAsync();
    await promise;

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("retryable");
    expect(logs[0]).toContain("503 unavailable");
  });
});
