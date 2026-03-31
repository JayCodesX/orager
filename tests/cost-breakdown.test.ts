/**
 * Sprint 4-C: per-session cost breakdown in result events.
 *
 * Verifies that runAgentLoop populates cost_breakdown.input_usd and
 * cost_breakdown.output_usd on the result event when per-token pricing is
 * available, and omits the field when no pricing is configured.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mocked } from "./mock-helpers.js";
import { runAgentLoop } from "../src/loop.js";
import type { EmitEvent, EmitResultEvent, OpenRouterCallResult, ToolCall } from "../src/types.js";

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
  newSessionId: vi.fn().mockReturnValue("cost-session-id"),
}));

vi.mock("../src/audit.js", () => ({ auditApproval: vi.fn(), logToolCall: vi.fn(), logSandboxViolation: vi.fn() }));

const { callOpenRouter } = await import("../src/openrouter.js");

function response(promptTokens: number, completionTokens: number): OpenRouterCallResult {
  return {
    content: "done",
    reasoning: "",
    toolCalls: [],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
    cachedTokens: 0,
    cacheWriteTokens: 0,
    model: "test-model",
    finishReason: "stop",
    isError: false,
  };
}

function toolCallResponse(toolCalls: ToolCall[], promptTokens: number, completionTokens: number): OpenRouterCallResult {
  return {
    content: "",
    reasoning: "",
    toolCalls,
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
    cachedTokens: 0,
    cacheWriteTokens: 0,
    model: "test-model",
    finishReason: "tool_calls",
    isError: false,
  };
}

function readFileCall(id: string): ToolCall {
  return { id, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "/tmp/test.txt" }) } };
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

function resultEvent(emitted: EmitEvent[]): EmitResultEvent {
  return emitted.find((e) => e.type === "result") as EmitResultEvent;
}

describe("cost_breakdown in result event (4-C)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("cost_breakdown is populated when costPerInputToken and costPerOutputToken are set", async () => {
    mocked(callOpenRouter).mockResolvedValueOnce(response(1000, 500));

    const { opts, emitted } = loopOpts({
      costPerInputToken: 0.000001,   // $1 per million input tokens
      costPerOutputToken: 0.000002,  // $2 per million output tokens
    });
    await runAgentLoop(opts);

    const result = resultEvent(emitted);
    expect(result.cost_breakdown).toBeDefined();
    // input: 1000 * 0.000001 = 0.001
    expect(result.cost_breakdown!.input_usd).toBeCloseTo(0.001, 6);
    // output: 500 * 0.000002 = 0.001
    expect(result.cost_breakdown!.output_usd).toBeCloseTo(0.001, 6);
  });

  it("total_cost_usd equals input_usd + output_usd when only token-based pricing is used", async () => {
    mocked(callOpenRouter).mockResolvedValueOnce(response(800, 200));

    const { opts, emitted } = loopOpts({
      costPerInputToken: 0.000003,
      costPerOutputToken: 0.000015,
    });
    await runAgentLoop(opts);

    const result = resultEvent(emitted);
    const breakdown = result.cost_breakdown!;
    expect(breakdown).toBeDefined();
    expect(result.total_cost_usd).toBeCloseTo(breakdown.input_usd + breakdown.output_usd, 8);
  });

  it("cost_breakdown is undefined when no pricing is configured", async () => {
    mocked(callOpenRouter).mockResolvedValueOnce(response(1000, 500));

    const { opts, emitted } = loopOpts();
    // No costPerInputToken / costPerOutputToken, no live pricing (model unknown)
    await runAgentLoop(opts);

    const result = resultEvent(emitted);
    expect(result.cost_breakdown).toBeUndefined();
  });

  it("cost_breakdown accumulates across multiple turns", async () => {
    mocked(callOpenRouter)
      // Turn 1: read_file tool call (500 prompt, 100 completion)
      .mockResolvedValueOnce(toolCallResponse([readFileCall("tc1")], 500, 100))
      // Turn 2: finish (300 prompt, 200 completion)
      .mockResolvedValueOnce(response(300, 200));

    const { opts, emitted } = loopOpts({
      maxTurns: 5,
      dangerouslySkipPermissions: true,
      costPerInputToken: 0.000001,
      costPerOutputToken: 0.000002,
    });
    await runAgentLoop(opts);

    const result = resultEvent(emitted);
    expect(result.cost_breakdown).toBeDefined();
    // input: (500 + 300) * 0.000001 = 0.0008
    expect(result.cost_breakdown!.input_usd).toBeCloseTo(0.0008, 6);
    // output: (100 + 200) * 0.000002 = 0.0006
    expect(result.cost_breakdown!.output_usd).toBeCloseTo(0.0006, 6);
  });
});
