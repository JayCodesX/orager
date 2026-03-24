import { describe, it, expect, vi, beforeEach } from "vitest";
import { runAgentLoop } from "../src/loop.js";
import type { EmitEvent, EmitResultEvent, EmitToolEvent, OpenRouterCallResult, ToolCall, ToolExecutor } from "../src/types.js";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("../src/openrouter.js", () => ({
  callOpenRouter: vi.fn(),
}));

vi.mock("../src/session.js", () => ({
  loadSession: vi.fn().mockResolvedValue(null),
  saveSession: vi.fn().mockResolvedValue(undefined),
  newSessionId: vi.fn().mockReturnValue("test-session-id"),
}));

// Import mocked functions after vi.mock declarations (vitest hoists vi.mock)
const { callOpenRouter } = await import("../src/openrouter.js");
const { saveSession, loadSession } = await import("../src/session.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

function noToolResponse(content = "Task complete"): OpenRouterCallResult {
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

function toolResponse(toolCalls: ToolCall[]): OpenRouterCallResult {
  return {
    content: "",
    reasoning: "",
    toolCalls,
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    cachedTokens: 0,
    model: "test-model",
    finishReason: "tool_calls",
    isError: false,
  };
}

function errorResponse(message: string): OpenRouterCallResult {
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
      prompt: "Do the thing",
      model: "test-model",
      apiKey: "test-key",
      sessionId: null,
      addDirs: [],
      maxTurns: 5,
      maxRetries: 0,   // disable retries in unit tests — retry behavior is tested in retry.test.ts
      cwd: "/tmp",
      dangerouslySkipPermissions: false,
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

function toolEvent(emitted: EmitEvent[]): EmitToolEvent {
  return emitted.find((e) => e.type === "tool") as EmitToolEvent;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runAgentLoop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Single-turn happy path ─────────────────────────────────────────────────

  it("single turn with no tool calls emits init, assistant, result:success", async () => {
    vi.mocked(callOpenRouter).mockResolvedValueOnce(noToolResponse("All done"));
    const { opts, emitted } = loopOpts();

    await runAgentLoop(opts);

    expect(emitted[0]).toMatchObject({ type: "system", subtype: "init" });
    expect(emitted[1]).toMatchObject({ type: "assistant" });
    expect(resultEvent(emitted)).toMatchObject({ type: "result", subtype: "success", result: "All done" });
  });

  it("emits result with accumulated usage", async () => {
    vi.mocked(callOpenRouter).mockResolvedValueOnce({
      ...noToolResponse(),
      usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
      cachedTokens: 20,
    });
    const { opts, emitted } = loopOpts();

    await runAgentLoop(opts);

    const result = resultEvent(emitted);
    expect(result.usage.input_tokens).toBe(100);
    expect(result.usage.output_tokens).toBe(40);
    expect(result.usage.cache_read_input_tokens).toBe(20);
  });

  it("reasoning block appears before text block in assistant event", async () => {
    vi.mocked(callOpenRouter).mockResolvedValueOnce({
      ...noToolResponse("answer"),
      reasoning: "let me think...",
    });
    const { opts, emitted } = loopOpts();

    await runAgentLoop(opts);

    const assistantEvent = emitted.find((e) => e.type === "assistant") as Extract<EmitEvent, { type: "assistant" }>;
    expect(assistantEvent.message.content[0].type).toBe("thinking");
    expect(assistantEvent.message.content[1].type).toBe("text");
  });

  // ── Tool calls ─────────────────────────────────────────────────────────────

  it("executes tool calls and passes results back in next turn", async () => {
    vi.mocked(callOpenRouter)
      .mockResolvedValueOnce(toolResponse([bashCall("call-1", "echo hello")]))
      .mockResolvedValueOnce(noToolResponse("done"));
    const { opts, emitted } = loopOpts();

    await runAgentLoop(opts);

    expect(vi.mocked(callOpenRouter)).toHaveBeenCalledTimes(2);
    // Second call's messages should include a tool result
    const secondCallMessages = vi.mocked(callOpenRouter).mock.calls[1][0].messages;
    expect(secondCallMessages.some((m: { role: string }) => m.role === "tool")).toBe(true);
    expect(resultEvent(emitted).subtype).toBe("success");
  });

  it("emits tool event with each tool result", async () => {
    vi.mocked(callOpenRouter)
      .mockResolvedValueOnce(toolResponse([bashCall("call-1", "echo hi")]))
      .mockResolvedValueOnce(noToolResponse("done"));
    const { opts, emitted } = loopOpts();

    await runAgentLoop(opts);

    const te = toolEvent(emitted);
    expect(te).toBeDefined();
    expect(te.content[0].tool_use_id).toBe("call-1");
    expect(te.content[0].is_error).toBeFalsy();
  });

  it("accumulates usage across multiple turns", async () => {
    vi.mocked(callOpenRouter)
      .mockResolvedValueOnce({
        ...toolResponse([bashCall("call-1", "echo a")]),
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      })
      .mockResolvedValueOnce({
        ...noToolResponse("done"),
        usage: { prompt_tokens: 200, completion_tokens: 30, total_tokens: 230 },
      });
    const { opts, emitted } = loopOpts();

    await runAgentLoop(opts);

    const result = resultEvent(emitted);
    expect(result.usage.input_tokens).toBe(300);
    expect(result.usage.output_tokens).toBe(80);
  });

  // ── Max turns ──────────────────────────────────────────────────────────────

  it("hits max_turns and emits error_max_turns", async () => {
    // Always returns tool calls so the loop never breaks on its own
    vi.mocked(callOpenRouter).mockResolvedValue(toolResponse([bashCall("call-1", "echo hi")]));
    const { opts, emitted } = loopOpts({ maxTurns: 2 });

    await runAgentLoop(opts);

    expect(resultEvent(emitted).subtype).toBe("error_max_turns");
    expect(vi.mocked(callOpenRouter)).toHaveBeenCalledTimes(2);
  });

  // ── Unknown tool ───────────────────────────────────────────────────────────

  it("handles unknown tool name as error tool result and continues loop", async () => {
    const unknownCall: ToolCall = {
      id: "call-x",
      type: "function",
      function: { name: "nonexistent_tool", arguments: "{}" },
    };
    vi.mocked(callOpenRouter)
      .mockResolvedValueOnce(toolResponse([unknownCall]))
      .mockResolvedValueOnce(noToolResponse("done"));
    const { opts, emitted } = loopOpts();

    await runAgentLoop(opts);

    const te = toolEvent(emitted);
    expect(te.content[0].is_error).toBe(true);
    expect(te.content[0].content).toContain("Unknown tool");
    expect(resultEvent(emitted).subtype).toBe("success");
  });

  // ── Malformed tool JSON ────────────────────────────────────────────────────

  it("handles invalid tool JSON as error tool result and continues loop", async () => {
    const badCall: ToolCall = {
      id: "call-bad",
      type: "function",
      function: { name: "bash", arguments: "not-valid-json" },
    };
    vi.mocked(callOpenRouter)
      .mockResolvedValueOnce(toolResponse([badCall]))
      .mockResolvedValueOnce(noToolResponse("done"));
    const { opts, emitted } = loopOpts();

    await runAgentLoop(opts);

    const te = toolEvent(emitted);
    expect(te.content[0].is_error).toBe(true);
    expect(resultEvent(emitted).subtype).toBe("success");
  });

  // ── Tool executor throws ───────────────────────────────────────────────────

  it("handles tool executor throw as error tool result and continues loop", async () => {
    const { bashTool } = await import("../src/tools/bash.js");
    vi.spyOn(bashTool, "execute").mockRejectedValueOnce(new Error("Disk full"));

    vi.mocked(callOpenRouter)
      .mockResolvedValueOnce(toolResponse([bashCall("call-throw", "echo hi")]))
      .mockResolvedValueOnce(noToolResponse("recovered"));
    const { opts, emitted } = loopOpts();

    await runAgentLoop(opts);

    const te = toolEvent(emitted);
    expect(te.content[0].is_error).toBe(true);
    expect(te.content[0].content).toContain("Disk full");
    expect(resultEvent(emitted).subtype).toBe("success");
  });

  // ── OpenRouter error ───────────────────────────────────────────────────────

  it("OpenRouter stream error exits loop with result:error", async () => {
    vi.mocked(callOpenRouter).mockResolvedValueOnce(errorResponse("Rate limit exceeded"));
    const { opts, emitted } = loopOpts();

    await runAgentLoop(opts);

    const result = resultEvent(emitted);
    expect(result.subtype).toBe("error");
    expect(result.result).toContain("Rate limit exceeded");
  });

  it("callOpenRouter rejection exits loop with result:error", async () => {
    vi.mocked(callOpenRouter).mockRejectedValueOnce(new Error("Network error"));
    const { opts, emitted } = loopOpts();

    await runAgentLoop(opts);

    expect(resultEvent(emitted).subtype).toBe("error");
    expect(resultEvent(emitted).result).toContain("Network error");
  });

  // ── Session persistence ────────────────────────────────────────────────────

  it("saves session after successful run", async () => {
    vi.mocked(callOpenRouter).mockResolvedValueOnce(noToolResponse());
    const { opts } = loopOpts();

    await runAgentLoop(opts);

    expect(vi.mocked(saveSession)).toHaveBeenCalledOnce();
    const saved = vi.mocked(saveSession).mock.calls[0][0];
    expect(saved.sessionId).toBe("test-session-id");
    expect(saved.cwd).toBe("/tmp");
  });

  it("saves session (best-effort) after error", async () => {
    vi.mocked(callOpenRouter).mockRejectedValueOnce(new Error("Boom"));
    const { opts } = loopOpts();

    await runAgentLoop(opts);

    expect(vi.mocked(saveSession)).toHaveBeenCalledOnce();
  });

  it("does not throw even if session save fails", async () => {
    vi.mocked(callOpenRouter).mockResolvedValueOnce(noToolResponse());
    vi.mocked(saveSession).mockRejectedValueOnce(new Error("Disk full"));
    const { opts, emitted } = loopOpts();

    await expect(runAgentLoop(opts)).resolves.toBeUndefined();
    expect(resultEvent(emitted).subtype).toBe("success");
  });
});

// ── Unlimited turns ───────────────────────────────────────────────────────────

describe("runAgentLoop — unlimited turns (maxTurns=0)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not emit error_max_turns when maxTurns=0 and model stops naturally", async () => {
    // Two tool-call turns then a final text response
    vi.mocked(callOpenRouter)
      .mockResolvedValueOnce(toolResponse([bashCall("c1", "echo a")]))
      .mockResolvedValueOnce(toolResponse([bashCall("c2", "echo b")]))
      .mockResolvedValueOnce(noToolResponse("done after 2 turns"));
    const { opts, emitted } = loopOpts({ maxTurns: 0 });

    await runAgentLoop(opts);

    expect(resultEvent(emitted).subtype).toBe("success");
    expect(vi.mocked(callOpenRouter)).toHaveBeenCalledTimes(3);
  });

  it("never stops on its own when the model keeps calling tools (verified via call count cap)", async () => {
    // Always returns a tool call — with maxTurns=0 the loop would run forever,
    // so we limit via mockResolvedValue cycling and verify it ran >5 turns.
    let calls = 0;
    vi.mocked(callOpenRouter).mockImplementation(async () => {
      calls++;
      if (calls >= 7) return noToolResponse("stopped");
      return toolResponse([bashCall(`c${calls}`, "echo hi")]);
    });
    const { opts, emitted } = loopOpts({ maxTurns: 0 });

    await runAgentLoop(opts);

    expect(calls).toBe(7);
    expect(resultEvent(emitted).subtype).toBe("success");
  });
});

