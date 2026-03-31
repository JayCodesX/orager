import { describe, it, expect, vi, beforeEach } from "vitest";
import { mocked } from "./mock-helpers.js";
import { runAgentLoop } from "../src/loop.js";
import type { EmitEvent, OpenRouterCallResult, ToolCall } from "../src/types.js";

// ── Mocks ─────────────────────────────────────────────────────────────────────

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
  newSessionId: vi.fn().mockReturnValue("test-session-id"),
}));

const { callOpenRouter } = await import("../src/openrouter.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

function noToolResponse(content = "done"): OpenRouterCallResult {
  return {
    content,
    reasoning: "",
    toolCalls: [],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    cachedTokens: 0,
    model: "test-model",
    finishReason: "stop",
    isError: false,
  };
}

function toolResponse(calls: ToolCall[]): OpenRouterCallResult {
  return {
    content: "",
    reasoning: "",
    toolCalls: calls,
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    cachedTokens: 0,
    model: "test-model",
    finishReason: "tool_calls",
    isError: false,
  };
}

function bashCall(id: string, command: string): ToolCall {
  return {
    id,
    type: "function",
    function: { name: "bash", arguments: JSON.stringify({ command }) },
  };
}

function loopOpts(overrides: Partial<Parameters<typeof runAgentLoop>[0]> = {}) {
  const emitted: EmitEvent[] = [];
  return {
    opts: {
      prompt: "Do stuff",
      model: "test-model",
      apiKey: "test-key",
      sessionId: null,
      addDirs: [],
      maxTurns: 5,
      maxRetries: 0,
      cwd: "/tmp",
      dangerouslySkipPermissions: false,
      verbose: false,
      onEmit: (e: EmitEvent) => emitted.push(e),
      ...overrides,
    },
    emitted,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("tool approval", () => {
  it("executes tool without asking when requireApproval is not set", async () => {
    const approvalFn = vi.fn().mockResolvedValue(true);
    mocked(callOpenRouter)
      .mockResolvedValueOnce(toolResponse([bashCall("1", "echo hi")]))
      .mockResolvedValueOnce(noToolResponse());

    const { opts } = loopOpts({ onApprovalRequest: approvalFn });
    await runAgentLoop(opts);

    expect(approvalFn).not.toHaveBeenCalled();
  });

  it("calls onApprovalRequest when requireApproval is 'all'", async () => {
    const approvalFn = vi.fn().mockResolvedValue(true);
    mocked(callOpenRouter)
      .mockResolvedValueOnce(toolResponse([bashCall("1", "echo hi")]))
      .mockResolvedValueOnce(noToolResponse());

    const { opts } = loopOpts({ requireApproval: "all", onApprovalRequest: approvalFn });
    await runAgentLoop(opts);

    expect(approvalFn).toHaveBeenCalledOnce();
    expect(approvalFn).toHaveBeenCalledWith("bash", expect.objectContaining({ command: "echo hi" }));
  });

  it("runs the tool when approval is granted", async () => {
    const approvalFn = vi.fn().mockResolvedValue(true);
    mocked(callOpenRouter)
      .mockResolvedValueOnce(toolResponse([bashCall("1", "echo approved")]))
      .mockResolvedValueOnce(noToolResponse("done"));

    const { opts, emitted } = loopOpts({ requireApproval: "all", onApprovalRequest: approvalFn });
    await runAgentLoop(opts);

    const toolEvt = emitted.find((e) => e.type === "tool");
    expect(toolEvt).toBeDefined();
    // Tool actually ran — content should not be a denial message
    const toolContent = (toolEvt as any).content[0].content as string;
    expect(toolContent).not.toContain("denied");
  });

  it("returns denial result when approval is rejected", async () => {
    const approvalFn = vi.fn().mockResolvedValue(false);
    mocked(callOpenRouter)
      .mockResolvedValueOnce(toolResponse([bashCall("1", "rm -rf /")]))
      .mockResolvedValueOnce(noToolResponse());

    const { opts, emitted } = loopOpts({ requireApproval: "all", onApprovalRequest: approvalFn });
    await runAgentLoop(opts);

    const toolEvt = emitted.find((e) => e.type === "tool");
    expect(toolEvt).toBeDefined();
    const toolContent = (toolEvt as any).content[0].content as string;
    expect(toolContent).toContain("denied");
    expect((toolEvt as any).content[0].is_error).toBe(true);
  });

  it("only prompts approval for tools listed in requireApproval array", async () => {
    const approvalFn = vi.fn().mockResolvedValue(true);
    const readCall: ToolCall = {
      id: "2",
      type: "function",
      function: { name: "read_file", arguments: JSON.stringify({ path: "/tmp/test.txt" }) },
    };

    mocked(callOpenRouter)
      .mockResolvedValueOnce(toolResponse([bashCall("1", "echo hi"), readCall]))
      .mockResolvedValueOnce(noToolResponse());

    // Only require approval for bash, not read_file
    const { opts } = loopOpts({
      requireApproval: ["bash"],
      onApprovalRequest: approvalFn,
    });
    await runAgentLoop(opts);

    // Approval called once (only for bash)
    expect(approvalFn).toHaveBeenCalledOnce();
    expect(approvalFn).toHaveBeenCalledWith("bash", expect.any(Object));
  });

  it("skips all approvals when dangerouslySkipPermissions is true", async () => {
    const approvalFn = vi.fn().mockResolvedValue(true);
    mocked(callOpenRouter)
      .mockResolvedValueOnce(toolResponse([bashCall("1", "echo hi")]))
      .mockResolvedValueOnce(noToolResponse());

    const { opts } = loopOpts({
      requireApproval: "all",
      dangerouslySkipPermissions: true,
      onApprovalRequest: approvalFn,
    });
    await runAgentLoop(opts);

    expect(approvalFn).not.toHaveBeenCalled();
  });
});
