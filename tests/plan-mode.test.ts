import { describe, it, expect, vi, beforeEach } from "vitest";
import { runAgentLoop } from "../src/loop.js";
import type { EmitEvent, EmitResultEvent, OpenRouterCallResult, ToolCall } from "../src/types.js";

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock("../src/openrouter.js", () => ({
  callOpenRouter: vi.fn(),
  shouldUseDirect: vi.fn().mockReturnValue(false),
}));

vi.mock("../src/session.js", () => ({
  loadSession: vi.fn().mockResolvedValue(null),
  saveSession: vi.fn().mockResolvedValue(undefined),
  newSessionId: vi.fn().mockReturnValue("test-session-id"),
}));

vi.mock("../src/audit.js", () => ({ auditApproval: vi.fn(), logToolCall: vi.fn(), logSandboxViolation: vi.fn() }));

const { callOpenRouter } = await import("../src/openrouter.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

function noToolResponse(content = "done"): OpenRouterCallResult {
  return {
    content,
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

function toolResponse(toolCalls: ToolCall[]): OpenRouterCallResult {
  return {
    content: "",
    reasoning: "",
    toolCalls,
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    cachedTokens: 0,
    cacheWriteTokens: 0,
    model: "test-model",
    finishReason: "tool_calls",
    isError: false,
  };
}

function exitPlanCall(id: string, summary = "my plan"): ToolCall {
  return {
    id,
    type: "function",
    function: { name: "exit_plan_mode", arguments: JSON.stringify({ plan_summary: summary }) },
  };
}

function bashCall(id: string, command = "echo hi"): ToolCall {
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
      prompt: "Do the thing",
      model: "test-model",
      apiKey: "test-key",
      sessionId: null,
      addDirs: [],
      maxTurns: 10,
      maxRetries: 0,
      cwd: "/tmp",
      dangerouslySkipPermissions: true,
      verbose: false,
      onEmit: (e: EmitEvent) => emitted.push(e),
      ...overrides,
    },
    emitted,
  };
}

function resultEvent(emitted: EmitEvent[]): EmitResultEvent {
  return emitted.find((e) => e.type === "result") as EmitResultEvent;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("plan mode", () => {
  beforeEach(() => vi.clearAllMocks());

  it("planMode=true restricts LLM to readonly tools + exit_plan_mode", async () => {
    vi.mocked(callOpenRouter).mockResolvedValueOnce(noToolResponse("plan done"));

    const { opts } = loopOpts({ planMode: true });
    await runAgentLoop(opts);

    const callArgs = vi.mocked(callOpenRouter).mock.calls[0]?.[0];
    const offeredNames = (callArgs?.tools ?? []).map((t) => t.function.name);

    // Read-only tools should be offered
    expect(offeredNames).toContain("read_file");
    expect(offeredNames).toContain("glob");
    expect(offeredNames).toContain("grep");
    expect(offeredNames).toContain("exit_plan_mode");

    // Write/exec tools must NOT be offered while in plan mode
    expect(offeredNames).not.toContain("bash");
    expect(offeredNames).not.toContain("write_file");
    expect(offeredNames).not.toContain("edit_file");
  });

  it("planMode=false (default) offers full tool set including bash", async () => {
    vi.mocked(callOpenRouter).mockResolvedValueOnce(noToolResponse("done"));

    const { opts } = loopOpts({ planMode: false });
    await runAgentLoop(opts);

    const callArgs = vi.mocked(callOpenRouter).mock.calls[0]?.[0];
    const offeredNames = (callArgs?.tools ?? []).map((t) => t.function.name);

    expect(offeredNames).toContain("bash");
    expect(offeredNames).toContain("write_file");
    // exit_plan_mode should NOT be in the tool list when not in plan mode
    expect(offeredNames).not.toContain("exit_plan_mode");
  });

  it("calling exit_plan_mode switches to full tool set for subsequent turns", async () => {
    vi.mocked(callOpenRouter)
      // Turn 1 (plan mode): call exit_plan_mode
      .mockResolvedValueOnce(toolResponse([exitPlanCall("tc1", "I have a plan")]))
      // Turn 2 (execution mode): full tools now available
      .mockResolvedValueOnce(noToolResponse("execution done"));

    const { opts } = loopOpts({ planMode: true });
    await runAgentLoop(opts);

    // Turn 2 call should have bash in its tool list
    const turn2Args = vi.mocked(callOpenRouter).mock.calls[1]?.[0];
    const turn2Tools = (turn2Args?.tools ?? []).map((t) => t.function.name);
    expect(turn2Tools).toContain("bash");
    expect(turn2Tools).toContain("write_file");
  });

  it("plan mode enforces non-readonly tool calls — returns error result without executing", async () => {
    vi.mocked(callOpenRouter)
      // Turn 1 (plan mode): model tries to call bash despite being in plan mode
      .mockResolvedValueOnce(toolResponse([bashCall("tc1", "rm -rf /")]))
      // Turn 2: model receives the error, then exits plan mode properly
      .mockResolvedValueOnce(toolResponse([exitPlanCall("tc2")]))
      // Turn 3: execution mode
      .mockResolvedValueOnce(noToolResponse("fixed"));

    const { opts, emitted } = loopOpts({ planMode: true });
    await runAgentLoop(opts);

    const result = resultEvent(emitted);
    expect(result.subtype).toBe("success");

    // The bash call must have returned an error result, not executed
    const toolEvents = emitted.filter((e) => e.type === "tool") as Array<Extract<EmitEvent, { type: "tool" }>>;
    const bashToolResult = toolEvents[0]?.content.find((r) => r.tool_use_id === "tc1");
    expect(bashToolResult?.is_error).toBe(true);
    expect(bashToolResult?.content).toContain("not available in plan mode");
  });

  it("exit_plan_mode tool result includes plan summary", async () => {
    vi.mocked(callOpenRouter)
      .mockResolvedValueOnce(toolResponse([exitPlanCall("tc1", "step 1 then step 2")]))
      .mockResolvedValueOnce(noToolResponse("done"));

    const { opts, emitted } = loopOpts({ planMode: true });
    await runAgentLoop(opts);

    const toolEvents = emitted.filter((e) => e.type === "tool") as Array<Extract<EmitEvent, { type: "tool" }>>;
    const exitResult = toolEvents[0]?.content.find((r) => r.tool_use_id === "tc1");
    expect(exitResult?.content).toContain("step 1 then step 2");
    expect(exitResult?.is_error).toBeFalsy();
  });

  it("system prompt includes PLAN MODE ACTIVE notice when planMode=true", async () => {
    vi.mocked(callOpenRouter).mockResolvedValueOnce(noToolResponse("done"));

    const { opts } = loopOpts({ planMode: true });
    await runAgentLoop(opts);

    const callArgs = vi.mocked(callOpenRouter).mock.calls[0]?.[0];
    const systemMsg = callArgs?.messages?.find((m) => m.role === "system");
    expect((systemMsg?.content as string)).toContain("PLAN MODE ACTIVE");
    expect((systemMsg?.content as string)).toContain("exit_plan_mode");
  });

  it("system prompt does NOT include plan mode notice when planMode=false", async () => {
    vi.mocked(callOpenRouter).mockResolvedValueOnce(noToolResponse("done"));

    const { opts } = loopOpts({ planMode: false });
    await runAgentLoop(opts);

    const callArgs = vi.mocked(callOpenRouter).mock.calls[0]?.[0];
    const systemMsg = callArgs?.messages?.find((m) => m.role === "system");
    expect((systemMsg?.content as string)).not.toContain("PLAN MODE ACTIVE");
  });
});
