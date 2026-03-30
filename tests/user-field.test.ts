/**
 * Sprint 3-C: user field forwarded to OpenRouter.
 *
 * Verifies that runAgentLoop sets the `user` field on the OpenRouter call
 * to opts.agentId when provided, or to the sessionId when agentId is absent.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mocked } from "./mock-helpers.js";
import { runAgentLoop } from "../src/loop.js";
import type { EmitEvent, OpenRouterCallResult } from "../src/types.js";

vi.mock("../src/openrouter.js", () => ({
  callOpenRouter: vi.fn(),
  shouldUseDirect: vi.fn().mockReturnValue(false),
}));
vi.mock("../src/session.js", () => ({
  loadSession: vi.fn().mockResolvedValue(null),
  saveSession: vi.fn().mockResolvedValue(undefined),
  newSessionId: vi.fn().mockReturnValue("user-field-session-id"),
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

describe("user field forwarded to OpenRouter (Sprint 3-C)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("user is set to agentId when agentId is provided", async () => {
    mocked(callOpenRouter).mockResolvedValueOnce(stopResponse());
    await runAgentLoop(loopOpts({ agentId: "my-agent-42" }));
    const user = mocked(callOpenRouter).mock.calls[0][0].user;
    expect(user).toBe("my-agent-42");
  });

  it("user is set to sessionId when no agentId is provided", async () => {
    mocked(callOpenRouter).mockResolvedValueOnce(stopResponse());
    // newSessionId mock returns "user-field-session-id"
    await runAgentLoop(loopOpts());
    const user = mocked(callOpenRouter).mock.calls[0][0].user;
    expect(user).toBe("user-field-session-id");
  });

  it("user is set to agentId over sessionId when both are available", async () => {
    mocked(callOpenRouter).mockResolvedValueOnce(stopResponse());
    await runAgentLoop(loopOpts({ agentId: "agent-override", sessionId: "existing-session" }));
    const user = mocked(callOpenRouter).mock.calls[0][0].user;
    expect(user).toBe("agent-override");
  });
});
