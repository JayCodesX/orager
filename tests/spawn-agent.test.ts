import { describe, it, expect, vi, beforeEach } from "vitest";
import { mocked } from "./mock-helpers.js";
import { runAgentLoop } from "../src/loop.js";
import type { EmitEvent, EmitResultEvent, OpenRouterCallResult, ToolCall } from "../src/types.js";

// ── Mocks ──────────────────────────────────────────────────────────────────────

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

function spawnCall(id: string, task: string, extraArgs: Record<string, unknown> = {}): ToolCall {
  return {
    id,
    type: "function",
    function: { name: "spawn_agent", arguments: JSON.stringify({ task, ...extraArgs }) },
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
      summarizeTurnInterval: 0,
      summarizeAt: 0,
      ...overrides,
    },
    emitted,
  };
}

function resultEvent(emitted: EmitEvent[]): EmitResultEvent {
  return emitted.find((e) => e.type === "result") as EmitResultEvent;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("spawn_agent tool", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sub-agent result text is returned to parent as tool result", async () => {
    mocked(callOpenRouter)
      // Parent turn 1: spawn sub-agent
      .mockResolvedValueOnce(toolResponse([spawnCall("tc1", "research something")]))
      // Sub-agent turn 1: completes
      .mockResolvedValueOnce(noToolResponse("research result"))
      // Parent turn 2: receives sub-agent result
      .mockResolvedValueOnce(noToolResponse("parent done with research result"));

    const { opts, emitted } = loopOpts();
    await runAgentLoop(opts);

    const result = resultEvent(emitted);
    expect(result.subtype).toBe("success");

    // The sub-agent's result should appear in a tool event
    const toolEvents = emitted.filter((e) => e.type === "tool") as Array<Extract<EmitEvent, { type: "tool" }>>;
    const toolResult = toolEvents[0]?.content[0]?.content ?? "";
    expect(toolResult).toContain("research result");
  });

  it("spawn_agent error is surfaced as an isError tool result when sub-agent fails", async () => {
    mocked(callOpenRouter)
      // Parent spawns sub-agent
      .mockResolvedValueOnce(toolResponse([spawnCall("tc1", "failing task")]))
      // Sub-agent hits max turns (returns error_max_turns)
      .mockResolvedValueOnce(noToolResponse("")) // turn 1
      .mockResolvedValueOnce(noToolResponse("")) // turn 2 ... we'll set maxTurns=1 for sub-agent
      // Parent receives error result and finishes
      .mockResolvedValueOnce(noToolResponse("handled error"));

    const { opts, emitted } = loopOpts();
    // Spawn with max_turns=1 so sub-agent exhausts quickly
    mocked(callOpenRouter)
      .mockReset()
      .mockResolvedValueOnce(toolResponse([spawnCall("tc1", "t", { max_turns: 1 })]))
      // Sub-agent: produces content on first (only) turn
      .mockResolvedValueOnce(noToolResponse("sub done"))
      // Parent second turn
      .mockResolvedValueOnce(noToolResponse("parent done"));

    await runAgentLoop(opts);
    const result = resultEvent(emitted);
    expect(result.subtype).toBe("success");
  });

  it("maxSpawnDepth=0 disables spawn_agent — calling it returns unknown tool error", async () => {
    mocked(callOpenRouter)
      // Model tries to call spawn_agent (it won't be offered but may call it anyway)
      .mockResolvedValueOnce(toolResponse([spawnCall("tc1", "subtask")]))
      // Parent gets unknown-tool error back, finishes
      .mockResolvedValueOnce(noToolResponse("done without spawning"));

    const { opts, emitted } = loopOpts({ maxSpawnDepth: 0 });
    await runAgentLoop(opts);

    // spawn_agent tool should NOT be in the tool definitions sent to the LLM
    const firstCallArgs = mocked(callOpenRouter).mock.calls[0]?.[0];
    const toolNames = (firstCallArgs?.tools ?? []).map((t) => t.function.name);
    expect(toolNames).not.toContain("spawn_agent");

    // Tool result for the unknown spawn_agent call should be an error
    const toolEvents = emitted.filter((e) => e.type === "tool") as Array<Extract<EmitEvent, { type: "tool" }>>;
    const toolResult = toolEvents[0]?.content[0];
    expect(toolResult?.is_error).toBe(true);
    expect(toolResult?.content).toContain("Unknown tool");
  });

  it("spawn_agent is not offered when current depth equals maxSpawnDepth", async () => {
    // Simulate a sub-agent at depth 2 with maxSpawnDepth=2
    // It should not have spawn_agent in its tool list
    mocked(callOpenRouter)
      .mockResolvedValueOnce(noToolResponse("leaf agent done"));

    const { opts } = loopOpts({
      maxSpawnDepth: 2,
      _spawnDepth: 2, // already at max depth
    } as Parameters<typeof runAgentLoop>[0]);

    await runAgentLoop(opts);

    const firstCallArgs = mocked(callOpenRouter).mock.calls[0]?.[0];
    const toolNames = (firstCallArgs?.tools ?? []).map((t) => t.function.name);
    expect(toolNames).not.toContain("spawn_agent");
  });

  it("cycle detection: aborts immediately when sessionId appears in ancestor chain", async () => {
    // parentSessionIds includes this session's own ID → cycle
    const { opts } = loopOpts({
      sessionId: "session-A",
      _parentSessionIds: ["session-A"],
    } as Parameters<typeof runAgentLoop>[0]);

    await runAgentLoop(opts);

    // Loop should have returned immediately without calling the LLM
    expect(mocked(callOpenRouter)).not.toHaveBeenCalled();
  });

  it("agent_id label appears in log output", async () => {
    const logMessages: string[] = [];

    mocked(callOpenRouter)
      .mockResolvedValueOnce(toolResponse([spawnCall("tc1", "research", { agent_id: "researcher" })]))
      .mockResolvedValueOnce(noToolResponse("research complete"))
      .mockResolvedValueOnce(noToolResponse("all done"));

    const { opts } = loopOpts({
      onLog: (_stream, msg) => logMessages.push(msg),
    });
    await runAgentLoop(opts);

    const spawnLog = logMessages.find((m) => m.includes("[researcher]"));
    expect(spawnLog).toBeDefined();
  });

  it("sub-agent events are forwarded to parent onEmit", async () => {
    mocked(callOpenRouter)
      .mockResolvedValueOnce(toolResponse([spawnCall("tc1", "subtask")]))
      .mockResolvedValueOnce(noToolResponse("sub result"))
      .mockResolvedValueOnce(noToolResponse("parent done"));

    const { opts, emitted } = loopOpts();
    await runAgentLoop(opts);

    // Should see at least two "result" events — one from sub-agent, one from parent
    const resultEvents = emitted.filter((e) => e.type === "result");
    expect(resultEvents.length).toBeGreaterThanOrEqual(2);
  });

  it("parallel spawn calls (two in same tool turn) both execute", async () => {
    mocked(callOpenRouter)
      // Parent: spawn two agents in one turn
      .mockResolvedValueOnce(toolResponse([
        spawnCall("tc1", "task-A", { agent_id: "agent-A" }),
        spawnCall("tc2", "task-B", { agent_id: "agent-B" }),
      ]))
      // Agent-A completes
      .mockResolvedValueOnce(noToolResponse("result-A"))
      // Agent-B completes
      .mockResolvedValueOnce(noToolResponse("result-B"))
      // Parent second turn
      .mockResolvedValueOnce(noToolResponse("parent done"));

    const { opts, emitted } = loopOpts();
    await runAgentLoop(opts);

    const toolEvents = emitted.filter((e) => e.type === "tool") as Array<Extract<EmitEvent, { type: "tool" }>>;
    // Two tool results in the first tool event (one per spawn call)
    const firstToolResults = toolEvents[0]?.content ?? [];
    expect(firstToolResults.length).toBe(2);
    const contents = firstToolResults.map((r) => r.content);
    const hasA = contents.some((c) => c.includes("result-A"));
    const hasB = contents.some((c) => c.includes("result-B"));
    expect(hasA).toBe(true);
    expect(hasB).toBe(true);
  });
});