// ── Force resume ─────────────────────────────────────────────────────────────

describe("runAgentLoop — --force-resume", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects resume without --force-resume when cwd differs", async () => {
    vi.mocked(loadSession).mockResolvedValueOnce({
      sessionId: "sess-old",
      model: "test-model",
      messages: [{ role: "user", content: "prev prompt" }],
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      turnCount: 1,
      cwd: "/other/dir",   // different from /tmp used in opts
    });
    vi.mocked(callOpenRouter).mockResolvedValueOnce(noToolResponse("fresh"));
    const logs: string[] = [];
    const { opts, emitted } = loopOpts({
      sessionId: "sess-old",
      forceResume: false,
      onLog: (_s, msg) => logs.push(msg),
    });

    await runAgentLoop(opts);

    // Should warn and start fresh
    expect(logs.some((l) => l.includes("different cwd"))).toBe(true);
    // The result is still success because it starts a new session
    expect(resultEvent(emitted).subtype).toBe("success");
    // Messages in the call should NOT include the old session message
    const callMessages = vi.mocked(callOpenRouter).mock.calls[0][0].messages;
    expect(callMessages.some((m: { content: string }) => m.content === "prev prompt")).toBe(false);
  });

  it("resumes session with --force-resume even when cwd differs", async () => {
    vi.mocked(loadSession).mockResolvedValueOnce({
      sessionId: "sess-old",
      model: "test-model",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "prev prompt" },
        { role: "assistant", content: "prev answer" },
      ],
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      turnCount: 1,
      cwd: "/other/dir",
    });
    vi.mocked(callOpenRouter).mockResolvedValueOnce(noToolResponse("continued"));
    const logs: string[] = [];
    const { opts } = loopOpts({
      sessionId: "sess-old",
      forceResume: true,
      onLog: (_s, msg) => logs.push(msg),
    });

    await runAgentLoop(opts);

    // Should warn but still resume
    expect(logs.some((l) => l.includes("different cwd"))).toBe(true);
    // The call should include the resumed messages
    const callMessages = vi.mocked(callOpenRouter).mock.calls[0][0].messages;
    expect(callMessages.some((m: { content: string }) => m.content === "prev answer")).toBe(true);
  });
});

