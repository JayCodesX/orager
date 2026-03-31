/**
 * Sprint 3-A: :online suffix logic.
 *
 * Verifies that runAgentLoop appends ":online" to the model string when
 * onlineSearch is true and the model has no existing variant suffix,
 * and that it does NOT append when the model already has a suffix or
 * onlineSearch is false/unset.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mocked } from "./mock-helpers.js";
import { runAgentLoop } from "../src/loop.js";
import type { EmitEvent, OpenRouterCallResult } from "../src/types.js";

vi.mock("../src/openrouter.js", () => ({
  callOpenRouter: vi.fn(),
  callDirect: vi.fn(),
  shouldUseDirect: vi.fn().mockReturnValue(false),
  fetchGenerationMeta: vi.fn().mockResolvedValue(null),
  callEmbeddings: vi.fn().mockResolvedValue([[]]),
}));

vi.mock("../src/session.js", () => ({
  loadSession: vi.fn().mockResolvedValue(null),
  saveSession: vi.fn().mockResolvedValue(undefined),
  newSessionId: vi.fn().mockReturnValue("online-test-session"),
}));
vi.mock("../src/audit.js", () => ({ auditApproval: vi.fn(), logToolCall: vi.fn(), logSandboxViolation: vi.fn() }));

const { callOpenRouter } = await import("../src/openrouter.js");

function stopResponse(): OpenRouterCallResult {
  return {
    content: "done",
    reasoning: "",
    toolCalls: [],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    cachedTokens: 0,
    cacheWriteTokens: 0,
    model: "test-model",
    finishReason: "stop",
    isError: false,
  };
}

function loopOpts(overrides: Partial<Parameters<typeof runAgentLoop>[0]> = {}) {
  return {
    prompt: "test",
    model: "gpt-4o",
    apiKey: "test-key",
    sessionId: null,
    addDirs: [],
    maxTurns: 1,
    maxRetries: 0,
    cwd: "/tmp",
    dangerouslySkipPermissions: false,
    verbose: false,
    onEmit: (_e: EmitEvent) => {},
    ...overrides,
  };
}

describe(":online suffix (Sprint 3-A)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("appends :online when onlineSearch=true and model has no variant suffix", async () => {
    mocked(callOpenRouter).mockResolvedValueOnce(stopResponse());
    await runAgentLoop(loopOpts({ onlineSearch: true, model: "gpt-4o" }));
    const calledModel = mocked(callOpenRouter).mock.calls[0][0].model;
    expect(calledModel).toBe("gpt-4o:online");
  });

  it("does NOT append :online when model already has a variant suffix", async () => {
    mocked(callOpenRouter).mockResolvedValueOnce(stopResponse());
    await runAgentLoop(loopOpts({ onlineSearch: true, model: "gpt-4o:nitro" }));
    const calledModel = mocked(callOpenRouter).mock.calls[0][0].model;
    expect(calledModel).toBe("gpt-4o:nitro");
  });

  it("does NOT append :online when onlineSearch is false", async () => {
    mocked(callOpenRouter).mockResolvedValueOnce(stopResponse());
    await runAgentLoop(loopOpts({ onlineSearch: false, model: "gpt-4o" }));
    const calledModel = mocked(callOpenRouter).mock.calls[0][0].model;
    expect(calledModel).toBe("gpt-4o");
  });

  it("does NOT append :online when onlineSearch is unset", async () => {
    mocked(callOpenRouter).mockResolvedValueOnce(stopResponse());
    await runAgentLoop(loopOpts({ model: "claude-3-5-sonnet" }));
    const calledModel = mocked(callOpenRouter).mock.calls[0][0].model;
    expect(calledModel).toBe("claude-3-5-sonnet");
  });

  it("appends :online to models with slashes (e.g. anthropic/claude-3-5-sonnet)", async () => {
    mocked(callOpenRouter).mockResolvedValueOnce(stopResponse());
    await runAgentLoop(loopOpts({ onlineSearch: true, model: "anthropic/claude-3-5-sonnet" }));
    const calledModel = mocked(callOpenRouter).mock.calls[0][0].model;
    expect(calledModel).toBe("anthropic/claude-3-5-sonnet:online");
  });
});
