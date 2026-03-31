/**
 * Tests for the structured session_lost warn event emitted by loop.ts.
 *
 * When a caller passes a sessionId that isn't found on disk, orager starts
 * a fresh session and emits a structured warn event with subtype "session_lost"
 * so adapters can detect it without fragile string-matching on stderr.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mocked } from "./mock-helpers.js";
import { runAgentLoop } from "../src/loop.js";
import type { EmitEvent, EmitWarnEvent, OpenRouterCallResult } from "../src/types.js";

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock("../src/openrouter.js", () => ({
  callOpenRouter: vi.fn(),
  callDirect: vi.fn(),
  shouldUseDirect: vi.fn().mockReturnValue(false),
  fetchGenerationMeta: vi.fn().mockResolvedValue(null),
  callEmbeddings: vi.fn().mockResolvedValue([[]]),
}));

vi.mock("../src/session.js", () => ({
  loadSession: vi.fn(),
  saveSession: vi.fn().mockResolvedValue(undefined),
  newSessionId: vi.fn().mockReturnValue("new-session-id"),
  acquireSessionLock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/audit.js", () => ({ auditApproval: vi.fn(), logToolCall: vi.fn(), logSandboxViolation: vi.fn() }));

const { callOpenRouter } = await import("../src/openrouter.js");
const { loadSession } = await import("../src/session.js");

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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("session_lost warn event", () => {
  beforeEach(() => vi.clearAllMocks());

  it("emits a warn event with subtype session_lost when sessionId is not found", async () => {
    mocked(loadSession).mockResolvedValue(null); // session not found
    mocked(callOpenRouter).mockResolvedValueOnce(noToolResponse("done"));

    const emitted: EmitEvent[] = [];
    await runAgentLoop({
      prompt: "hello",
      model: "test-model",
      apiKey: "test-key",
      sessionId: "stale-session-id",
      addDirs: [],
      maxTurns: 1,
      maxRetries: 0,
      cwd: "/tmp",
      dangerouslySkipPermissions: true,
      verbose: false,
      onEmit: (e) => emitted.push(e),
    });

    const warnEvents = emitted.filter((e): e is EmitWarnEvent => e.type === "warn");
    const sessionLostEvent = warnEvents.find((e) => e.subtype === "session_lost");

    expect(sessionLostEvent).toBeDefined();
    expect(sessionLostEvent?.subtype).toBe("session_lost");
    expect(sessionLostEvent?.session_id).toBe("stale-session-id");
    expect(sessionLostEvent?.message).toContain("stale-session-id");
  });

  it("does not emit session_lost when session is found", async () => {
    mocked(loadSession).mockResolvedValue({
      sessionId: "existing-session",
      model: "test-model",
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      cwd: "/tmp",
      turnCount: 0,
    });
    mocked(callOpenRouter).mockResolvedValueOnce(noToolResponse("done"));

    const emitted: EmitEvent[] = [];
    await runAgentLoop({
      prompt: "hello",
      model: "test-model",
      apiKey: "test-key",
      sessionId: "existing-session",
      addDirs: [],
      maxTurns: 1,
      maxRetries: 0,
      cwd: "/tmp",
      dangerouslySkipPermissions: true,
      verbose: false,
      onEmit: (e) => emitted.push(e),
    });

    const sessionLostEvents = emitted.filter(
      (e): e is EmitWarnEvent => e.type === "warn" && e.subtype === "session_lost",
    );
    expect(sessionLostEvents).toHaveLength(0);
  });

  it("does not emit session_lost when no sessionId is provided (fresh start)", async () => {
    mocked(callOpenRouter).mockResolvedValueOnce(noToolResponse("done"));

    const emitted: EmitEvent[] = [];
    await runAgentLoop({
      prompt: "hello",
      model: "test-model",
      apiKey: "test-key",
      sessionId: null,
      addDirs: [],
      maxTurns: 1,
      maxRetries: 0,
      cwd: "/tmp",
      dangerouslySkipPermissions: true,
      verbose: false,
      onEmit: (e) => emitted.push(e),
    });

    const sessionLostEvents = emitted.filter(
      (e): e is EmitWarnEvent => e.type === "warn" && e.subtype === "session_lost",
    );
    expect(sessionLostEvents).toHaveLength(0);
  });
});