// ── dangerouslySkipPermissions warning ───────────────────────────────────────

describe("runAgentLoop — dangerouslySkipPermissions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("logs a stderr warning when dangerouslySkipPermissions is true", async () => {
    vi.mocked(callOpenRouter).mockResolvedValueOnce(noToolResponse("done"));
    const logs: string[] = [];
    const { opts } = loopOpts({
      dangerouslySkipPermissions: true,
      onLog: (_s, msg) => logs.push(msg),
    });

    await runAgentLoop(opts);

    expect(logs.some((l) => l.includes("dangerously-skip-permissions"))).toBe(true);
  });

  it("does NOT log the warning when dangerouslySkipPermissions is false", async () => {
    vi.mocked(callOpenRouter).mockResolvedValueOnce(noToolResponse("done"));
    const logs: string[] = [];
    const { opts } = loopOpts({
      dangerouslySkipPermissions: false,
      onLog: (_s, msg) => logs.push(msg),
    });

    await runAgentLoop(opts);

    expect(logs.some((l) => l.includes("dangerously-skip-permissions"))).toBe(false);
  });
});

// ── useFinishTool ─────────────────────────────────────────────────────────────

describe("runAgentLoop — useFinishTool", () => {
  beforeEach(() => vi.clearAllMocks());

  it("breaks the loop when the finish tool is called and uses its result", async () => {
    const finishCall: ToolCall = {
      id: "call-finish",
      type: "function",
      function: { name: "finish", arguments: JSON.stringify({ result: "Task complete: files written" }) },
    };
    // Loop should break after the finish tool — only one call to callOpenRouter
    vi.mocked(callOpenRouter).mockResolvedValueOnce(toolResponse([finishCall]));
    const { opts, emitted } = loopOpts({ useFinishTool: true, maxTurns: 5 });

    await runAgentLoop(opts);

    // Should have called the model only once
    expect(vi.mocked(callOpenRouter)).toHaveBeenCalledTimes(1);
    // Result should be success with the finish tool's result content
    const result = resultEvent(emitted);
    expect(result.subtype).toBe("success");
    expect(result.result).toBe("Task complete: files written");
  });

  it("finish tool is not available when useFinishTool is false (call treated as unknown)", async () => {
    const finishCall: ToolCall = {
      id: "call-finish",
      type: "function",
      function: { name: "finish", arguments: JSON.stringify({ result: "done" }) },
    };
    vi.mocked(callOpenRouter)
      .mockResolvedValueOnce(toolResponse([finishCall]))
      .mockResolvedValueOnce(noToolResponse("model stopped"));
    const { opts, emitted } = loopOpts({ useFinishTool: false });

    await runAgentLoop(opts);

    // finish call should come back as an error tool result (unknown tool)
    const te = toolEvent(emitted);
    expect(te.content[0].is_error).toBe(true);
    expect(te.content[0].content).toContain("Unknown tool");
    // Loop continued to a second turn
    expect(vi.mocked(callOpenRouter)).toHaveBeenCalledTimes(2);
  });
});

