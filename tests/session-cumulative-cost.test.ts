import { describe, it, expect, vi, beforeEach } from "vitest";
import { mocked } from "./mock-helpers.js";
import { runAgentLoop } from "../src/loop.js";
import type { EmitEvent, EmitResultEvent, OpenRouterCallResult, SessionData } from "../src/types.js";

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
  acquireSessionLock: vi.fn().mockResolvedValue(async () => {}),
}));

vi.mock("../src/audit.js", () => ({ auditApproval: vi.fn(), logToolCall: vi.fn(), logSandboxViolation: vi.fn() }));

const { callOpenRouter } = await import("../src/openrouter.js");
const { saveSession, loadSession, newSessionId } = await import("../src/session.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

function noToolResponse(content = "Done"): OpenRouterCallResult {
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

function loopOpts(overrides: Partial<Parameters<typeof runAgentLoop>[0]> = {}) {
  const emitted: EmitEvent[] = [];
  return {
    opts: {
      prompt: "Do the thing",
      model: "test-model",
      apiKey: "test-key",
      sessionId: null as string | null,
      addDirs: [] as string[],
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("session cumulative cost", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked(newSessionId).mockReturnValue("test-session-id");
    mocked(saveSession).mockResolvedValue(undefined);
    mocked(loadSession).mockResolvedValue(null);
  });

  it("first run accumulates cost and saves cumulativeCostUsd to session", async () => {
    mocked(callOpenRouter).mockResolvedValueOnce({
      ...noToolResponse("done"),
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    });

    const { opts } = loopOpts({
      costPerInputToken: 0.001,
      costPerOutputToken: 0.002,
    });

    await runAgentLoop(opts);

    // Verify saveSession was called with cumulativeCostUsd set
    expect(mocked(saveSession)).toHaveBeenCalled();
    const saved = mocked(saveSession).mock.calls[0][0];
    // 100 * 0.001 + 50 * 0.002 = 0.1 + 0.1 = 0.2
    expect(saved.cumulativeCostUsd).toBeCloseTo(0.2, 6);
  });

  it("second run (resume) starts from saved cumulative cost", async () => {
    // Simulate a session with $0.5 already spent
    const existingSession: SessionData = {
      sessionId: "test-session-id",
      model: "test-model",
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi", tool_calls: undefined },
      ],
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:01:00.000Z",
      turnCount: 1,
      cwd: "/tmp",
      cumulativeCostUsd: 0.5,
    };
    mocked(loadSession).mockResolvedValueOnce(existingSession);

    mocked(callOpenRouter).mockResolvedValueOnce({
      ...noToolResponse("resumed"),
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    });

    const { opts, emitted } = loopOpts({
      sessionId: "test-session-id",
      costPerInputToken: 0.001,
      costPerOutputToken: 0.002,
    });

    await runAgentLoop(opts);

    // The result total_cost_usd should include the prior $0.5 plus the new run's cost
    const result = resultEvent(emitted);
    // 0.5 (prior) + 0.2 (new) = 0.7
    expect(result.total_cost_usd).toBeCloseTo(0.7, 6);

    // And the saved cumulativeCostUsd should be updated
    const saved = mocked(saveSession).mock.calls[0][0];
    expect(saved.cumulativeCostUsd).toBeCloseTo(0.7, 6);
  });

  it("maxCostUsd hard stop fires when cumulative + current cost exceeds the limit", async () => {
    // Prior cost is $0.9 — nearly at the $1.0 limit
    const existingSession: SessionData = {
      sessionId: "test-session-id",
      model: "test-model",
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi", tool_calls: undefined },
      ],
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:01:00.000Z",
      turnCount: 1,
      cwd: "/tmp",
      cumulativeCostUsd: 0.9,
    };
    mocked(loadSession).mockResolvedValueOnce(existingSession);

    // The turn costs 0.2, pushing total to 1.1 > 1.0 limit.
    // Use a tool response so the loop continues past the "break on no tools" point
    // and reaches the cost check (which fires after tool execution).
    mocked(callOpenRouter).mockResolvedValueOnce({
      content: "",
      reasoning: "",
      toolCalls: [{ id: "tc-1", type: "function" as const, function: { name: "bash", arguments: JSON.stringify({ command: "echo hi" }) } }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      cachedTokens: 0,
      model: "test-model",
      finishReason: "tool_calls",
      isError: false,
    });

    const { opts, emitted } = loopOpts({
      sessionId: "test-session-id",
      costPerInputToken: 0.001,
      costPerOutputToken: 0.002,
      maxCostUsd: 1.0,
      dangerouslySkipPermissions: true, // allow bash tool to run without approval
    });

    await runAgentLoop(opts);

    const result = resultEvent(emitted);
    expect(result.subtype).toBe("error_max_cost");
    expect(result.total_cost_usd).toBeGreaterThan(1.0);
  });

  it("missing cumulativeCostUsd in old session data defaults to 0", async () => {
    // Old session data without cumulativeCostUsd field
    const oldSession: SessionData = {
      sessionId: "test-session-id",
      model: "test-model",
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi", tool_calls: undefined },
      ],
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:01:00.000Z",
      turnCount: 1,
      cwd: "/tmp",
      // no cumulativeCostUsd
    };
    mocked(loadSession).mockResolvedValueOnce(oldSession);

    mocked(callOpenRouter).mockResolvedValueOnce({
      ...noToolResponse("legacy"),
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    });

    const { opts, emitted } = loopOpts({
      sessionId: "test-session-id",
      costPerInputToken: 0.001,
      costPerOutputToken: 0.002,
    });

    await runAgentLoop(opts);

    // Starting from 0 (no prior cost) + 0.2 (new run) = 0.2
    const result = resultEvent(emitted);
    expect(result.total_cost_usd).toBeCloseTo(0.2, 6);
  });
});
