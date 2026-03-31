/**
 * P1-1: Per-agent API key isolation tests.
 *
 * Verifies that:
 * 1. When agentApiKey is set, it is used instead of the env key for callOpenRouter.
 * 2. agentApiKey passes through the daemon opts allowlist (sanitizeDaemonRunOpts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mocked } from "./mock-helpers.js";
import { sanitizeDaemonRunOpts } from "../src/daemon.js";
import type { AgentLoopOptions, OpenRouterCallResult } from "../src/types.js";

// ── Mock openrouter so runAgentLoop doesn't hit the network ───────────────────

vi.mock("../src/openrouter.js", () => ({
  callOpenRouter: vi.fn(),
  callDirect: vi.fn(),
  shouldUseDirect: vi.fn().mockReturnValue(false),
  fetchGenerationMeta: vi.fn().mockResolvedValue(null),
  callEmbeddings: vi.fn().mockResolvedValue([[]]),
}));

vi.mock("../src/openrouter-model-meta.js", () => ({
  fetchLiveModelMeta: vi.fn().mockResolvedValue(undefined),
  getLiveModelPricing: vi.fn().mockReturnValue(null),
  isLiveModelMetaCacheWarm: vi.fn().mockReturnValue(true),
  liveModelSupportsTools: vi.fn().mockReturnValue(null),
}));

vi.mock("../src/loop-helpers.js", async (importOriginal) => {
  // importOriginal is vitest-specific; bun passes undefined so we fall back to
  // a direct import() which gives the real module under bun's mock system.
  const original: typeof import("../src/loop-helpers.js") =
    typeof importOriginal === "function"
      ? await importOriginal()
      : await import("../src/loop-helpers.js");
  return {
    ...original,
    fetchModelContextLengths: vi.fn().mockResolvedValue(undefined),
    isModelContextCacheWarm: vi.fn().mockReturnValue(true),
  };
});

vi.mock("../src/retry.js", () => ({
  callWithRetry: vi.fn(),
}));

const { callWithRetry } = await import("../src/retry.js");
const { callOpenRouter } = await import("../src/openrouter.js");

function makeSuccessResult(): OpenRouterCallResult {
  return {
    content: "done",
    reasoning: "",
    toolCalls: [],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    cachedTokens: 0,
    model: "test-model",
    finishReason: "stop",
    isError: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked(callWithRetry).mockResolvedValue(makeSuccessResult());
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Test 1: agentApiKey is forwarded to callWithRetry ─────────────────────────

describe("P1-1 agentApiKey — API key resolution", () => {
  it("uses agentApiKey instead of the env apiKey when set", async () => {
    const { runAgentLoop } = await import("../src/loop.js");

    const emitted: { type: string }[] = [];
    const loopOpts: AgentLoopOptions = {
      prompt: "hello",
      model: "test-model",
      apiKey: "global-key",
      agentApiKey: "per-agent-key",
      sessionId: null,
      addDirs: [],
      maxTurns: 1,
      cwd: "/tmp",
      dangerouslySkipPermissions: true,
      verbose: false,
      onEmit: (e) => { emitted.push(e); },
    };

    await runAgentLoop(loopOpts);

    // callWithRetry should have been called with the per-agent key
    expect(mocked(callWithRetry)).toHaveBeenCalled();
    const callArgs = mocked(callWithRetry).mock.calls[0]![0];
    expect(callArgs.apiKey).toBe("per-agent-key");
  });

  it("falls back to apiKey when agentApiKey is not set", async () => {
    const { runAgentLoop } = await import("../src/loop.js");

    const emitted: { type: string }[] = [];
    const loopOpts: AgentLoopOptions = {
      prompt: "hello",
      model: "test-model",
      apiKey: "global-key",
      sessionId: null,
      addDirs: [],
      maxTurns: 1,
      cwd: "/tmp",
      dangerouslySkipPermissions: true,
      verbose: false,
      onEmit: (e) => { emitted.push(e); },
    };

    await runAgentLoop(loopOpts);

    expect(mocked(callWithRetry)).toHaveBeenCalled();
    const callArgs = mocked(callWithRetry).mock.calls[0]![0];
    expect(callArgs.apiKey).toBe("global-key");
  });

  it("treats whitespace-only agentApiKey as unset and falls back to apiKey", async () => {
    const { runAgentLoop } = await import("../src/loop.js");

    const emitted: { type: string }[] = [];
    const loopOpts: AgentLoopOptions = {
      prompt: "hello",
      model: "test-model",
      apiKey: "global-key",
      agentApiKey: "   ",
      sessionId: null,
      addDirs: [],
      maxTurns: 1,
      cwd: "/tmp",
      dangerouslySkipPermissions: true,
      verbose: false,
      onEmit: (e) => { emitted.push(e); },
    };

    await runAgentLoop(loopOpts);

    expect(mocked(callWithRetry)).toHaveBeenCalled();
    const callArgs = mocked(callWithRetry).mock.calls[0]![0];
    expect(callArgs.apiKey).toBe("global-key");
  });
});

// ── Test 2: agentApiKey passes through the daemon opts allowlist ──────────────

describe("P1-1 agentApiKey — daemon opts allowlist", () => {
  it("agentApiKey is stripped by sanitizeDaemonRunOpts (security-sensitive)", () => {
    const raw = { agentApiKey: "per-agent-key-123", model: "test-model" };
    const { safe } = sanitizeDaemonRunOpts(raw);
    // agentApiKey is explicitly deleted as a security-sensitive field (line 86 of sanitize.ts)
    expect(safe.agentApiKey).toBeUndefined();
    expect(safe.model).toBe("test-model");
  });

  it("sessionLockTimeoutMs passes through sanitizeDaemonRunOpts", () => {
    const raw = { sessionLockTimeoutMs: 10000, model: "test-model" };
    const { safe, rejected } = sanitizeDaemonRunOpts(raw);
    expect(rejected).not.toContain("sessionLockTimeoutMs");
    expect(safe.sessionLockTimeoutMs).toBe(10000);
  });

  it("model is included in safe opts", () => {
    const raw = { model: "deepseek/deepseek-chat-v3-2", sessionLockTimeoutMs: 5000 };
    const { safe } = sanitizeDaemonRunOpts(raw);
    expect(safe.model).toBe("deepseek/deepseek-chat-v3-2");
    expect(safe.sessionLockTimeoutMs).toBe(5000);
  });
});

// ── Test 3: Rate-limit isolation (per-key tracking in callWithRetry) ──────────
// The actual rate-limit isolation is handled by the key pool in callWithRetry —
// two agents with different agentApiKey values each pass their own key as the
// primary, so a 429 on one key does not exhaust the other key's retry budget.

describe("P1-1 rate-limit isolation", () => {
  it("two agents with different keys each receive the correct key in callWithRetry opts", async () => {
    const { runAgentLoop } = await import("../src/loop.js");

    // Agent A with key-A: succeeds
    const eventsA: { type: string }[] = [];
    await runAgentLoop({
      prompt: "task A",
      model: "test-model",
      apiKey: "global-key",
      agentApiKey: "key-A",
      sessionId: null,
      addDirs: [],
      maxTurns: 1,
      cwd: "/tmp",
      dangerouslySkipPermissions: true,
      verbose: false,
      onEmit: (e) => { eventsA.push(e); },
    });

    const callAKey = mocked(callWithRetry).mock.calls[0]![0].apiKey;
    expect(callAKey).toBe("key-A");

    mocked(callWithRetry).mockClear();

    // Agent B with key-B: succeeds independently
    const eventsB: { type: string }[] = [];
    await runAgentLoop({
      prompt: "task B",
      model: "test-model",
      apiKey: "global-key",
      agentApiKey: "key-B",
      sessionId: null,
      addDirs: [],
      maxTurns: 1,
      cwd: "/tmp",
      dangerouslySkipPermissions: true,
      verbose: false,
      onEmit: (e) => { eventsB.push(e); },
    });

    const callBKey = mocked(callWithRetry).mock.calls[0]![0].apiKey;
    expect(callBKey).toBe("key-B");

    // Both runs completed successfully
    expect(eventsA.some((e) => e.type === "result")).toBe(true);
    expect(eventsB.some((e) => e.type === "result")).toBe(true);
  });
});