// ── maxCostUsd ────────────────────────────────────────────────────────────────

describe("runAgentLoop — maxCostUsd", () => {
  beforeEach(() => vi.clearAllMocks());

  it("emits error_max_cost and stops when accumulated cost exceeds the limit", async () => {
    // 10 prompt tokens * $1.00 + 5 completion tokens * $1.00 = $15 — well over $1 limit
    const expensiveResponse: OpenRouterCallResult = {
      ...toolResponse([bashCall("call-1", "echo hi")]),
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    // Loop returns after cost limit — only one call to callOpenRouter
    vi.mocked(callOpenRouter).mockResolvedValueOnce(expensiveResponse);

    const { opts, emitted } = loopOpts({
      costPerInputToken: 1.0,
      costPerOutputToken: 1.0,
      maxCostUsd: 1.0,   // $1 limit; first turn costs $15
    });

    await runAgentLoop(opts);

    expect(vi.mocked(callOpenRouter)).toHaveBeenCalledTimes(1);
    const result = resultEvent(emitted);
    expect(result.subtype).toBe("error_max_cost");
    expect(result.total_cost_usd).toBeGreaterThan(1.0);
  });

  it("total_cost_usd in result event is non-zero when costs are tracked", async () => {
    vi.mocked(callOpenRouter).mockResolvedValueOnce({
      ...noToolResponse("done"),
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    });

    const { opts, emitted } = loopOpts({
      costPerInputToken: 0.000001,
      costPerOutputToken: 0.000002,
    });

    await runAgentLoop(opts);

    const result = resultEvent(emitted);
    expect(result.total_cost_usd).toBeGreaterThan(0);
    // 100 * 0.000001 + 50 * 0.000002 = 0.0001 + 0.0001 = 0.0002
    expect(result.total_cost_usd).toBeCloseTo(0.0002, 6);
  });
});

// ── Delegated tools (execute: false) ─────────────────────────────────────────

describe("runAgentLoop — delegated tools", () => {
  beforeEach(() => vi.clearAllMocks());

  it("invokes onToolCall for tools with execute:false and uses the returned string as tool result", async () => {
    const delegatedTool: ToolExecutor = {
      definition: {
        type: "function",
        function: {
          name: "my_delegated_tool",
          description: "A delegated tool",
          parameters: { type: "object", properties: { query: { type: "string", description: "" } } },
        },
      },
      execute: false,
    };

    const delegatedCall: ToolCall = {
      id: "call-del",
      type: "function",
      function: { name: "my_delegated_tool", arguments: JSON.stringify({ query: "hello" }) },
    };

    vi.mocked(callOpenRouter)
      .mockResolvedValueOnce(toolResponse([delegatedCall]))
      .mockResolvedValueOnce(noToolResponse("done"));

    const onToolCall = vi.fn().mockResolvedValue("delegated result");

    const { opts, emitted } = loopOpts({
      extraTools: [delegatedTool],
      onToolCall,
    });

    await runAgentLoop(opts);

    expect(onToolCall).toHaveBeenCalledWith("my_delegated_tool", { query: "hello" });
    const te = toolEvent(emitted);
    expect(te.content[0].is_error).toBeFalsy();
    expect(te.content[0].content).toBe("delegated result");
    expect(resultEvent(emitted).subtype).toBe("success");
  });

  it("returns an error tool result when execute:false but no onToolCall is provided", async () => {
    const delegatedTool: ToolExecutor = {
      definition: {
        type: "function",
        function: {
          name: "my_delegated_tool",
          description: "A delegated tool",
          parameters: { type: "object", properties: {} },
        },
      },
      execute: false,
    };

    const delegatedCall: ToolCall = {
      id: "call-del2",
      type: "function",
      function: { name: "my_delegated_tool", arguments: "{}" },
    };

    vi.mocked(callOpenRouter)
      .mockResolvedValueOnce(toolResponse([delegatedCall]))
      .mockResolvedValueOnce(noToolResponse("done"));

    const { opts, emitted } = loopOpts({ extraTools: [delegatedTool] });

    await runAgentLoop(opts);

    const te = toolEvent(emitted);
    expect(te.content[0].is_error).toBe(true);
    expect(te.content[0].content).toContain("no onToolCall handler");
  });
});

// ── onTurnStart ───────────────────────────────────────────────────────────────

describe("runAgentLoop — onTurnStart", () => {
  beforeEach(() => vi.clearAllMocks());

  it("calls onTurnStart with TurnContext before each model call", async () => {
    vi.mocked(callOpenRouter)
      .mockResolvedValueOnce(toolResponse([bashCall("c1", "echo a")]))
      .mockResolvedValueOnce(noToolResponse("done"));

    const contexts: unknown[] = [];
    const { opts } = loopOpts({
      onTurnStart: (ctx) => { contexts.push({ ...ctx }); return {}; },
    });

    await runAgentLoop(opts);

    expect(contexts).toHaveLength(2);
    const first = contexts[0] as { turn: number; model: string; cumulativeCostUsd: number };
    expect(first.turn).toBe(0);
    expect(first.model).toBe("test-model");
    expect(first.cumulativeCostUsd).toBe(0);
  });

  it("merges overrides from onTurnStart into the OpenRouter call options", async () => {
    vi.mocked(callOpenRouter).mockResolvedValueOnce(noToolResponse("done"));

    const { opts } = loopOpts({
      onTurnStart: () => ({ model: "overridden-model", temperature: 0.9 }),
    });

    await runAgentLoop(opts);

    const callOpts = vi.mocked(callOpenRouter).mock.calls[0][0];
    expect(callOpts.model).toBe("overridden-model");
    expect(callOpts.temperature).toBe(0.9);
  });

  it("cumulativeTokens in TurnContext reflects tokens from previous turns", async () => {
    vi.mocked(callOpenRouter)
      .mockResolvedValueOnce({
        ...toolResponse([bashCall("c1", "echo a")]),
        usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
      })
      .mockResolvedValueOnce(noToolResponse("done"));

    const contexts: unknown[] = [];
    const { opts } = loopOpts({
      onTurnStart: (ctx) => { contexts.push({ ...ctx, cumulativeTokens: { ...ctx.cumulativeTokens } }); return {}; },
    });

    await runAgentLoop(opts);

    const second = contexts[1] as { cumulativeTokens: { prompt: number; completion: number } };
    expect(second.cumulativeTokens.prompt).toBe(50);
    expect(second.cumulativeTokens.completion).toBe(20);
  });
});

// ── Parallel tool execution ───────────────────────────────────────────────────

describe("runAgentLoop — parallel_tool_calls", () => {
  beforeEach(() => vi.clearAllMocks());

  it("executes multiple tools and collects all results regardless of parallel flag", async () => {
    const calls: ToolCall[] = [
      bashCall("c1", "echo a"),
      bashCall("c2", "echo b"),
      bashCall("c3", "echo c"),
    ];
    vi.mocked(callOpenRouter)
      .mockResolvedValueOnce(toolResponse(calls))
      .mockResolvedValueOnce(noToolResponse("all done"));
    const { opts, emitted } = loopOpts({ parallel_tool_calls: false });

    await runAgentLoop(opts);

    const te = toolEvent(emitted);
    expect(te.content).toHaveLength(3);
    expect(te.content.map((r) => r.tool_use_id)).toEqual(["c1", "c2", "c3"]);
  });

  it("with parallel_tool_calls=true executes all tools and returns results in order", async () => {
    // Simulate two tools: second resolves before first (concurrent execution)
    let resolveFirst!: () => void;
    const { bashTool } = await import("../src/tools/bash.js");

    let callCount = 0;
    vi.spyOn(bashTool, "execute").mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // First call: wait for a tick before resolving
        await new Promise<void>((res) => { resolveFirst = res; });
        return { toolCallId: "", content: "first", isError: false };
      }
      // Second call resolves immediately, then unblocks first
      resolveFirst();
      return { toolCallId: "", content: "second", isError: false };
    });

    const calls: ToolCall[] = [bashCall("c1", "echo first"), bashCall("c2", "echo second")];
    vi.mocked(callOpenRouter)
      .mockResolvedValueOnce(toolResponse(calls))
      .mockResolvedValueOnce(noToolResponse("done"));
    const { opts, emitted } = loopOpts({ parallel_tool_calls: true });

    await runAgentLoop(opts);

    // Both results present, in original order
    const te = toolEvent(emitted);
    expect(te.content).toHaveLength(2);
    expect(te.content[0].tool_use_id).toBe("c1");
    expect(te.content[1].tool_use_id).toBe("c2");
    // Both tools were actually called
    expect(callCount).toBe(2);
  });
});
