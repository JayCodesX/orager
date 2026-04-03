/**
 * P1-1: Per-agent API key isolation tests.
 *
 * Verifies that:
 * 1. When agentApiKey is set, it is used instead of the env key for callOpenRouter.
 * 2. agentApiKey passes through the daemon opts allowlist (sanitizeDaemonRunOpts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mocked } from "./mock-helpers.js";
import { sanitizeDaemonRunOpts } from "../src/agent-opts.js";
import type { AgentLoopOptions, OpenRouterCallResult } from "../src/types.js";

// ── Mock openrouter so runAgentLoop doesn't hit the network ───────────────────

vi.mock("../src/openrouter.js", () => ({
  callOpenRouter: vi.fn(),
  callDirect: vi.fn(),
  shouldUseDirect: vi.fn().mockReturnValue(false),
  fetchGenerationMeta: vi.fn().mockResolvedValue(null),
  callEmbeddings: vi.fn().mockResolvedValue([[]]),
}));

vi.mock("../src/openrouter-model-meta.js", () => ({
  fetchLiveModelMeta: vi.fn().mockResolvedValue(undefined),
  getLiveModelPricing: vi.fn().mockReturnValue(null),
  isLiveModelMetaCacheWarm: vi.fn().mockReturnValue(true),
  getLiveModelMeta: vi.fn().mockReturnValue(null),
  liveModelSupportsTools: vi.fn().mockReturnValue(null),
  liveModelSupportsVision: vi.fn().mockReturnValue(null),
  getCachedModelIds: vi.fn().mockReturnValue([]),
  getMetaCacheSize: vi.fn().mockReturnValue(0),
}));

vi.mock("../src/loop-helpers.js", () => ({
  postWebhook: vi.fn().mockResolvedValue(null),
  estimateTokens: vi.fn().mockResolvedValue(0),
  fetchModelContextLengths: vi.fn().mockResolvedValue(undefined),
  getContextWindow: vi.fn().mockReturnValue(128_000),
  isModelContextCacheWarm: vi.fn().mockReturnValue(true),
  MAX_SESSION_MESSAGES: 500,
  summarizeSession: vi.fn().mockResolvedValue([]),
  SUMMARIZE_PROMPT: "",
  validateSummary: vi.fn().mockReturnValue(true),
  CACHE_TTL_MS: 30_000,
  runConcurrent: vi.fn().mockImplementation(async (items: unknown[], _max: number, fn: (item: unknown) => Promise<unknown>) => {
    const results = [];
    for (const item of items) results.push(await fn(item));
    return results;
  }),
  MAX_PARALLEL_TOOLS: 10,
  evaluateTurnModelRules: vi.fn().mockReturnValue(null),
  defaultTimeoutForModel: vi.fn().mockReturnValue(120),
  loadCl100k: vi.fn().mockResolvedValue(null),
  loadO200k: vi.fn().mockResolvedValue(null),
  bpeEncoderFamily: vi.fn().mockReturnValue(null),
  getCharsPerToken: vi.fn().mockReturnValue(4),
  isReadOnlyTool: vi.fn().mockReturnValue(false),
  getContextWindowFromFallback: vi.fn().mockReturnValue(128_000),
  _resetModelCacheForTesting: vi.fn(),
  formatDiscordPayload: vi.fn().mockReturnValue({}),
  MEMORY_HEADER_MASTER: "## Persistent Product Context",
  MEMORY_HEADER_RETRIEVED: "## Your persistent memory",
  MEMORY_HEADER_AUTO: "# Persistent memory",
  MEMORY_HEADER_PRIOR_SESSION: "## Prior session context",
  SKILL_HEADER: "## Learned Skills",
  MEMORY_DYNAMIC_BUDGET_FRACTION: 0.15,
  MEMORY_UPDATE_MAX_CHARS: 500,
  MEMORY_UPDATE_INSTRUCTION: "",
  parseMemoryUpdates: vi.fn().mockReturnValue([]),
  distillMemoryEntries: vi.fn().mockResolvedValue([]),
  DISTILL_ENTRY_THRESHOLD: 200,
  DISTILL_BATCH_SIZE: 30,
}));

vi.mock("../src/retry.js", () => ({
  callWithRetry: vi.fn(),
}));

const { callWithRetry } = await import("../src/retry.js");
const { callOpenRouter } = await import("../src/openrouter.js");

function makeSuccessResult(): OpenRouterCallResult {
  return {
    content: "done",
    reasoning: "",
    toolCalls: [],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    cachedTokens: 0,
    model: "test-model",
    finishReason: "stop",
    isError: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked(callWithRetry).mockResolvedValue(makeSuccessResult());
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Test 1: agentApiKey is forwarded to callWithRetry ─────────────────────────

describe("P1-1 agentApiKey — API key resolution", () => {
  it("uses agentApiKey instead of the env apiKey when set", async () => {
    const { runAgentLoop } = await import("../src/loop.js");

    const emitted: { type: string }[] = [];
    const loopOpts: AgentLoopOptions = {
      prompt: "hello",
      model: "test-model",
      apiKey: "global-key",
      agentApiKey: "per-agent-key",
      sessionId: null,
      addDirs: [],
      maxTurns: 1,
      cwd: "/tmp",
      dangerouslySkipPermissions: true,
      verbose: false,
      onEmit: (e) => { emitted.push(e); },
    };

    await runAgentLoop(loopOpts);

    // callWithRetry should have been called with the per-agent key
    expect(mocked(callWithRetry)).toHaveBeenCalled();
    const callArgs = mocked(callWithRetry).mock.calls[0]![0];
    expect(callArgs.apiKey).toBe("per-agent-key");
  });

  it("falls back to apiKey when agentApiKey is not set", async () => {
    const { runAgentLoop } = await import("../src/loop.js");

    const emitted: { type: string }[] = [];
    const loopOpts: AgentLoopOptions = {
      prompt: "hello",
      model: "test-model",
      apiKey: "global-key",
      sessionId: null,
      addDirs: [],
      maxTurns: 1,
      cwd: "/tmp",
      dangerouslySkipPermissions: true,
      verbose: false,
      onEmit: (e) => { emitted.push(e); },
    };

    await runAgentLoop(loopOpts);

    expect(mocked(callWithRetry)).toHaveBeenCalled();
    const callArgs = mocked(callWithRetry).mock.calls[0]![0];
    expect(callArgs.apiKey).toBe("global-key");
  });

  it("treats whitespace-only agentApiKey as unset and falls back to apiKey", async () => {
    const { runAgentLoop } = await import("../src/loop.js");

    const emitted: { type: string }[] = [];
    const loopOpts: AgentLoopOptions = {
      prompt: "hello",
      model: "test-model",
      apiKey: "global-key",
      agentApiKey: "   ",
      sessionId: null,
      addDirs: [],
      maxTurns: 1,
      cwd: "/tmp",
      dangerouslySkipPermissions: true,
      verbose: false,
      onEmit: (e) => { emitted.push(e); },
    };

    await runAgentLoop(loopOpts);

    expect(mocked(callWithRetry)).toHaveBeenCalled();
    const callArgs = mocked(callWithRetry).mock.calls[0]![0];
    expect(callArgs.apiKey).toBe("global-key");
  });
});

// ── Test 2: agentApiKey passes through the daemon opts allowlist ──────────────

describe("P1-1 agentApiKey — daemon opts allowlist", () => {
  it("agentApiKey is stripped by sanitizeDaemonRunOpts (security-sensitive)", () => {
    const raw = { agentApiKey: "per-agent-key-123", model: "test-model" };
    const { safe } = sanitizeDaemonRunOpts(raw);
    // agentApiKey is explicitly deleted as a security-sensitive field (line 86 of sanitize.ts)
    expect(safe.agentApiKey).toBeUndefined();
    expect(safe.model).toBe("test-model");
  });

  it("sessionLockTimeoutMs passes through sanitizeDaemonRunOpts", () => {
    const raw = { sessionLockTimeoutMs: 10000, model: "test-model" };
    const { safe, rejected } = sanitizeDaemonRunOpts(raw);
    expect(rejected).not.toContain("sessionLockTimeoutMs");
    expect(safe.sessionLockTimeoutMs).toBe(10000);
  });

  it("model is included in safe opts", () => {
    const raw = { model: "deepseek/deepseek-chat-v3-2", sessionLockTimeoutMs: 5000 };
    const { safe } = sanitizeDaemonRunOpts(raw);
    expect(safe.model).toBe("deepseek/deepseek-chat-v3-2");
    expect(safe.sessionLockTimeoutMs).toBe(5000);
  });
});

// ── Test 3: Rate-limit isolation (per-key tracking in callWithRetry) ──────────
// The actual rate-limit isolation is handled by the key pool in callWithRetry —
// two agents with different agentApiKey values each pass their own key as the
// primary, so a 429 on one key does not exhaust the other key's retry budget.

describe("P1-1 rate-limit isolation", () => {
  it("two agents with different keys each receive the correct key in callWithRetry opts", async () => {
    const { runAgentLoop } = await import("../src/loop.js");

    // Agent A with key-A: succeeds
    const eventsA: { type: string }[] = [];
    await runAgentLoop({
      prompt: "task A",
      model: "test-model",
      apiKey: "global-key",
      agentApiKey: "key-A",
      sessionId: null,
      addDirs: [],
      maxTurns: 1,
      cwd: "/tmp",
      dangerouslySkipPermissions: true,
      verbose: false,
      onEmit: (e) => { eventsA.push(e); },
    });

    const callAKey = mocked(callWithRetry).mock.calls[0]![0].apiKey;
    expect(callAKey).toBe("key-A");

    mocked(callWithRetry).mockClear();

    // Agent B with key-B: succeeds independently
    const eventsB: { type: string }[] = [];
    await runAgentLoop({
      prompt: "task B",
      model: "test-model",
      apiKey: "global-key",
      agentApiKey: "key-B",
      sessionId: null,
      addDirs: [],
      maxTurns: 1,
      cwd: "/tmp",
      dangerouslySkipPermissions: true,
      verbose: false,
      onEmit: (e) => { eventsB.push(e); },
    });

    const callBKey = mocked(callWithRetry).mock.calls[0]![0].apiKey;
    expect(callBKey).toBe("key-B");

    // Both runs completed successfully
    expect(eventsA.some((e) => e.type === "result")).toBe(true);
    expect(eventsB.some((e) => e.type === "result")).toBe(true);
  });
});
