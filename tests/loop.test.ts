import { describe, it, expect, vi, beforeEach } from "vitest";
import { mocked } from "./mock-helpers.js";
import { runAgentLoop } from "../src/loop.js";
import type { EmitEvent, EmitResultEvent, EmitToolEvent, OpenRouterCallResult, ToolCall, ToolExecutor } from "../src/types.js";

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

vi.mock("../src/audit.js", () => ({ auditApproval: vi.fn(), logToolCall: vi.fn(), logSandboxViolation: vi.fn() }));

// Import mocked functions after vi.mock declarations (vitest hoists vi.mock)
const { callOpenRouter } = await import("../src/openrouter.js");
const { saveSession, loadSession, newSessionId } = await import("../src/session.js");
const { auditApproval } = await import("../src/audit.js");

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
      // Disable SQLite memory in unit tests — avoids WASM DB I/O that can leave
      // the WASM module in a bad state in bun's shared test process.
      // Memory behaviour is tested separately in phase6-distillation.test.ts.
      memory: false,
      // Disable summarization triggers in unit tests — summarization behaviour is
      // tested separately. Without this, the new defaults (summarizeTurnInterval=6,
      // summarizeAt=0.70) would fire during multi-turn tests and skew call counts.
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
    mocked(callOpenRouter).mockResolvedValueOnce(noToolResponse("All done"));
    const { opts, emitted } = loopOpts();

    await runAgentLoop(opts);

    expect(emitted[0]).toMatchObject({ type: "system", subtype: "init" });
    expect(emitted[1]).toMatchObject({ type: "assistant" });
    expect(resultEvent(emitted)).toMatchObject({ type: "result", subtype: "success", result: "All done" });
  });

  it("emits result with accumulated usage", async () => {
    mocked(callOpenRouter).mockResolvedValueOnce({
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
    mocked(callOpenRouter).mockResolvedValueOnce({
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
    mocked(callOpenRouter)
      .mockResolvedValueOnce(toolResponse([bashCall("call-1", "echo hello")]))
      .mockResolvedValueOnce(noToolResponse("done"));
    const { opts, emitted } = loopOpts();

    await runAgentLoop(opts);

    expect(mocked(callOpenRouter)).toHaveBeenCalledTimes(2);
    // Second call's messages should include a tool result
    const secondCallMessages = mocked(callOpenRouter).mock.calls[1][0].messages;
    expect(secondCallMessages.some((m: { role: string }) => m.role === "tool")).toBe(true);
    expect(resultEvent(emitted).subtype).toBe("success");
  });

  it("emits tool event with each tool result", async () => {
    mocked(callOpenRouter)
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
    mocked(callOpenRouter)
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
    mocked(callOpenRouter).mockResolvedValue(toolResponse([bashCall("call-1", "echo hi")]));
    const { opts, emitted } = loopOpts({ maxTurns: 2 });

    await runAgentLoop(opts);

    expect(resultEvent(emitted).subtype).toBe("error_max_turns");
    expect(mocked(callOpenRouter)).toHaveBeenCalledTimes(2);
  });

  // ── Unknown tool ───────────────────────────────────────────────────────────

  it("handles unknown tool name as error tool result and continues loop", async () => {
    const unknownCall: ToolCall = {
      id: "call-x",
      type: "function",
      function: { name: "nonexistent_tool", arguments: "{}" },
    };
    mocked(callOpenRouter)
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
    mocked(callOpenRouter)
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

    mocked(callOpenRouter)
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
    mocked(callOpenRouter).mockResolvedValueOnce(errorResponse("Rate limit exceeded"));
    const { opts, emitted } = loopOpts();

    await runAgentLoop(opts);

    const result = resultEvent(emitted);
    expect(result.subtype).toBe("error");
    expect(result.result).toContain("Rate limit exceeded");
  });

  it("callOpenRouter rejection exits loop with result:error", async () => {
    mocked(callOpenRouter).mockRejectedValueOnce(new Error("Network error"));
    const { opts, emitted } = loopOpts();

    await runAgentLoop(opts);

    expect(resultEvent(emitted).subtype).toBe("error");
    expect(resultEvent(emitted).result).toContain("Network error");
  });

  // ── Session persistence ────────────────────────────────────────────────────

  it("saves session after successful run", async () => {
    mocked(callOpenRouter).mockResolvedValueOnce(noToolResponse());
    const { opts } = loopOpts();

    await runAgentLoop(opts);

    expect(mocked(saveSession)).toHaveBeenCalledOnce();
    const saved = mocked(saveSession).mock.calls[0][0];
    expect(saved.sessionId).toBe("test-session-id");
    expect(saved.cwd).toBe("/tmp");
  });

  it("saves session (best-effort) after error", async () => {
    mocked(callOpenRouter).mockRejectedValueOnce(new Error("Boom"));
    const { opts } = loopOpts();

    await runAgentLoop(opts);

    expect(mocked(saveSession)).toHaveBeenCalledOnce();
  });

  it("does not throw even if session save fails", async () => {
    mocked(callOpenRouter).mockResolvedValueOnce(noToolResponse());
    mocked(saveSession).mockRejectedValueOnce(new Error("Disk full"));
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
    mocked(callOpenRouter)
      .mockResolvedValueOnce(toolResponse([bashCall("c1", "echo a")]))
      .mockResolvedValueOnce(toolResponse([bashCall("c2", "echo b")]))
      .mockResolvedValueOnce(noToolResponse("done after 2 turns"));
    const { opts, emitted } = loopOpts({ maxTurns: 0 });

    await runAgentLoop(opts);

    expect(resultEvent(emitted).subtype).toBe("success");
    expect(mocked(callOpenRouter)).toHaveBeenCalledTimes(3);
  });

  it("never stops on its own when the model keeps calling tools (verified via call count cap)", async () => {
    // Always returns a tool call — with maxTurns=0 the loop would run forever,
    // so we limit via mockResolvedValue cycling and verify it ran >5 turns.
    let calls = 0;
    mocked(callOpenRouter).mockImplementation(async () => {
      calls++;
      if (calls >= 7) return noToolResponse("stopped");
      return toolResponse([bashCall(`c${calls}`, "echo hi")]);
    });
    const { opts, emitted } = loopOpts({ maxTurns: 0 });

    await runAgentLoop(opts);

    expect(calls).toBe(7); // 7 agent turns (memory disabled in unit tests — no synthesis call)
    expect(resultEvent(emitted).subtype).toBe("success");
  });
});

// ── Force resume ─────────────────────────────────────────────────────────────

describe("runAgentLoop — --force-resume", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects resume without --force-resume when cwd differs", async () => {
    mocked(loadSession).mockResolvedValueOnce({
      sessionId: "sess-old",
      model: "test-model",
      messages: [{ role: "user", content: "prev prompt" }],
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      turnCount: 1,
      cwd: "/other/dir",   // different from /tmp used in opts
    });
    mocked(callOpenRouter).mockResolvedValueOnce(noToolResponse("fresh"));
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
    const callMessages = mocked(callOpenRouter).mock.calls[0][0].messages;
    expect(callMessages.some((m: { content: string }) => m.content === "prev prompt")).toBe(false);
  });

  it("resumes session with --force-resume even when cwd differs", async () => {
    mocked(loadSession).mockResolvedValueOnce({
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
    mocked(callOpenRouter).mockResolvedValueOnce(noToolResponse("continued"));
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
    const callMessages = mocked(callOpenRouter).mock.calls[0][0].messages;
    expect(callMessages.some((m: { content: string }) => m.content === "prev answer")).toBe(true);
  });
});

// ── dangerouslySkipPermissions warning ───────────────────────────────────────

describe("runAgentLoop — dangerouslySkipPermissions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("logs a stderr warning when dangerouslySkipPermissions is true", async () => {
    mocked(callOpenRouter).mockResolvedValueOnce(noToolResponse("done"));
    const logs: string[] = [];
    const { opts } = loopOpts({
      dangerouslySkipPermissions: true,
      onLog: (_s, msg) => logs.push(msg),
    });

    await runAgentLoop(opts);

    expect(logs.some((l) => l.includes("dangerously-skip-permissions"))).toBe(true);
  });

  it("does NOT log the warning when dangerouslySkipPermissions is false", async () => {
    mocked(callOpenRouter).mockResolvedValueOnce(noToolResponse("done"));
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
    mocked(callOpenRouter).mockResolvedValueOnce(toolResponse([finishCall]));
    const { opts, emitted } = loopOpts({ useFinishTool: true, maxTurns: 5 });

    await runAgentLoop(opts);

    // Should have called the model only once
    expect(mocked(callOpenRouter)).toHaveBeenCalledTimes(1);
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
    mocked(callOpenRouter)
      .mockResolvedValueOnce(toolResponse([finishCall]))
      .mockResolvedValueOnce(noToolResponse("model stopped"));
    const { opts, emitted } = loopOpts({ useFinishTool: false });

    await runAgentLoop(opts);

    // finish call should come back as an error tool result (unknown tool)
    const te = toolEvent(emitted);
    expect(te.content[0].is_error).toBe(true);
    expect(te.content[0].content).toContain("Unknown tool");
    // Loop continued to a second turn
    expect(mocked(callOpenRouter)).toHaveBeenCalledTimes(2);
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
    mocked(callOpenRouter).mockResolvedValueOnce(expensiveResponse);

    const { opts, emitted } = loopOpts({
      costPerInputToken: 1.0,
      costPerOutputToken: 1.0,
      maxCostUsd: 1.0,   // $1 limit; first turn costs $15
    });

    await runAgentLoop(opts);

    expect(mocked(callOpenRouter)).toHaveBeenCalledTimes(1);
    const result = resultEvent(emitted);
    expect(result.subtype).toBe("error_max_cost");
    expect(result.total_cost_usd).toBeGreaterThan(1.0);
  });

  it("total_cost_usd in result event is non-zero when costs are tracked", async () => {
    mocked(callOpenRouter).mockResolvedValueOnce({
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

// ── maxCostUsdSoft ────────────────────────────────────────────────────────────

describe("runAgentLoop — maxCostUsdSoft", () => {
  beforeEach(() => vi.clearAllMocks());

  it("breaks the loop early (success) when soft cost limit is hit", async () => {
    // Turn 1 costs $5 (10 tokens * $0.5 each). Soft limit = $1 → trips after turn 1.
    const turn1: OpenRouterCallResult = {
      ...toolResponse([bashCall("c1", "echo a")]),
      usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
    };
    mocked(callOpenRouter).mockResolvedValueOnce(turn1);

    const { opts, emitted } = loopOpts({
      costPerInputToken: 0.5,
      costPerOutputToken: 0.5,
      maxCostUsdSoft: 1.0, // $1 soft limit
      maxTurns: 10,
    });

    await runAgentLoop(opts);

    // Soft limit exits via break — loop finishes with success subtype, not error_max_cost
    expect(mocked(callOpenRouter)).toHaveBeenCalledTimes(1);
    const result = resultEvent(emitted);
    expect(result.subtype).toBe("success"); // soft limit does NOT use error_max_cost
    expect(result.total_cost_usd).toBeGreaterThanOrEqual(1.0);
  });

  it("soft limit does not trigger when cost is below the threshold", async () => {
    // Three cheap turns ($0.0001 total); soft limit = $1 → never trips
    mocked(callOpenRouter)
      .mockResolvedValueOnce(toolResponse([bashCall("c1", "echo a")]))
      .mockResolvedValueOnce(toolResponse([bashCall("c2", "echo b")]))
      .mockResolvedValueOnce(noToolResponse("done"));

    const { opts, emitted } = loopOpts({
      costPerInputToken: 0.000001,
      costPerOutputToken: 0.000001,
      maxCostUsdSoft: 1.0,
    });

    await runAgentLoop(opts);

    expect(mocked(callOpenRouter)).toHaveBeenCalledTimes(3);
    expect(resultEvent(emitted).subtype).toBe("success");
  });

  it("soft limit takes precedence over hard limit when cost is between the two", async () => {
    // Cost = $5; soft = $1, hard = $10 → soft trips first, exits with success
    const costlyResponse: OpenRouterCallResult = {
      ...toolResponse([bashCall("c1", "echo a")]),
      usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
    };
    mocked(callOpenRouter).mockResolvedValueOnce(costlyResponse);

    const { opts, emitted } = loopOpts({
      costPerInputToken: 0.5,
      costPerOutputToken: 0.5,
      maxCostUsdSoft: 1.0,  // trips first
      maxCostUsd: 10.0,     // would use error_max_cost — should not be reached
    });

    await runAgentLoop(opts);

    const result = resultEvent(emitted);
    expect(result.subtype).toBe("success"); // soft limit, not hard
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

    mocked(callOpenRouter)
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

    mocked(callOpenRouter)
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
    mocked(callOpenRouter)
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
    mocked(callOpenRouter).mockResolvedValueOnce(noToolResponse("done"));

    const { opts } = loopOpts({
      onTurnStart: () => ({ model: "overridden-model", temperature: 0.9 }),
    });

    await runAgentLoop(opts);

    const callOpts = mocked(callOpenRouter).mock.calls[0][0];
    expect(callOpts.model).toBe("overridden-model");
    expect(callOpts.temperature).toBe(0.9);
  });

  it("cumulativeTokens in TurnContext reflects tokens from previous turns", async () => {
    mocked(callOpenRouter)
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
    mocked(callOpenRouter)
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
    mocked(callOpenRouter)
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

// ── Shared reset helper for new describe blocks ───────────────────────────────
// vi.clearAllMocks() only clears call counts — it does NOT flush the
// mockResolvedValueOnce queue. Use vi.resetAllMocks() + re-setup so that
// leftover queued values from previous tests can't bleed into the next test.
function resetMocks() {
  vi.resetAllMocks();
  mocked(loadSession).mockResolvedValue(null);
  mocked(saveSession).mockResolvedValue(undefined);
  mocked(newSessionId).mockReturnValue("test-session-id");
}

// ── toolErrorBudgetHardStop ───────────────────────────────────────────────────

describe("runAgentLoop — toolErrorBudgetHardStop", () => {
  beforeEach(resetMocks);

  it("emits error_tool_budget after 5 consecutive tool errors when hardStop=true", async () => {
    const erroringTool: ToolExecutor = {
      definition: {
        type: "function",
        function: {
          name: "my_error_tool",
          description: "Always errors",
          parameters: { type: "object", properties: {} },
        },
      },
      async execute() {
        return { toolCallId: "", content: "always fails", isError: true };
      },
    };

    const toolCall: ToolCall = {
      id: "call-err",
      type: "function",
      function: { name: "my_error_tool", arguments: "{}" },
    };

    // Return the failing tool call 5 times (TOOL_ERROR_BUDGET = 5).
    // Only 5 mocks — the hard stop fires before a 6th call is made.
    mocked(callOpenRouter)
      .mockResolvedValueOnce(toolResponse([{ ...toolCall, id: "e1" }]))
      .mockResolvedValueOnce(toolResponse([{ ...toolCall, id: "e2" }]))
      .mockResolvedValueOnce(toolResponse([{ ...toolCall, id: "e3" }]))
      .mockResolvedValueOnce(toolResponse([{ ...toolCall, id: "e4" }]))
      .mockResolvedValueOnce(toolResponse([{ ...toolCall, id: "e5" }]));

    const { opts, emitted } = loopOpts({
      extraTools: [erroringTool],
      toolErrorBudgetHardStop: true,
      maxTurns: 20,
    });

    await runAgentLoop(opts);

    const result = resultEvent(emitted);
    expect(result.subtype).toBe("error_tool_budget");
    expect(result.result).toContain("my_error_tool");
    // Should have stopped after the 5th error (5 model calls)
    expect(mocked(callOpenRouter)).toHaveBeenCalledTimes(5);
  });

  it("does NOT hard stop (only warns) when toolErrorBudgetHardStop is false (default)", async () => {
    const erroringTool: ToolExecutor = {
      definition: {
        type: "function",
        function: {
          name: "soft_error_tool",
          description: "Always errors",
          parameters: { type: "object", properties: {} },
        },
      },
      async execute() {
        return { toolCallId: "", content: "soft fail", isError: true };
      },
    };

    const toolCall: ToolCall = {
      id: "call-soft",
      type: "function",
      function: { name: "soft_error_tool", arguments: "{}" },
    };

    // 5 error turns followed by a success — budget warning resets, loop continues
    const logs: string[] = [];
    mocked(callOpenRouter)
      .mockResolvedValueOnce(toolResponse([{ ...toolCall, id: "s1" }]))
      .mockResolvedValueOnce(toolResponse([{ ...toolCall, id: "s2" }]))
      .mockResolvedValueOnce(toolResponse([{ ...toolCall, id: "s3" }]))
      .mockResolvedValueOnce(toolResponse([{ ...toolCall, id: "s4" }]))
      .mockResolvedValueOnce(toolResponse([{ ...toolCall, id: "s5" }]))
      .mockResolvedValueOnce(noToolResponse("recovered"));

    const { opts, emitted } = loopOpts({
      extraTools: [erroringTool],
      toolErrorBudgetHardStop: false,
      maxTurns: 20,
      onLog: (_s, msg) => logs.push(msg),
    });

    await runAgentLoop(opts);

    // Should complete successfully (no hard stop)
    expect(resultEvent(emitted).subtype).toBe("success");
    // Should have logged a warning
    expect(logs.some((l) => l.includes("WARNING: tool") && l.includes("soft_error_tool"))).toBe(true);
  });
});

// ── _parentSessionIds spawn-cycle detection ───────────────────────────────────

describe("runAgentLoop — _parentSessionIds spawn-cycle detection", () => {
  beforeEach(resetMocks);

  it("aborts run and logs error when sessionId is in _parentSessionIds", async () => {
    const logs: string[] = [];
    const { opts, emitted } = loopOpts({
      sessionId: "sess-cycle-123",
      _parentSessionIds: ["sess-cycle-123"],
      onLog: (_s, msg) => logs.push(msg),
    });

    await runAgentLoop(opts);

    // Should log the cycle detection error
    expect(logs.some((l) => l.includes("spawn cycle detected"))).toBe(true);
    // Should NOT have called the LLM (returns before the loop)
    expect(mocked(callOpenRouter)).not.toHaveBeenCalled();
    // No result event emitted
    expect(resultEvent(emitted)).toBeUndefined();
  });

  it("does NOT abort when sessionId is NOT in _parentSessionIds", async () => {
    mocked(callOpenRouter).mockResolvedValueOnce(noToolResponse("done"));
    const { opts, emitted } = loopOpts({
      sessionId: null,
      _parentSessionIds: ["some-other-session"],
    });

    await runAgentLoop(opts);

    expect(resultEvent(emitted).subtype).toBe("success");
    expect(mocked(callOpenRouter)).toHaveBeenCalledTimes(1);
  });
});

// ── extraTools name validation ────────────────────────────────────────────────

describe("runAgentLoop — extraTools name validation", () => {
  beforeEach(resetMocks);

  it("warns when an extraTool name contains invalid characters", async () => {
    const badTool: ToolExecutor = {
      definition: {
        type: "function",
        function: {
          name: "my invalid tool!",
          description: "Has spaces and exclamation",
          parameters: { type: "object", properties: {} },
        },
      },
      execute: false,
    };

    const logs: string[] = [];
    mocked(callOpenRouter).mockResolvedValueOnce(noToolResponse("done"));
    const { opts } = loopOpts({
      extraTools: [badTool],
      onLog: (_s, msg) => logs.push(msg),
    });

    await runAgentLoop(opts);

    expect(logs.some((l) => l.includes("invalid characters") && l.includes("my invalid tool!"))).toBe(true);
  });

  it("does NOT warn for valid extraTool names", async () => {
    const validTool: ToolExecutor = {
      definition: {
        type: "function",
        function: {
          name: "my_valid-tool123",
          description: "Valid name",
          parameters: { type: "object", properties: {} },
        },
      },
      execute: false,
    };

    const logs: string[] = [];
    mocked(callOpenRouter).mockResolvedValueOnce(noToolResponse("done"));
    const { opts } = loopOpts({
      extraTools: [validTool],
      onLog: (_s, msg) => logs.push(msg),
    });

    await runAgentLoop(opts);

    expect(logs.some((l) => l.includes("invalid characters"))).toBe(false);
  });
});

// ── Loop detection escalation ─────────────────────────────────────────────────

describe("runAgentLoop — loop detection escalation", () => {
  beforeEach(resetMocks);

  it("injects a stuck warning when identical tool calls repeat beyond maxIdenticalToolCallTurns", async () => {
    // Same tool call every turn, 4 turns then a final text response
    const repeatCall = bashCall("c1", "echo stuck");
    mocked(callOpenRouter)
      .mockResolvedValueOnce(toolResponse([repeatCall]))
      .mockResolvedValueOnce(toolResponse([repeatCall]))
      .mockResolvedValueOnce(toolResponse([repeatCall]))  // streak hits 3 = maxIdenticalTurns
      .mockResolvedValueOnce(noToolResponse("finally done"));

    const logs: string[] = [];
    const { opts, emitted } = loopOpts({
      maxIdenticalToolCallTurns: 3,
      maxTurns: 10,
      onLog: (_s, msg) => logs.push(msg),
    });

    await runAgentLoop(opts);

    expect(resultEvent(emitted).subtype).toBe("success");
    expect(logs.some((l) => l.includes("loop detected"))).toBe(true);
  });

  it("emits 3 loop-detected warnings then aborts — streak does not reset between warnings", async () => {
    // 5 identical turns at threshold=3: warning fires on turns 3, 4, 5.
    // After the 3rd warning (stuckAttempt=3) Fix #2 breaks the loop with error_loop_abort.
    // The 6th call (noToolResponse) is never reached.
    const repeatCall = bashCall("c1", "echo loop");
    mocked(callOpenRouter)
      .mockResolvedValueOnce(toolResponse([repeatCall]))
      .mockResolvedValueOnce(toolResponse([repeatCall]))
      .mockResolvedValueOnce(toolResponse([repeatCall]))  // first warning (streak=3)
      .mockResolvedValueOnce(toolResponse([repeatCall]))  // second warning
      .mockResolvedValueOnce(toolResponse([repeatCall])); // third warning → abort

    const logs: string[] = [];
    const { opts, emitted } = loopOpts({
      maxIdenticalToolCallTurns: 3,
      maxTurns: 20,
      dangerouslySkipPermissions: true,
      onLog: (_s, msg) => logs.push(msg),
    });

    await runAgentLoop(opts);

    // Loop aborts after 3 warnings
    expect(resultEvent(emitted).subtype).toBe("error_loop_abort");
    // "loop detected" appears for each of the 3 warning injections
    const loopWarnings = logs.filter((l) => l.includes("loop detected"));
    expect(loopWarnings.length).toBeGreaterThanOrEqual(3);
  });

  it("emits error_loop_abort subtype after 3 stuck warnings without resolution", async () => {
    // The LLM always returns the same tool call — never escapes. The loop should
    // break after stuckAttempt reaches 3 and emit error_loop_abort.
    const repeatCall = bashCall("stuck-id", "echo stuck forever");
    mocked(callOpenRouter).mockResolvedValue(toolResponse([repeatCall]));

    const logs: string[] = [];
    const { opts, emitted } = loopOpts({
      maxIdenticalToolCallTurns: 3,
      maxTurns: 20,
      dangerouslySkipPermissions: true,
      onLog: (_s, msg) => logs.push(msg),
    });

    await runAgentLoop(opts);

    // Must emit error_loop_abort, not success or error_max_turns
    expect(resultEvent(emitted).subtype).toBe("error_loop_abort");
    // loop_abort warning must have been logged
    expect(logs.some((l) => l.includes("loop_abort"))).toBe(true);
  });
});

// ── Delegated tool audit trail ────────────────────────────────────────────────

describe("runAgentLoop — delegated tool audit trail", () => {
  beforeEach(resetMocks);

  it("calls auditApproval with decision:delegated when a delegated tool is invoked", async () => {
    const delegatedTool: ToolExecutor = {
      definition: {
        type: "function",
        function: {
          name: "my_audited_tool",
          description: "Delegated tool",
          parameters: { type: "object", properties: { query: { type: "string", description: "" } } },
        },
      },
      execute: false,
    };

    const delegatedCall: ToolCall = {
      id: "call-audit",
      type: "function",
      function: { name: "my_audited_tool", arguments: JSON.stringify({ query: "test" }) },
    };

    mocked(callOpenRouter)
      .mockResolvedValueOnce(toolResponse([delegatedCall]))
      .mockResolvedValueOnce(noToolResponse("done"));

    const { opts } = loopOpts({
      extraTools: [delegatedTool],
      onToolCall: vi.fn().mockResolvedValue("audit result"),
    });

    await runAgentLoop(opts);

    expect(mocked(auditApproval)).toHaveBeenCalledOnce();
    const call = mocked(auditApproval).mock.calls[0][0];
    expect(call.toolName).toBe("my_audited_tool");
    expect(call.decision).toBe("delegated");
    expect(call.mode).toBe("delegated");
  });

  it("does NOT call auditApproval for normal (non-delegated) tool calls", async () => {
    mocked(callOpenRouter)
      .mockResolvedValueOnce(toolResponse([bashCall("c1", "echo hi")]))
      .mockResolvedValueOnce(noToolResponse("done"));

    const { opts } = loopOpts();

    await runAgentLoop(opts);

    expect(mocked(auditApproval)).not.toHaveBeenCalled();
  });
});

// ── JSON healing ──────────────────────────────────────────────────────────────

describe("runAgentLoop — JSON healing", () => {
  beforeEach(resetMocks);

  it("injects a healing message when response_format is json_object and response is not valid JSON", async () => {
    // Turn 1: invalid JSON
    // Turn 2: valid JSON (healing succeeded)
    mocked(callOpenRouter)
      .mockResolvedValueOnce(noToolResponse("this is not { valid json"))
      .mockResolvedValueOnce(noToolResponse('{"result": "ok"}'));

    const logs: string[] = [];
    const { opts, emitted } = loopOpts({
      response_format: { type: "json_object" },
      onLog: (_s, msg) => logs.push(msg),
    });

    await runAgentLoop(opts);

    expect(resultEvent(emitted).subtype).toBe("success");
    expect(logs.some((l) => l.includes("JSON healing"))).toBe(true);
    // Two API calls: original + healing retry
    expect(mocked(callOpenRouter)).toHaveBeenCalledTimes(2);
  });

  it("does not inject a healing message when response is valid JSON", async () => {
    mocked(callOpenRouter).mockResolvedValueOnce(noToolResponse('{"answer": 42}'));

    const logs: string[] = [];
    const { opts, emitted } = loopOpts({
      response_format: { type: "json_object" },
      onLog: (_s, msg) => logs.push(msg),
    });

    await runAgentLoop(opts);

    expect(resultEvent(emitted).subtype).toBe("success");
    expect(logs.some((l) => l.includes("JSON healing"))).toBe(false);
    expect(mocked(callOpenRouter)).toHaveBeenCalledTimes(1);
  });

  it("caps healing at one attempt (does not heal infinitely)", async () => {
    // All three turns return invalid JSON — should only heal once then stop
    mocked(callOpenRouter)
      .mockResolvedValueOnce(noToolResponse("bad json 1"))
      .mockResolvedValueOnce(noToolResponse("bad json 2"))  // still invalid after heal
      .mockResolvedValueOnce(noToolResponse("bad json 3"));

    const logs: string[] = [];
    const { opts, emitted } = loopOpts({
      response_format: { type: "json_object" },
      maxTurns: 5,
      onLog: (_s, msg) => logs.push(msg),
    });

    await runAgentLoop(opts);

    // Healing logged exactly once
    const healingLogs = logs.filter((l) => l.includes("JSON healing"));
    expect(healingLogs).toHaveLength(1);
    // Loop eventually exits (max_turns or success path)
    expect(resultEvent(emitted)).toBeDefined();
  });

  it("does not heal when response_format is not set", async () => {
    mocked(callOpenRouter).mockResolvedValueOnce(noToolResponse("plain text response"));

    const logs: string[] = [];
    const { opts } = loopOpts({ onLog: (_s, msg) => logs.push(msg) });

    await runAgentLoop(opts);

    expect(logs.some((l) => l.includes("JSON healing"))).toBe(false);
  });
});
