/**
 * HTTP-level tests for callDirect (Anthropic direct path).
 *
 * Intercepts `fetch` to verify the exact request sent to
 * https://api.anthropic.com/v1/chat/completions without making real API calls.
 *
 * Covers:
 *  - metadata.user_id is set when opts.user is provided (Sprint 6-A fix)
 *  - metadata is absent when opts.user is not provided
 *  - request is sent to the Anthropic endpoint, not OpenRouter
 *  - "anthropic/" prefix is stripped from the model name
 *  - x-api-key header is used (not Authorization: Bearer)
 *  - ANTHROPIC_API_KEY env var takes precedence over opts.apiKey
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { callDirect } from "../src/openrouter.js";

// ── Minimal valid Anthropic SSE stream ────────────────────────────────────────
// Uses the same OpenAI-compatible SSE format Anthropic's endpoint returns.
// The stream must include a finish_reason so processLine() completes cleanly.

function makeAnthropicStream(content = "ok"): Response {
  const lines = [
    `data: {"id":"msg_1","model":"claude-3-5-sonnet-20241022","choices":[{"index":0,"delta":{"role":"assistant","content":"${content}"},"finish_reason":null}]}`,
    `data: {"id":"msg_1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}`,
    `data: [DONE]`,
  ];
  const encoder = new TextEncoder();
  const bytes = encoder.encode(lines.join("\n") + "\n");
  let sent = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (!sent) { sent = true; ctrl.enqueue(bytes); ctrl.close(); }
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

const BASE_OPTS = {
  apiKey: "fallback-key",
  model: "anthropic/claude-3-5-sonnet",
  messages: [{ role: "user" as const, content: "hello" }],
};

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ANTHROPIC_API_KEY;
});

// ── metadata.user_id ──────────────────────────────────────────────────────────

describe("callDirect — metadata.user_id forwarded to Anthropic (Sprint 6-A)", () => {
  it("sends metadata.user_id when opts.user is provided", async () => {
    let captured: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      captured = JSON.parse(init.body as string) as Record<string, unknown>;
      return Promise.resolve(makeAnthropicStream());
    }));

    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    await callDirect({ ...BASE_OPTS, user: "agent-abc" });

    expect(captured?.metadata).toEqual({ user_id: "agent-abc" });
  });

  it("does not include metadata when opts.user is absent", async () => {
    let captured: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      captured = JSON.parse(init.body as string) as Record<string, unknown>;
      return Promise.resolve(makeAnthropicStream());
    }));

    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    await callDirect(BASE_OPTS);

    expect(captured?.metadata).toBeUndefined();
  });

  it("different user values produce different user_id values", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string) as Record<string, unknown>);
      return Promise.resolve(makeAnthropicStream());
    }));

    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    await callDirect({ ...BASE_OPTS, user: "agent-1" });
    await callDirect({ ...BASE_OPTS, user: "agent-2" });

    expect((bodies[0]?.metadata as Record<string, unknown>)?.user_id).toBe("agent-1");
    expect((bodies[1]?.metadata as Record<string, unknown>)?.user_id).toBe("agent-2");
  });
});

// ── Endpoint and request shape ────────────────────────────────────────────────

describe("callDirect — HTTP request shape", () => {
  it("sends request to the Anthropic endpoint, not OpenRouter", async () => {
    let capturedUrl: string | undefined;
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      capturedUrl = url;
      return Promise.resolve(makeAnthropicStream());
    }));

    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    await callDirect(BASE_OPTS);

    expect(capturedUrl).toBe("https://api.anthropic.com/v1/chat/completions");
    expect(capturedUrl).not.toContain("openrouter");
  });

  it("strips 'anthropic/' prefix from model name in the request body", async () => {
    let captured: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      captured = JSON.parse(init.body as string) as Record<string, unknown>;
      return Promise.resolve(makeAnthropicStream());
    }));

    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    await callDirect({ ...BASE_OPTS, model: "anthropic/claude-opus-4-6" });

    expect(captured?.model).toBe("claude-opus-4-6");
    expect(String(captured?.model)).not.toContain("anthropic/");
  });

  it("uses x-api-key header, not Authorization: Bearer", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedHeaders = init.headers as Record<string, string>;
      return Promise.resolve(makeAnthropicStream());
    }));

    process.env.ANTHROPIC_API_KEY = "sk-ant-real-key";
    await callDirect(BASE_OPTS);

    expect(capturedHeaders?.["x-api-key"]).toBe("sk-ant-real-key");
    expect(capturedHeaders?.["Authorization"]).toBeUndefined();
  });

  it("ANTHROPIC_API_KEY env var takes precedence over opts.apiKey", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedHeaders = init.headers as Record<string, string>;
      return Promise.resolve(makeAnthropicStream());
    }));

    process.env.ANTHROPIC_API_KEY = "sk-ant-env-key";
    await callDirect({ ...BASE_OPTS, apiKey: "opts-key-should-be-ignored" });

    expect(capturedHeaders?.["x-api-key"]).toBe("sk-ant-env-key");
  });

  it("falls back to opts.apiKey when ANTHROPIC_API_KEY is not set", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedHeaders = init.headers as Record<string, string>;
      return Promise.resolve(makeAnthropicStream());
    }));

    // ANTHROPIC_API_KEY is NOT set (deleted in afterEach)
    await callDirect({ ...BASE_OPTS, apiKey: "opts-fallback-key" });

    expect(capturedHeaders?.["x-api-key"]).toBe("opts-fallback-key");
  });
});
