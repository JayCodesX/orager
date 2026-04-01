import type {
  AgentLoopOptions,
  AssistantMessage,
  EmitResultEvent,
  Message,
  OpenRouterUsage,
  SystemMessage,
  ToolCall,
  ToolMetric,
  TurnCallOverrides,
  TurnContext,
  UserMessage,
} from "./types.js";
import { applyProfileAsync } from "./profiles.js";
import { loadProjectInstructions } from "./project-instructions.js";
import { loadProjectCommands, resolveCommandPrompt, buildCommandsSystemPrompt } from "./project-commands.js";
import { connectAllMcpServers } from "./mcp-client.js";
import type { McpClientHandle } from "./mcp-client.js";
import { makeTodoTools } from "./tools/todo.js";
import { makeRememberTool } from "./tools/remember.js";
import { makeWriteMemoryTool, makeReadMemoryTool, loadAutoMemory } from "./tools/auto-memory.js";
import { loadMemoryStoreAny, pruneExpired, renderMemoryBlock, renderRetrievedBlock, retrieveEntries, retrieveEntriesWithEmbeddings, memoryKeyFromCwd, buildMemoryKeyFromRepo, shouldUseFtsRetrieval } from "./memory.js";
import { isSqliteMemoryEnabled, searchMemoryFts, loadMasterContext } from "./memory-sqlite.js";
import { fireHooks } from "./hooks.js";
import type { HookConfig, HookPayload } from "./hooks.js";
import { loadSettings, mergeSettings, loadClaudeDesktopMcpServers } from "./settings.js";
import { exitPlanModeTool, PLAN_MODE_TOOL_NAME } from "./tools/plan.js";
import path from "node:path";
import { loadSession, saveSession, newSessionId, acquireSessionLock } from "./session.js";
import { callWithRetry } from "./retry.js";
import { fetchGenerationMeta, shouldUseDirect, callEmbeddings } from "./openrouter.js";
import { fetchLiveModelMeta, getLiveModelPricing, isLiveModelMetaCacheWarm, liveModelSupportsTools, liveModelSupportsVision } from "./openrouter-model-meta.js";
import { recordProviderSuccess } from "./provider-health.js";
import { loadSkillsFromDirs, buildSkillsSystemPrompt, buildSkillTools } from "./skills.js";
import { ALL_TOOLS, finishTool, BROWSER_TOOLS } from "./tools/index.js";
import { FINISH_TOOL_NAME } from "./tools/finish.js";
import { promptApproval } from "./approval.js";
import { getAgentCircuitBreaker } from "./circuit-breaker.js";
import { log } from "./logger.js";
import { auditApproval, logToolCall } from "./audit.js";
import { truncateContent } from "./truncate.js";
import { checkDeprecatedModel } from "./deprecated-models.js";
import { getModelCapabilities } from "./model-capabilities.js";
import { withSpan, spanSetAttributes } from "./telemetry.js";
import { getCachedQueryEmbedding, setCachedQueryEmbedding } from "./embedding-cache.js";
import { RateLimitTracker, isNearRateLimit, rateLimitSummary, getRateLimitState } from "./rate-limit-tracker.js";
import { gatherContext, formatContext } from "./context-injector.js";
import { makeStuckMessage } from "./prompt-variation.js";
import type { CacheEntry } from "./loop-helpers.js";
import {
  postWebhook,
  estimateTokens,
  fetchModelContextLengths,
  getContextWindow,
  isModelContextCacheWarm,
  MAX_SESSION_MESSAGES,
  summarizeSession,
  CACHE_TTL_MS,
  runConcurrent,
  MAX_PARALLEL_TOOLS,
  evaluateTurnModelRules,
} from "./loop-helpers.js";
import { recordTokens, recordToolCall, recordSession } from "./metrics.js";

// ── Cost anomaly detection ────────────────────────────────────────────────────
//
// Fires a warning when a single turn's actual cost exceeds COST_ANOMALY_MULTIPLIER × rolling average.
// The multiplier defaults to 2.0 but is overridable via ORAGER_COST_ANOMALY_MULTIPLIER.

export const COST_ANOMALY_MULTIPLIER = parseFloat(
  process.env["ORAGER_COST_ANOMALY_MULTIPLIER"] ?? "2.0",
);

// ── Agent loop ────────────────────────────────────────────────────────────────

/**
 * Compute the effective per-tool timeout given the run budget and per-tool overrides.
 *
 * Exported as a pure, deterministic function for unit testing. Callers may
 * pass the elapsed time either directly (`elapsedMs`) or as a start timestamp
 * pair (`startMs` + optional `nowMs`). When both are provided, `elapsedMs`
 * takes precedence.
 *
 * The `_effectiveToolTimeout` closure inside `runAgentLoop` delegates to this.
 *
 * @param toolName     - The tool being executed.
 * @param toolTimeouts - Per-tool explicit timeout map from AgentLoopOptions.
 * @param timeoutSec   - Run-level timeout from AgentLoopOptions (0 = unlimited).
 * @param elapsedMs    - Milliseconds elapsed since the loop started (preferred).
 * @param startMs      - Loop start timestamp; used only when elapsedMs is omitted.
 * @param nowMs        - Current timestamp (default: Date.now()); used with startMs.
 */
export function computeToolBudgetTimeout(params: {
  toolName: string;
  toolTimeouts?: Record<string, number>;
  timeoutSec?: number;
  elapsedMs?: number;
  startMs?: number;
  nowMs?: number;
}): number | undefined {
  const { toolName, toolTimeouts, timeoutSec, nowMs } = params;
  const elapsedMs =
    params.elapsedMs ??
    (params.startMs !== undefined
      ? (nowMs ?? Date.now()) - params.startMs
      : 0);
  const explicit = toolTimeouts?.[toolName];
  if (timeoutSec && timeoutSec > 0) {
    const remainingMs = timeoutSec * 1000 - elapsedMs;
    if (remainingMs <= 0) return 1; // budget exhausted — let abort signal fire
    const budgetCap = Math.min(
      Math.max(Math.floor(remainingMs * 0.8), 5_000),
      5 * 60_000, // never longer than 5 min per tool from budget
    );
    return explicit != null ? Math.min(explicit, budgetCap) : budgetCap;
  }
  return explicit;
}

/** SSRF guard: rejects loopback/private IPs and non-http(s) schemes. */
function isWebhookUrlSafe(raw: string | undefined): boolean {
  if (!raw) return false;
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "0.0.0.0" ||
    /^127\./.test(h) || /^10\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^::ffff:127\./i.test(h) || h === "::ffff:7f00:1" ||
    // Link-local: 169.254.0.0/16 (APIPA, cloud metadata e.g. 169.254.169.254)
    /^169\.254\./.test(h) ||
    // IPv6 link-local: fe80::/10
    /^fe[89ab][0-9a-f]:/i.test(h) ||
    // Multicast: 224.0.0.0/4 (IPv4), ff00::/8 (IPv6)
    /^2(2[4-9]|3\d)\./.test(h) ||
    /^ff[0-9a-f]{2}:/i.test(h)
  ) return false;
  return true;
}

export async function runAgentLoop(opts: AgentLoopOptions): Promise<void> {
  const {
    prompt,
    model: _modelOpt,
    addDirs,
    maxTurns,
    cwd,
    verbose: _verbose,
    onEmit: _rawOnEmit,
    onLog,
  } = opts;
  // Declared as `let` so vision routing can swap it to opts.visionModel when
  // the primary model does not support image inputs.
  let model = _modelOpt;

  // Track whether a result event has been emitted so the finally block knows
  // whether it needs to emit one (e.g. when the loop is aborted mid-execution).
  let _resultEmitted = false;
  const onEmit = (event: Parameters<typeof _rawOnEmit>[0]) => {
    if (event.type === "result") _resultEmitted = true;
    _rawOnEmit(event);
  };

  // Prefer per-agent key over global key so one agent's 429 can't starve others.
  const apiKey = opts.agentApiKey?.trim() || opts.apiKey || "";

  const maxRetries = opts.maxRetries ?? 3;
  const forceResume = opts.forceResume ?? false;
  const summarizeAt = opts.summarizeAt ?? 0;
  const summarizeModel = opts.summarizeModel ?? model;
  const summarizeKeepRecentTurns = opts.summarizeKeepRecentTurns ?? 0;
  const toolErrorBudgetHardStop = opts.toolErrorBudgetHardStop ?? false;

  // ── Profile expansion ─────────────────────────────────────────────────────
  // Expand named profile (e.g. "code-review") into AgentLoopOptions defaults
  // before merging settings. Caller opts always override profile defaults, so
  // this expansion only fills fields the caller hasn't set explicitly.
  if (opts.profile) {
    opts = await applyProfileAsync(opts.profile, opts);
  }

  // ── Load and merge settings file ─────────────────────────────────────────
  const fileSettings = await loadSettings(opts.settingsFile);
  const effectiveOpts = mergeSettings(opts, fileSettings);
  // Hoisted hook options — shared by all fireHooks / runHook call sites.
  const _hookOpts = { timeoutMs: effectiveOpts.hookTimeoutMs, errorMode: effectiveOpts.hookErrorMode };

  // ── Required environment variable check ───────────────────────────────────
  // Fail fast before any API calls when env vars required by tools are absent.
  if (opts.requiredEnvVars && opts.requiredEnvVars.length > 0) {
    const missing = opts.requiredEnvVars.filter(
      (v) => typeof v === "string" && v.trim().length > 0 && !process.env[v.trim()],
    );
    if (missing.length > 0) {
      onLog?.("stderr", `[orager] missing required environment variables: ${missing.join(", ")}\n`);
      onEmit({
        type: "result",
        subtype: "error",
        result: `Missing required environment variables: ${missing.join(", ")}`,
        session_id: opts.sessionId ?? "",
        finish_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
        total_cost_usd: 0,
      });
      return;
    }
  }

  // Record loop start time so per-tool budget deadlines can be derived from
  // remaining time (timeoutSec * 1000 - elapsed). Used in tool execution below.
  const _loopStartMs = Date.now();

  // ── Run-level timeout ──────────────────────────────────────────────────────
  // Compose opts.abortSignal with a timeout signal derived from opts.timeoutSec.
  // The resulting signal aborts at whichever fires first.
  const _effectiveAbortSignal: AbortSignal | undefined = (() => {
    const signals: AbortSignal[] = [];
    if (opts.abortSignal) signals.push(opts.abortSignal);
    if (opts.timeoutSec && opts.timeoutSec > 0) {
      signals.push(AbortSignal.timeout(opts.timeoutSec * 1000));
    }
    if (signals.length === 0) return undefined;
    if (signals.length === 1) return signals[0];
    return AbortSignal.any(signals);
  })();

  /**
   * Derive the effective timeout for a tool call.
   * - If an explicit entry exists in opts.toolTimeouts, honour it but cap it
   *   at the remaining run budget so tools never outlive the loop.
   * - If timeoutSec > 0 and no explicit timeout is set, use 80% of the
   *   remaining budget (min 5 s, max 5 min) so the loop always has headroom
   *   for post-tool hooks and summarization.
   * - Returns undefined when there is no effective limit.
   */
  function _effectiveToolTimeout(toolName: string): number | undefined {
    return computeToolBudgetTimeout({
      toolName,
      toolTimeouts: opts.toolTimeouts,
      timeoutSec: opts.timeoutSec,
      elapsedMs: Date.now() - _loopStartMs,
    });
  }

  // Per-agent persistent circuit breaker — keyed by sessionId so the circuit
  // state survives across daemon re-requests for the same session. When the
  // daemon retries the same agent, a prior failure streak is still counted.
  // For new sessions (opts.sessionId null) a throwaway key is used; the eviction
  // timer in circuit-breaker.ts cleans up idle entries after 1 hour.
  const _cbKey = opts.sessionId ?? newSessionId();
  const circuitBreaker = getAgentCircuitBreaker(_cbKey);

  // Per-agent rate-limit tracker — isolates rate-limit state per agent so a
  // 429 on one agent does not suppress requests from other concurrent agents.
  // The process-global singleton (used by /metrics) is still updated in openrouter.ts.
  const rlTracker = new RateLimitTracker();

  // Fetch live model metadata (context windows + pricing + capabilities) from OpenRouter.
  // Skipped for the direct Anthropic path — the OpenRouter /models endpoint requires an
  // OpenRouter key and returns no data the direct path can use. The static fallback map
  // (200k for anthropic/* models) is authoritative and used instead.
  // Also skipped when both caches are warm (e.g. pre-warmed at daemon startup) to avoid
  // the function-call overhead on every run in long-lived daemon processes.
  if (!shouldUseDirect(model) && !(isModelContextCacheWarm() && isLiveModelMetaCacheWarm())) {
    await Promise.all([
      fetchModelContextLengths(apiKey),
      fetchLiveModelMeta(apiKey),
    ]);
  }
  const contextWindow = getContextWindow(model);

  // ── Deprecation check ────────────────────────────────────────────────────
  const deprecation = checkDeprecatedModel(model);
  if (deprecation) {
    onLog?.(
      "stderr",
      `[orager] WARNING: model '${model}' is deprecated (${deprecation.deprecated}). ` +
      `Suggested replacement: '${deprecation.replacement}'.` +
      (deprecation.reason ? ` Reason: ${deprecation.reason}` : "") + "\n",
    );
    log.warn("deprecated_model", { sessionId: opts.sessionId ?? "(new)", model, replacement: deprecation.replacement });
  }

  // ── Capability check ─────────────────────────────────────────────────────
  if (opts.requiredCapabilities && opts.requiredCapabilities.length > 0) {
    const caps = getModelCapabilities(model);
    const missing = opts.requiredCapabilities.filter(
      (c) => !caps[c as keyof typeof caps],
    );
    if (missing.length > 0) {
      onLog?.(
        "stderr",
        `[orager] WARNING: model '${model}' may not support: ${missing.join(", ")}. ` +
        `Run may fail or produce degraded results.\n`,
      );
      log.warn("capability_mismatch", {
        sessionId: opts.sessionId ?? "(new)",
        model,
        missing,
      });
    }
  }

  // ── Vision model routing ─────────────────────────────────────────────────
  // If the prompt contains image_url blocks and the primary model does not
  // support vision, swap to opts.visionModel for this run.  The model meta
  // cache is warm at this point (fetched above), so liveModelSupportsVision is
  // a cheap synchronous lookup — no extra network call.
  const hasImages = (opts.promptContent ?? []).some((b) => b.type === "image_url");
  if (hasImages) {
    const visionOk = liveModelSupportsVision(model);
    if (visionOk === false) {
      if (opts.visionModel) {
        onLog?.(
          "stderr",
          `[orager] model '${model}' does not support vision — switching to visionModel '${opts.visionModel}' for this run.\n`,
        );
        log.warn("vision_model_swap", {
          sessionId: opts.sessionId ?? "(new)",
          originalModel: model,
          visionModel: opts.visionModel,
        });
        model = opts.visionModel;
      } else {
        onLog?.(
          "stderr",
          `[orager] WARNING: model '${model}' does not support vision and no visionModel is configured. ` +
          `Images may be silently stripped or cause an API error. ` +
          `Set visionModel in ~/.orager/config.json or pass --vision-model.\n`,
        );
        log.warn("vision_not_supported", {
          sessionId: opts.sessionId ?? "(new)",
          model,
          message: "no visionModel configured",
        });
      }
    } else if (visionOk === null) {
      // Could not verify from cache — soft warning only, proceed as-is.
      onLog?.(
        "stderr",
        `[orager] WARNING: could not verify vision support for '${model}' — proceeding. ` +
        `If the run fails, set visionModel in config.\n`,
      );
    }
    // visionOk === true: confirmed, no action needed.
  }

  // Log if direct Anthropic mode is active (bypasses OpenRouter)
  if (shouldUseDirect(model)) {
    onLog?.("stderr", `[orager] using direct Anthropic API for model ${model} (ANTHROPIC_API_KEY is set)\n`);
  }

  // ── Tool use capability check ─────────────────────────────────────────────
  // Prefer live tool-support data over static regex table
  const liveToolSupport = liveModelSupportsTools(model);
  if (liveToolSupport === false) {
    onLog?.("stderr", `[orager] WARNING: model '${model}' does not support tool/function calling (confirmed via OpenRouter model metadata).\n`);
  } else if (liveToolSupport === null && !getModelCapabilities(model).toolUse) {
    onLog?.("stderr", `[orager] WARNING: model '${model}' may not support tool/function calling (based on static table).\n`);
  }

  // Per-invocation tool result cache (never persisted). Capped at 200 entries
  // (FIFO eviction) to prevent unbounded memory growth on long read-heavy runs.
  const MAX_TOOL_CACHE_ENTRIES = 200;
  const toolResultCache = new Map<string, CacheEntry>();
  function setCached(key: string, value: CacheEntry): void {
    if (toolResultCache.size >= MAX_TOOL_CACHE_ENTRIES) {
      const oldest = toolResultCache.keys().next().value;
      if (oldest !== undefined) toolResultCache.delete(oldest);
    }
    toolResultCache.set(key, value);
  }

  // Tool error budget tracking: consecutive error count per tool name
  const consecutiveToolErrors = new Map<string, number>(); // toolName → consecutive error count

  // ── Safety warning ────────────────────────────────────────────────────────
  if (opts.dangerouslySkipPermissions) {
    onLog?.(
      "stderr",
      "[orager] WARNING: --dangerously-skip-permissions is active — all tool approvals are bypassed\n",
    );
  }

  // ── 1. Load or create session ─────────────────────────────────────────────
  let sessionId: string;
  let messages: Message[] = [];
  let createdAt: string = new Date().toISOString();
  let isResume = false;
  let releaseLock: (() => Promise<void>) | null = null;
  // Cumulative cost from prior runs of this session (loaded on resume).
  // Initialised to 0 for new sessions; updated when we load an existing session.
  let priorCumulativeCostUsd = 0;

  let pendingApproval: {
    toolCallId: string;
    toolName: string;
    input: Record<string, unknown>;
    assistantMessage: AssistantMessage;
    toolCalls: ToolCall[];
    questionedAt?: string;
  } | null = null;

  if (opts.sessionId) {
    try {
      releaseLock = await acquireSessionLock(opts.sessionId, {
        timeoutMs: opts.sessionLockTimeoutMs,
      });
    } catch (lockErr) {
      const msg = lockErr instanceof Error ? lockErr.message : String(lockErr);
      onLog?.("stderr", `[orager] could not acquire session lock: ${msg}\n`);
      // If the lock cannot be acquired (concurrent run on same session), emit
      // a proper error result so the caller gets a meaningful message.
      if (msg.includes("Cannot start concurrent runs")) {
        onEmit({
          type: "result",
          subtype: "error",
          result: msg,
          session_id: opts.sessionId,
          finish_reason: null,
          usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
          total_cost_usd: 0,
        });
        return;
      }
      // Other lock errors (e.g. filesystem error): log and proceed without lock
    }
    const existing = await loadSession(opts.sessionId);
    if (existing && (forceResume || existing.cwd === cwd)) {
      sessionId = existing.sessionId;
      messages = existing.messages;
      createdAt = existing.createdAt;
      isResume = true;
      pendingApproval = existing.pendingApproval ?? null;
      // Load cumulative cost so cost limits apply to the full session total
      // (not just the current run). Missing in older sessions → default 0.
      priorCumulativeCostUsd = existing.cumulativeCostUsd ?? 0;
      if (forceResume && existing.cwd !== cwd) {
        onLog?.(
          "stderr",
          `[orager] warning: resuming session ${opts.sessionId} from different cwd (was ${existing.cwd}, now ${cwd})\n`,
        );
      }
    } else {
      if (existing) {
        onLog?.(
          "stderr",
          `[orager] warning: session ${opts.sessionId} has a different cwd (${existing.cwd}), starting fresh (use --force-resume to override)\n`,
        );
      } else {
        onLog?.(
          "stderr",
          `[orager] warning: session ${opts.sessionId} not found, starting fresh\n`,
        );
        onEmit({
          type: "warn",
          subtype: "session_lost",
          message: `session ${opts.sessionId} not found, starting fresh`,
          session_id: opts.sessionId,
        });
      }
      sessionId = newSessionId();
    }
  } else {
    sessionId = newSessionId();
  }

  // ── 2. Build system prompt + tool list ────────────────────────────────────
  let systemPrompt =
    "You are an autonomous software engineering agent. Work through the user's task completely using the available tools. Think step by step. When you are done, provide a concise summary of what you accomplished.";

  const skills = await loadSkillsFromDirs(addDirs);
  const skillsSection = buildSkillsSystemPrompt(skills);
  if (skillsSection) {
    systemPrompt += "\n\n" + skillsSection;
  }

  if (opts.appendSystemPrompt?.trim()) {
    systemPrompt += "\n\n" + opts.appendSystemPrompt.trim();
  }

  // ── Project instructions (CLAUDE.md / ORAGER.md) ──────────────────────────
  if (opts.readProjectInstructions !== false) {
    const projectInstructions = await loadProjectInstructions(cwd);
    if (projectInstructions) {
      const MAX_PROJECT_INSTRUCTIONS_CHARS = 50_000; // ~12k tokens; prevents runaway CLAUDE.md files
      const capped = projectInstructions.length > MAX_PROJECT_INSTRUCTIONS_CHARS
        ? projectInstructions.slice(0, MAX_PROJECT_INSTRUCTIONS_CHARS) + "\n\n[... project instructions truncated at 50,000 chars ...]"
        : projectInstructions;
      if (projectInstructions.length > MAX_PROJECT_INSTRUCTIONS_CHARS) {
        onLog?.("stderr", `[orager] WARNING: project instructions file exceeds ${MAX_PROJECT_INSTRUCTIONS_CHARS} chars (${projectInstructions.length} chars) — truncated\n`);
      }
      systemPrompt += "\n\n--- Project instructions (CLAUDE.md / ORAGER.md) ---\n" + capped;
    }
  }

  // ── Project commands (.claude/commands/) ──────────────────────────────────
  const projectCommands = await loadProjectCommands(cwd);
  if (projectCommands.size > 0) {
    const commandsSection = buildCommandsSystemPrompt(projectCommands);
    if (commandsSection) systemPrompt += "\n\n" + commandsSection;
  }

  // Validate extraTools names before merging
  for (const tool of opts.extraTools ?? []) {
    const name = tool.definition?.function?.name ?? "";
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      onLog?.("stderr", `[orager] WARNING: extraTool name '${name}' contains invalid characters — tool names must be alphanumeric, underscore, or hyphen\n`);
    }
  }

  // Merge: built-in tools + skill tools + finish tool (opt-in) + browser tools (opt-in) + caller-supplied extra tools
  const allTools = [
    ...ALL_TOOLS,
    ...buildSkillTools(
      skills,
      // H-04: Pass bash policy blocked commands to skill tools so they
      // cannot bypass the blocklist by running commands via exec templates.
      effectiveOpts.bashPolicy?.blockedCommands?.length
        ? new Set(effectiveOpts.bashPolicy.blockedCommands.map((b: string) => b.toLowerCase()))
        : undefined,
    ),
    ...(opts.useFinishTool ? [finishTool] : []),
    ...(opts.enableBrowserTools ? BROWSER_TOOLS : []),
    ...(opts.extraTools ?? []),
  ];

  // ── Todo tools (session-scoped) ───────────────────────────────────────────
  // Note: sessionId is set above in the session load/create block
  allTools.push(...makeTodoTools(sessionId));

  // ── Cross-session memory ───────────────────────────────────────────────────
  const memoryEnabled = opts.memory !== false;
  const memoryMaxChars = typeof opts.memoryMaxChars === "number" && opts.memoryMaxChars > 0
    ? opts.memoryMaxChars
    : 6000;
  // Use provided memoryKey, or derive from repoUrl (stable across workspace moves),
  // or fall back to CWD-based keying for standalone use.
  const effectiveMemoryKey = (typeof opts.memoryKey === "string" && opts.memoryKey.trim())
    ? opts.memoryKey.trim()
    : opts.repoUrl
      ? buildMemoryKeyFromRepo(opts.agentId ?? "default", opts.repoUrl)
      : memoryKeyFromCwd(cwd);
  // ── Layer 1: Master context (always loaded when SQLite is available) ─────────
  // Injected as the first memory block so it anchors every session with stable
  // product/project context. Non-fatal — failure must never abort a run.
  if (memoryEnabled && isSqliteMemoryEnabled()) {
    try {
      const masterCtx = await loadMasterContext(effectiveMemoryKey);
      if (masterCtx) {
        systemPrompt += "\n\n## Persistent Product Context\n\n" + masterCtx;
        log.info("master_context_loaded", {
          sessionId,
          contextId: effectiveMemoryKey,
          chars: masterCtx.length,
          tokenEstimate: Math.round(masterCtx.length / 4),
        });
      }
    } catch { /* non-fatal */ }
  }

  if (memoryEnabled) {
    // Load + prune the store, inject into system prompt, and register the tool
    try {
      const memStore = pruneExpired(await withSpan("memory.load", {
        memoryKey: effectiveMemoryKey,
        backend: isSqliteMemoryEnabled() ? "sqlite" : "file",
      }, async () => loadMemoryStoreAny(effectiveMemoryKey)));
      const threshold = typeof opts.memoryRetrievalThreshold === "number"
        ? opts.memoryRetrievalThreshold
        : 15;
      const retrieval = opts.memoryRetrieval ?? "local";
      let memBlock: string;
      if (retrieval === "embedding" && opts.memoryEmbeddingModel && apiKey) {
        try {
          // Check in-memory cache before calling the embeddings API
          let queryVec = getCachedQueryEmbedding(opts.memoryEmbeddingModel, prompt);
          if (!queryVec) {
            queryVec = await withSpan("memory.embed_query", {
              model: opts.memoryEmbeddingModel,
            }, async () => {
              const vecs = await callEmbeddings(apiKey, opts.memoryEmbeddingModel!, [prompt]);
              return vecs[0] ?? [];
            });
            setCachedQueryEmbedding(opts.memoryEmbeddingModel, prompt, queryVec);
          }
          memBlock = renderRetrievedBlock(
            retrieveEntriesWithEmbeddings(memStore, queryVec ?? [], { topK: 12 }),
            memoryMaxChars,
          );
        } catch {
          // Fall back to Phase 1 on embedding API failure
          memBlock = memStore.entries.length <= threshold
            ? renderMemoryBlock(memStore, memoryMaxChars)
            : renderRetrievedBlock(retrieveEntries(memStore, prompt, { topK: 12 }), memoryMaxChars);
        }
      } else if (shouldUseFtsRetrieval(opts.memoryRetrieval)) {
        // SQLite + local retrieval: use FTS5 for efficient full-text search
        const ftsResults = await searchMemoryFts(effectiveMemoryKey, prompt, 12);
        // Deduplicate by id and render
        const seen = new Set<string>();
        const deduped = ftsResults.filter((e) => {
          if (seen.has(e.id)) return false;
          seen.add(e.id);
          return true;
        });
        memBlock = deduped.length > 0
          ? renderRetrievedBlock(deduped, memoryMaxChars)
          : renderMemoryBlock(memStore, memoryMaxChars);
      } else {
        // Phase 1 path (existing logic from Phase 1)
        memBlock = memStore.entries.length <= threshold
          ? renderMemoryBlock(memStore, memoryMaxChars)
          : renderRetrievedBlock(
              retrieveEntries(memStore, prompt, { topK: 12 }),
              memoryMaxChars,
            );
      }
      if (memBlock) {
        systemPrompt += "\n\n## Your persistent memory\n\n" + memBlock;
      }
    } catch { /* non-fatal — memory load failure must never abort a run */ }
    allTools.push(makeRememberTool(
      effectiveMemoryKey,
      memoryMaxChars,
      opts.memoryRetrieval === "embedding" && opts.memoryEmbeddingModel
        ? { apiKey, model: opts.memoryEmbeddingModel }
        : null,
      effectiveMemoryKey, // contextId — same namespace as memoryKey
    ));
  }

  // ── Auto-memory (CLAUDE.md / MEMORY.md writer) ────────────────────────────
  if (opts.autoMemory) {
    try {
      const autoMem = await loadAutoMemory(cwd);
      // Inject existing memory into the system prompt so the agent can
      // reference past notes without an explicit read_memory call.
      const autoMemParts: string[] = [];
      if (autoMem.project.trim()) {
        autoMemParts.push("## Project memory (CLAUDE.md)\n\n" + autoMem.project.trim());
      }
      if (autoMem.global.trim()) {
        autoMemParts.push("## Global memory (~/.orager/MEMORY.md)\n\n" + autoMem.global.trim());
      }
      if (autoMemParts.length > 0) {
        systemPrompt += "\n\n# Persistent memory\n\n" + autoMemParts.join("\n\n");
      }
    } catch { /* non-fatal — memory read failure must never abort a run */ }
    allTools.push(makeWriteMemoryTool(cwd));
    allTools.push(makeReadMemoryTool(cwd));
  }

  // Warn about duplicate tool names (first definition wins via find())
  const seenToolNames = new Set<string>();
  for (const tool of allTools) {
    const name = tool.definition.function.name;
    if (seenToolNames.has(name)) {
      onLog?.("stderr", `[orager] warning: duplicate tool name '${name}' — first definition takes precedence\n`);
    } else {
      seenToolNames.add(name);
    }
  }

  // Spawn-cycle detection: if this session ID appears in the ancestor chain,
  // we have a logical loop (A spawned B which is trying to resume A).
  const parentSessionIds = opts._parentSessionIds ?? [];
  if (opts.sessionId && parentSessionIds.includes(opts.sessionId)) {
    onLog?.("stderr", `[orager] ERROR: spawn cycle detected — session '${opts.sessionId}' is already an ancestor. Aborting sub-agent.\n`);
    return;
  }

  // ── Spawn-agent tool (inline closure — avoids circular import) ────────────
  const maxSpawnDepth = opts.maxSpawnDepth ?? 3;
  const currentSpawnDepth = opts._spawnDepth ?? 0;
  if (maxSpawnDepth > 0 && currentSpawnDepth < maxSpawnDepth) {
    allTools.push({
      definition: {
        type: "function",
        readonly: false,
        function: {
          name: "spawn_agent",
          description:
            "Spawn a sub-agent to complete a self-contained task. " +
            "You can call this tool multiple times in a single turn to run agents IN PARALLEL — " +
            "all spawn_agent calls in the same turn execute concurrently. " +
            "Use parallel agents for independent subtasks: researching while editing, running tests while writing docs, etc. " +
            "Each agent has access to the same tools and working directory. " +
            `Maximum nesting depth: ${maxSpawnDepth - currentSpawnDepth} more level(s).`,
          parameters: {
            type: "object",
            properties: {
              task: {
                type: "string",
                description: "Full description of the task for the sub-agent to complete",
              },
              model: {
                type: "string",
                description: `Model to use for the sub-agent (default: ${model})`,
              },
              max_turns: {
                type: "number",
                description: "Maximum turns for the sub-agent (default: 20)",
              },
              agent_id: {
                type: "string",
                description: "Optional label for this agent (used in logs to identify parallel runs, e.g. 'researcher', 'tester')",
              },
            },
            required: ["task"],
          },
        },
      },
      async execute(input: Record<string, unknown>): Promise<{ toolCallId: string; content: string; isError: boolean }> {
        if (typeof input["task"] !== "string" || !input["task"]) {
          return { toolCallId: "", content: "task must be a non-empty string", isError: true };
        }
        const subTask = input["task"] as string;
        const subModel = typeof input["model"] === "string" ? input["model"] : model;
        const subMaxTurns = typeof input["max_turns"] === "number" ? (input["max_turns"] as number) : 20;
        const agentId = typeof input["agent_id"] === "string" ? input["agent_id"] : null;
        const agentLabel = agentId ? ` [${agentId}]` : "";

        let subResult = "";
        let subError: string | null = null;
        let subTurns = 0;
        let subCostUsd = 0;
        let subFilesChanged: string[] | undefined;

        onLog?.("stderr", `[orager] spawning sub-agent${agentLabel} (depth ${currentSpawnDepth + 1}/${maxSpawnDepth}): ${subTask.slice(0, 100)}\n`);

        await runAgentLoop({
          ...opts,
          prompt: subTask,
          model: subModel,
          maxTurns: subMaxTurns,
          sessionId: null, // fresh session for each sub-agent
          trackFileChanges: true,
          _spawnDepth: currentSpawnDepth + 1,
          _parentSessionIds: [...parentSessionIds, ...(sessionId ? [sessionId] : [])],
          onEmit: (event) => {
            if (event.type === "result") {
              subResult = event.result ?? "";
              subTurns = event.turnCount ?? 0;
              subCostUsd = event.total_cost_usd ?? 0;
              subFilesChanged = (event as { filesChanged?: string[] }).filesChanged;
              if (event.subtype !== "success") {
                subError = `Sub-agent ended with subtype '${event.subtype}': ${event.result}`;
              }
            }
            // Forward sub-agent events to parent
            opts.onEmit(event);
          },
          onLog: opts.onLog,
        });

        if (subError) {
          return { toolCallId: "", content: subError, isError: true };
        }

        // Merge sub-agent filesChanged into the parent's tracking Set
        if (subFilesChanged && opts.trackFileChanges) {
          for (const f of subFilesChanged) filesChanged.add(f);
        }

        // Build a structured summary so the parent model can reason about cost/files
        const costStr = subCostUsd > 0 ? ` (cost: $${subCostUsd.toFixed(4)})` : "";
        const filesStr = subFilesChanged && subFilesChanged.length > 0
          ? `\nFiles changed: ${subFilesChanged.join(", ")}`
          : "";
        return {
          toolCallId: "",
          content: `Sub-agent${agentLabel} completed in ${subTurns} turn(s)${costStr}:\n${subResult || "(no result text)"}${filesStr}`,
          isError: false,
        };
      },
    });
  }

  // ── Plan mode notice ─────────────────────────────────────────────────────
  // Injected when opts.planMode is true so the model knows it is restricted
  // to read-only tools until it explicitly calls exit_plan_mode.
  if (opts.planMode) {
    systemPrompt +=
      "\n\n**PLAN MODE ACTIVE**: You are currently in plan mode. " +
      "Only read-only exploration tools are available right now. " +
      "Use them to analyse the codebase and form a complete plan. " +
      "When your plan is fully worked out, call `exit_plan_mode` with a brief " +
      "`plan_summary` to switch to full execution mode where all tools become available.";
  }

  systemPrompt += "\n\nWorking directory: " + cwd;

  // ── MCP client tools ──────────────────────────────────────────────────────
  const mcpHandles: McpClientHandle[] = [];
  // Auto-discover from ~/.claude/claude_desktop_config.json when not explicitly set
  const resolvedMcpServers =
    effectiveOpts.mcpServers && Object.keys(effectiveOpts.mcpServers).length > 0
      ? effectiveOpts.mcpServers
      : (effectiveOpts.mcpServers === undefined ? await loadClaudeDesktopMcpServers() : {});
  if (Object.keys(resolvedMcpServers).length > 0) {
    const handles = await connectAllMcpServers(resolvedMcpServers, (msg) => onLog?.("stderr", msg));
    for (const h of handles) {
      allTools.push(...h.tools);
      mcpHandles.push(h);
    }

    // Enforce requireMcpServers: fail fast if a critical server didn't connect
    if (effectiveOpts.requireMcpServers && effectiveOpts.requireMcpServers.length > 0) {
      const connectedPrefixes = new Set(
        mcpHandles.flatMap((h) => h.tools.map((t) => t.definition.function.name.split("__")[1] ?? "")),
      );
      const missing = effectiveOpts.requireMcpServers.filter((name) => !connectedPrefixes.has(name));
      if (missing.length > 0) {
        const errResult = {
          type: "result" as const,
          subtype: "error" as const,
          result: `Required MCP server(s) failed to connect: ${missing.join(", ")}`,
          session_id: sessionId,
          finish_reason: null,
          total_cost_usd: 0,
          usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
          turnCount: 0,
        };
        onEmit(errResult);
        return;
      }
    }
  }

  // ── Plan mode ─────────────────────────────────────────────────────────────
  let inPlanMode = opts.planMode ?? false;

  // ── 3. Emit init ──────────────────────────────────────────────────────────
  onEmit({ type: "system", subtype: "init", model, session_id: sessionId });
  log.info("loop_start", { sessionId, model, isResume });

  // ── SessionStart hook ─────────────────────────────────────────────────────
  if (effectiveOpts.hooks?.SessionStart) {
    const _sr = await fireHooks("SessionStart", effectiveOpts.hooks.SessionStart, { event: "SessionStart", sessionId, ts: new Date().toISOString() }, _hookOpts, (msg) => onLog?.("stderr", msg));
    if (!_sr.ok && effectiveOpts.hookErrorMode === "fail") {
      throw new Error(`SessionStart hook failed: ${_sr.error}`);
    }
  }

  // ── 4. Assemble initial messages ──────────────────────────────────────────

  // ── Context injection ─────────────────────────────────────────────────────
  let injectedContextPrefix = "";
  if (opts.injectContext && !isResume) {
    try {
      const ctx = await gatherContext(cwd);
      injectedContextPrefix = formatContext(ctx) + "\n\n";
    } catch { /* non-fatal */ }
  }

  // Resolve /command-name prompt shortcuts
  let resolvedPrompt = prompt;
  if (!isResume && !opts.promptContent) {
    const resolved = resolveCommandPrompt(prompt, projectCommands);
    if (resolved !== null) {
      resolvedPrompt = resolved;
      onLog?.("stderr", `[orager] resolved command prompt (${prompt.split(" ")[0]})\n`);
    }
  }

  const userMessage: UserMessage = opts.promptContent && opts.promptContent.length > 0
    ? { role: "user", content: opts.promptContent }
    : { role: "user", content: injectedContextPrefix + resolvedPrompt };

  if (isResume) {
    messages = [...messages, userMessage];
  } else {
    const systemMessage: SystemMessage = { role: "system", content: systemPrompt };
    messages = [systemMessage, userMessage];
  }

  // ── 5. Agent loop ─────────────────────────────────────────────────────────
  let turn = 0;
  let cumulativeUsage: OpenRouterUsage = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };
  let cumulativeCachedTokens = 0;
  let cumulativeCacheWriteTokens = 0;
  // Start from the session's prior cumulative cost so cost limits apply to the
  // full session total rather than resetting to $0 on every resume.
  let totalCostUsd = priorCumulativeCostUsd;
  // Per-category cost accumulators — only populated when pricing is available.
  let inputCostUsd = 0;
  let outputCostUsd = 0;
  /** Returns the cost breakdown if any pricing data was captured, else undefined. */
  function costBreakdown(): { input_usd: number; output_usd: number } | undefined {
    if (inputCostUsd === 0 && outputCostUsd === 0) return undefined;
    return { input_usd: inputCostUsd, output_usd: outputCostUsd };
  }
  let lastResponseModel = model;
  let lastFinishReason: string | null = null;
  let lastAssistantText = "";

  // Loop-detection state
  let lastToolCallSig = "";
  let identicalTurnStreak = 0;
  let stuckAttempt = 0;
  const maxIdenticalTurns = opts.maxIdenticalToolCallTurns ?? 5;
  let loopAborted = false; // set true when stuck-detection forces a break

  // JSON healing state — one healing attempt per run
  let jsonHealingUsed = false;

  // Closure variable for pending approval request (question mode).
  // Set inside executeOne when approvalMode === "question" and approval is needed.
  let pendingApprovalRequest: {
    toolCallId: string;
    toolName: string;
    input: Record<string, unknown>;
  } | null = null;

  // Per-run tool metrics — keyed by tool name, accumulates across all turns
  const toolMetrics = new Map<string, ToolMetric>();

  // File change tracking
  const filesChanged = new Set<string>();

  // Helper: execute a single tool call, returning its result content and error flag.
  // Never throws — all errors are captured as error tool results.
  async function executeOne(toolCall: ToolCall): Promise<{ id: string; content: string; isError: boolean; imageUrl?: string; _approvalPending?: true }> {
    const toolName = toolCall.function.name;
    const executor = allTools.find((t) => t.definition.function.name === toolName)
      ?? (toolName === PLAN_MODE_TOOL_NAME ? exitPlanModeTool : undefined);

    if (!executor) {
      return { id: toolCall.id, content: `Unknown tool: ${toolName}`, isError: true };
    }

    // ── Plan mode enforcement ─────────────────────────────────────────────────
    // Blocks non-readonly tools until exit_plan_mode is called.  The tool list
    // sent to the LLM is already restricted, but this guard prevents misbehaving
    // or adversarially injected tool calls from sneaking through.
    if (inPlanMode && toolName !== PLAN_MODE_TOOL_NAME && !executor.definition.readonly) {
      return {
        id: toolCall.id,
        content: `Tool '${toolName}' is not available in plan mode. ` +
          "Call exit_plan_mode first to enable full tool execution.",
        isError: true,
      };
    }

    let parsedInput: Record<string, unknown>;
    try {
      parsedInput = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
    } catch {
      return {
        id: toolCall.id,
        content: `Invalid JSON arguments for tool ${toolName}: ${toolCall.function.arguments}`,
        isError: true,
      };
    }

    // ── File change tracking ──────────────────────────────────────────────
    if (opts.trackFileChanges) {
      const filePathTools = new Set(["write_file", "edit_file", "edit_files", "delete_file"]);
      if (filePathTools.has(toolName)) {
        const p = parsedInput["path"] as string | undefined;
        if (p) {
          const abs = path.isAbsolute(p) ? p : path.join(cwd, p);
          filesChanged.add(abs);
        }
        // edit_files has an array of files
        if (toolName === "edit_files" && Array.isArray(parsedInput["files"])) {
          for (const f of parsedInput["files"] as Array<{ path?: string }>) {
            if (f.path) {
              const abs = path.isAbsolute(f.path) ? f.path : path.join(cwd, f.path);
              filesChanged.add(abs);
            }
          }
        }
      }
    }

    // ── Tool result cache (read-only tools only) ─────────────────────────────
    // Use the explicit readonly flag on the tool definition only.
    // The old name-pattern heuristic (isReadOnlyTool) has been removed to
    // prevent false cache hits on write tools that happen to contain "get"/"list"
    // in their name.  Tools without readonly: true are never cached.
    const readOnly = executor.definition.readonly === true;
    const sortedArgs = Object.fromEntries(
      Object.entries(parsedInput).sort(([a], [b]) => a.localeCompare(b)),
    );
    const cacheKey = `${toolName}:${JSON.stringify(sortedArgs)}`;

    if (readOnly) {
      const cached = toolResultCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        return { id: toolCall.id, content: cached.result, isError: false };
      }
    }

    // ── Delegated tool ──────────────────────────────────────────────────────
    if (executor.execute === false) {
      if (opts.onToolCall) {
        auditApproval({
          ts: new Date().toISOString(),
          sessionId,
          toolName,
          inputSummary: parsedInput,
          decision: "delegated",
          mode: "delegated",
        });
        const delegatedStart = Date.now();
        try {
          const delegatedTimeoutMs = _effectiveToolTimeout(toolName);
          const delegatedPromise = opts.onToolCall(toolName, parsedInput);
          const result = delegatedTimeoutMs != null
            ? await Promise.race([
                delegatedPromise,
                new Promise<never>((_, reject) =>
                  setTimeout(
                    () => reject(new Error(`Delegated tool '${toolName}' timed out after ${delegatedTimeoutMs}ms`)),
                    delegatedTimeoutMs,
                  ),
                ),
              ])
            : await delegatedPromise;
          const content = result ?? "(delegated tool returned no result)";
          const isError = result === null;
          if (readOnly && !isError) {
            setCached(cacheKey, { result: content, timestamp: Date.now() });
          } else if (!readOnly) {
            toolResultCache.clear();
          }
          logToolCall({
            event: "tool_call",
            ts: new Date().toISOString(),
            sessionId,
            toolName,
            inputSummary: parsedInput,
            isError,
            durationMs: Date.now() - delegatedStart,
            resultSummary: String(content).slice(0, 200),
          });
          return { id: toolCall.id, content, isError };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logToolCall({
            event: "tool_call",
            ts: new Date().toISOString(),
            sessionId,
            toolName,
            inputSummary: parsedInput,
            isError: true,
            durationMs: Date.now() - delegatedStart,
            resultSummary: `error: ${msg}`.slice(0, 200),
          });
          return { id: toolCall.id, content: `Delegated tool '${toolName}' threw: ${msg}`, isError: true };
        }
      }
      return {
        id: toolCall.id,
        content: `Tool '${toolName}' requires external handling but no onToolCall handler was provided`,
        isError: true,
      };
    }

    // ── Approval check ──────────────────────────────────────────────────────
    if (opts.dangerouslySkipPermissions) {
      auditApproval({
        ts: new Date().toISOString(),
        sessionId,
        toolName,
        inputSummary: parsedInput,
        decision: "skipped_permissions",
        mode: "skip_permissions",
      });
    } else if (effectiveOpts.requireApproval != null) {
      const needsApproval =
        effectiveOpts.requireApproval === "all" ||
        (Array.isArray(effectiveOpts.requireApproval) && effectiveOpts.requireApproval.includes(toolName));

      if (needsApproval) {
        if (opts.approvalMode === "question") {
          pendingApprovalRequest = {
            toolCallId: toolCall.id,
            toolName,
            input: parsedInput,
          };
          auditApproval({
            ts: new Date().toISOString(),
            sessionId,
            toolName,
            inputSummary: parsedInput,
            decision: "approved", // will be resolved on resume
            mode: "question",
          });
          return { id: toolCall.id, content: `[approval pending]`, isError: false, _approvalPending: true as const };
        }

        const approvalStart = Date.now();
        const approve = opts.onApprovalRequest
          ? await opts.onApprovalRequest(toolName, parsedInput)
          : await promptApproval(toolName, parsedInput, opts.approvalTimeoutMs);
        const approvalDurationMs = Date.now() - approvalStart;

        auditApproval({
          ts: new Date().toISOString(),
          sessionId,
          toolName,
          inputSummary: parsedInput,
          decision: approve ? "approved" : "denied",
          mode: opts.onApprovalRequest ? "callback" : "tty",
          durationMs: approvalDurationMs,
        });

        if (!approve) {
          // ── ToolDenied hook ─────────────────────────────────────────────
          if (effectiveOpts.hooks?.ToolDenied) {
            await fireHooks("ToolDenied", effectiveOpts.hooks.ToolDenied, { event: "ToolDenied", sessionId, toolName, toolInput: parsedInput, ts: new Date().toISOString() }, _hookOpts, (msg) => onLog?.("stderr", msg));
          }
          return { id: toolCall.id, content: `Tool '${toolName}' was denied by the user`, isError: true };
        }
      }
    }

    // ── PreToolCall hook ──────────────────────────────────────────────────
    if (effectiveOpts.hooks?.PreToolCall) {
      const _pr = await fireHooks("PreToolCall", effectiveOpts.hooks.PreToolCall, { event: "PreToolCall", sessionId, toolName, toolInput: parsedInput, ts: new Date().toISOString() }, _hookOpts, (msg) => onLog?.("stderr", msg));
      if (!_pr.ok && effectiveOpts.hookErrorMode === "fail") {
        return { id: toolCall.id, content: `PreToolCall hook failed: ${_pr.error}`, isError: true };
      }
    }

    const executeFn = executor.execute as Exclude<typeof executor.execute, false>;
    const toolResult = await withSpan(
      `tool.${toolName}`,
      { "orager.tool": toolName, "orager.session_id": sessionId },
      async () => {
        const metricStart = Date.now();
        let metricIsError = false;
        let metricResultSummary: string | undefined;
        try {
          const toolTimeoutMs = _effectiveToolTimeout(toolName);
          const toolExecOpts = { sandboxRoot: opts.sandboxRoot, bashPolicy: effectiveOpts.bashPolicy, sessionId, additionalEnv: opts.env };
          const result = toolTimeoutMs != null
            ? await Promise.race([
                executeFn(parsedInput, cwd, toolExecOpts),
                new Promise<never>((_, reject) =>
                  setTimeout(() => reject(new Error(`Tool '${toolName}' timed out after ${toolTimeoutMs}ms`)), toolTimeoutMs),
                ),
              ])
            : await executeFn(parsedInput, cwd, toolExecOpts);
          if (readOnly && !result.isError) {
            // Store truncated content in cache — prevents untruncated hits from
            // exceeding context limits when consumed by the message assembly loop
            const MAX_TOOL_CACHE_CHARS = 50_000;
            setCached(cacheKey, { result: result.content.slice(0, MAX_TOOL_CACHE_CHARS), timestamp: Date.now() });
          } else if (!readOnly) {
            toolResultCache.clear();
          }
          metricIsError = result.isError;
          metricResultSummary = result.content.slice(0, 200);
          return { id: toolCall.id, content: result.content, isError: result.isError, imageUrl: result.imageUrl };
        } catch (err) {
          metricIsError = true;
          const msg = err instanceof Error ? err.message : String(err);
          metricResultSummary = `error: ${msg}`.slice(0, 200);
          // ── ToolTimeout hook ──────────────────────────────────────────────
          if (msg.includes("timed out") && effectiveOpts.hooks?.ToolTimeout) {
            await fireHooks("ToolTimeout", effectiveOpts.hooks.ToolTimeout, { event: "ToolTimeout", sessionId, toolName, toolInput: parsedInput, isError: true, ts: new Date().toISOString() }, _hookOpts, (m) => onLog?.("stderr", m));
          }
          return { id: toolCall.id, content: `Tool threw an unexpected error: ${msg}`, isError: true };
        } finally {
          const elapsed = Date.now() - metricStart;
          const m = toolMetrics.get(toolName) ?? { calls: 0, errors: 0, totalMs: 0 };
          m.calls++;
          if (metricIsError) m.errors++;
          m.totalMs += elapsed;
          toolMetrics.set(toolName, m);
          // ── OTel metrics: tool call counts ──────────────────────────────
          recordToolCall(toolName, metricIsError);
          // ── Structured tool-call audit log ──────────────────────────────
          logToolCall({
            event: "tool_call",
            ts: new Date().toISOString(),
            sessionId,
            toolName,
            inputSummary: parsedInput,
            isError: metricIsError,
            durationMs: elapsed,
            resultSummary: metricResultSummary,
          });
        }
      },
    );

    // ── PostToolCall hook ─────────────────────────────────────────────────
    if (effectiveOpts.hooks?.PostToolCall) {
      const _por = await fireHooks("PostToolCall", effectiveOpts.hooks.PostToolCall, { event: "PostToolCall", sessionId, toolName, toolInput: parsedInput, isError: toolResult.isError, ts: new Date().toISOString() }, _hookOpts, (msg) => onLog?.("stderr", msg));
      if (!_por.ok && effectiveOpts.hookErrorMode === "fail") {
        return { id: toolCall.id, content: `PostToolCall hook failed: ${_por.error}`, isError: true };
      }
    }

    return toolResult;
  }

  const _sessionStartMs = Date.now();
  // Stable prompt fingerprint: SHA-256(model + "\n" + prompt), first 16 hex chars.
  // Distinct from sessionId so repeated prompts on different sessions share the same
  // prompt_id in traces — enabling cross-session prompt performance analysis.
  const _promptId = await (async () => {
    try {
      const { createHash } = await import("node:crypto");
      return createHash("sha256").update(`${model}\n${prompt}`).digest("hex").slice(0, 16);
    } catch {
      return sessionId; // fallback: crypto unavailable
    }
  })();
  await withSpan("agent_loop", { "orager.session_id": sessionId, "orager.model": model, "orager.prompt_id": _promptId }, async (rootSpan) => {
  void rootSpan; // rootSpan available for attribute setting

  const firedOnce = new Set<number>();

  // ── emitResult helper ─────────────────────────────────────────────────────
  // DRY wrapper: fires onEmit, records OTel session metrics, fires the webhook,
  // MaxTurnsReached hook (when applicable), and the Stop hook for every terminal
  // result event.
  const emitResult = async (resultEvent: EmitResultEvent): Promise<void> => {
    onEmit(resultEvent);
    // ── OTel metrics: session duration + turn count ──────────────────────
    recordSession(Date.now() - _sessionStartMs, resultEvent.turnCount ?? turn, resultEvent.subtype);
    if (isWebhookUrlSafe(opts.webhookUrl)) {
      const webhookErr = await postWebhook(opts.webhookUrl!, resultEvent, opts.webhookFormat, opts.webhookSecret);
      if (webhookErr) {
        onEmit({ type: "warn", message: `webhook_delivery_failed: ${webhookErr}` });
      }
    }
    // MaxTurnsReached fires before Stop so listeners can distinguish the reason.
    if (resultEvent.subtype === "error_max_turns" && effectiveOpts.hooks?.MaxTurnsReached) {
      await fireHooks("MaxTurnsReached", effectiveOpts.hooks.MaxTurnsReached, {
        event: "MaxTurnsReached",
        sessionId,
        model: lastResponseModel,
        turn,
        subtype: resultEvent.subtype,
        totalCostUsd: resultEvent.total_cost_usd,
        turnCount: resultEvent.turnCount,
        ts: new Date().toISOString(),
      } satisfies HookPayload, _hookOpts, (msg) => onLog?.("stderr", msg));
    }
    if (effectiveOpts.hooks?.Stop) {
      await fireHooks("Stop", effectiveOpts.hooks.Stop, {
        event: "Stop",
        sessionId,
        model: lastResponseModel,
        turn,
        subtype: resultEvent.subtype,
        result: resultEvent.result,
        totalCostUsd: resultEvent.total_cost_usd,
        turnCount: resultEvent.turnCount,
        ts: new Date().toISOString(),
      } satisfies HookPayload, _hookOpts, (msg) => onLog?.("stderr", msg));
    }
  };

  try {
    // ── Pending approval resume ────────────────────────────────────────────────
    // If this session has a pending approval (run ended with a question event),
    // resolve it now using opts.approvalAnswer before starting the turn loop.
    if (isResume && pendingApproval && opts.approvalAnswer) {
      const approved = opts.approvalAnswer.choiceKey === "approve";

      // Re-inject the assistant message that had tool calls
      messages.push(pendingApproval.assistantMessage);

      // Create synthetic tool results for all tool calls in that turn
      for (const tc of pendingApproval.toolCalls) {
        if (tc.id === pendingApproval.toolCallId) {
          // This is the tool that needed approval
          const result = approved
            ? await executeOne(tc)
            : { id: tc.id, content: `Tool '${tc.function.name}' was denied by the user.`, isError: true };
          messages.push({ role: "tool" as const, tool_call_id: tc.id, content: result.content });
        } else {
          // Other tool calls in the same turn — execute normally
          const result = await executeOne(tc);
          messages.push({ role: "tool" as const, tool_call_id: tc.id, content: result.content });
        }
      }

      // Clear pending approval from session
      await saveSession({
        sessionId,
        model,
        messages,
        createdAt,
        updatedAt: new Date().toISOString(),
        turnCount: 0,
        cwd,
        pendingApproval: null,
        cumulativeCostUsd: totalCostUsd,
      }).catch((err: unknown) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[orager] WARNING: session save failed (approval-pending) for ${sessionId}: ${errMsg}\n`);
        onEmit({ type: "warn", message: "session_save_failed_approval_pending: " + errMsg });
      });

      const elapsedMs = pendingApproval.questionedAt
        ? Date.now() - new Date(pendingApproval.questionedAt).getTime()
        : null;
      const elapsedStr = elapsedMs !== null
        ? ` (waited ${elapsedMs < 60_000 ? `${Math.round(elapsedMs / 1000)}s` : `${Math.round(elapsedMs / 60_000)}m`})`
        : "";
      onLog?.("stderr", `[orager] approval resolved (${approved ? "approved" : "denied"})${elapsedStr} — resuming run\n`);
    }

    // Rolling average for cost anomaly detection (P3-5)
    // Track per-turn actual costs to compute a running average.
    const _turnCosts: number[] = [];

    // Summarization failure cooldown — after a failed summarization attempt,
    // skip re-attempting for SUMMARIZE_COOLDOWN_TURNS turns to avoid hammering
    // the API when the summarize model is unavailable or the context is malformed.
    const SUMMARIZE_COOLDOWN_TURNS = 5;
    let summarizeFailedAtTurn = -SUMMARIZE_COOLDOWN_TURNS - 1; // sentinel: never failed

    // maxTurns <= 0 means unlimited
    while (maxTurns <= 0 || turn < maxTurns) {
      // ── Cancellation check ────────────────────────────────────────────────
      if (_effectiveAbortSignal?.aborted) {
        onLog?.("stderr", "[orager] run cancelled via abort signal\n");
        log.warn("loop_cancelled", { sessionId, turn });
        await saveSession({
          sessionId,
          model: lastResponseModel,
          messages,
          createdAt,
          updatedAt: new Date().toISOString(),
          turnCount: turn,
          cwd,
          cumulativeCostUsd: totalCostUsd,
        }).catch((err: unknown) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[orager] WARNING: session save failed (approval-answer) for ${sessionId}: ${errMsg}\n`);
        onEmit({ type: "warn", message: "session_save_failed_approval_answer: " + errMsg });
      });
        {
          const resultEvent = {
            type: "result" as const,
            subtype: "error_cancelled" as const,
            result: "Run was cancelled",
            session_id: sessionId,
            finish_reason: null,
            usage: {
              input_tokens: cumulativeUsage.prompt_tokens,
              output_tokens: cumulativeUsage.completion_tokens,
              cache_read_input_tokens: cumulativeCachedTokens,
              cache_write_tokens: cumulativeCacheWriteTokens,
            },
            total_cost_usd: totalCostUsd,
          cost_breakdown: costBreakdown(),
            turnCount: turn,
            toolMetrics: Object.fromEntries(toolMetrics),
            filesChanged: opts.trackFileChanges ? Array.from(filesChanged) : undefined,
          };
          await emitResult(resultEvent);
        }
        return;
      }

      // ── Per-turn dynamic overrides ────────────────────────────────────────
      const turnCtx: TurnContext = {
        turn,
        model: lastResponseModel,
        cumulativeTokens: {
          prompt: cumulativeUsage.prompt_tokens,
          completion: cumulativeUsage.completion_tokens,
          total: cumulativeUsage.total_tokens,
        },
        cumulativeCostUsd: totalCostUsd,
        messages,
      };
      const ruleModel = evaluateTurnModelRules(opts.turnModelRules, turnCtx, firedOnce);
      const callbackOverrides = opts.onTurnStart?.(turnCtx) ?? {};
      // onTurnStart overrides take priority over rules
      const turnOverrides: TurnCallOverrides = {
        ...( ruleModel ? { model: ruleModel } : {} ),
        ...callbackOverrides,
      };

      // ── Rate limit warning ───────────────────────────────────────────────
      // Use the per-agent tracker so one agent's 429 doesn't delay other agents.
      // Fall back to the global singleton when the per-agent tracker has no data
      // yet (e.g. very first turn before any response headers have been seen).
      const _rlActive = rlTracker.getState() ? rlTracker : null;
      if ((_rlActive ? _rlActive.isNearLimit() : isNearRateLimit())) {
        const rlState = _rlActive ? _rlActive.getState() : getRateLimitState();
        const resetAt = rlState?.resetRequestsAt ?? rlState?.resetTokensAt;
        const waitMs = resetAt ? Math.max(0, resetAt.getTime() - Date.now()) : 0;
        const summary = _rlActive ? _rlActive.summary() : rateLimitSummary();
        if (waitMs > 0 && waitMs <= 60_000) {
          onLog?.("stderr", `[orager] near rate limit — waiting ${Math.ceil(waitMs / 1000)}s for reset (${summary})\n`);
          log.warn("rate_limit_wait", { sessionId, waitMs, summary });
          await new Promise<void>((r) => setTimeout(r, waitMs));
        } else {
          onLog?.("stderr", `[orager] WARNING: approaching OpenRouter rate limit — ${summary}\n`);
          log.warn("rate_limit_near", { sessionId, summary });
        }
      }

      // ── Circuit breaker check ──────────────────────────────────────────────
      if (circuitBreaker.isOpen()) {
        const retryIn = Math.ceil(circuitBreaker.retryInMs / 1000);
        onLog?.("stderr", `[orager] OpenRouter circuit breaker is OPEN — retry in ${retryIn}s\n`);
        {
          const resultEvent = {
            type: "result" as const,
            subtype: "error_circuit_open" as const,
            result: `OpenRouter circuit breaker is open (${retryIn}s until next retry)`,
            session_id: sessionId,
            finish_reason: null,
            usage: {
              input_tokens: cumulativeUsage.prompt_tokens,
              output_tokens: cumulativeUsage.completion_tokens,
              cache_read_input_tokens: cumulativeCachedTokens,
              cache_write_tokens: cumulativeCacheWriteTokens,
            },
            total_cost_usd: totalCostUsd,
          cost_breakdown: costBreakdown(),
            turnCount: turn,
            toolMetrics: Object.fromEntries(toolMetrics),
            filesChanged: opts.trackFileChanges ? Array.from(filesChanged) : undefined,
          };
          await emitResult(resultEvent);
        }
        return;
      }

      // Track whether any text_delta / thinking_delta events were emitted for
      // this turn so the downstream assistant event can set streamed: true and
      // consumers can skip re-rendering already-streamed text.
      let turnWasStreamed = false;
      // Apply :online suffix when web-search mode is requested and the model
      // doesn't already carry a variant suffix (:online, :nitro, :thinking, etc.)
      const _baseModel = turnOverrides.model ?? model;
      const _effectiveModel =
        opts.onlineSearch && !_baseModel.includes(":")
          ? `${_baseModel}:online`
          : _baseModel;

      // Apply :online suffix to fallback models too, so web-search mode is
      // consistent if OpenRouter routes to a fallback instead of the primary.
      const _effectiveModels = opts.onlineSearch && opts.models && opts.models.length > 0
        ? opts.models.map((m) => (m.includes(":") ? m : `${m}:online`))
        : opts.models;

      // ── PreLLMRequest hook ────────────────────────────────────────────────
      if (effectiveOpts.hooks?.PreLLMRequest) {
        await fireHooks("PreLLMRequest", effectiveOpts.hooks.PreLLMRequest, { event: "PreLLMRequest", sessionId, model: _effectiveModel, turn, ts: new Date().toISOString() }, _hookOpts, (msg) => onLog?.("stderr", msg));
      }

      const response = await withSpan(
        "llm_turn",
        { "orager.turn": turn, "orager.model": _effectiveModel },
        async () => callWithRetry(
        {
          apiKey,
          apiKeys: opts.apiKeys,
          model: _effectiveModel,
          models: _effectiveModels,
          // Pass the session ID so openrouter.ts can set X-Session-Id for
          // sticky routing, maximising prompt cache hits across turns.
          sessionId,
          messages,
          tools: (inPlanMode
            ? [...allTools.filter((t) => t.definition.readonly === true), exitPlanModeTool]
            : allTools
          ).map((t) => t.definition),
          temperature: turnOverrides.temperature ?? opts.temperature,
          top_p: turnOverrides.top_p ?? opts.top_p,
          top_k: turnOverrides.top_k ?? opts.top_k,
          max_completion_tokens: turnOverrides.max_completion_tokens,
          frequency_penalty: opts.frequency_penalty,
          presence_penalty: opts.presence_penalty,
          repetition_penalty: opts.repetition_penalty,
          min_p: opts.min_p,
          seed: opts.seed,
          stop: opts.stop,
          tool_choice: opts.tool_choice,
          parallel_tool_calls: opts.parallel_tool_calls,
          reasoning: turnOverrides.reasoning ?? opts.reasoning,
          provider: opts.provider,
          transforms: opts.transforms,
          preset: opts.preset,
          siteUrl: opts.siteUrl,
          siteName: opts.siteName,
          // N-01: Forward the abort signal to the API call so in-flight
          // requests are cancelled immediately when the daemon timeout fires,
          // rather than waiting for the call to complete naturally.
          signal: _effectiveAbortSignal,
          response_format: opts.response_format,
          disableContextCompression: summarizeAt > 0,
          rateLimitTracker: rlTracker,
          // Per-agent user identifier for OpenRouter attribution/abuse detection.
          // Falls back to sessionId (stable UUID) when no explicit agentId is set.
          user: opts.agentId ?? sessionId,
          // Stream partial tokens to consumers in real time.
          // Each delta is emitted as a separate event so the adapter can
          // forward it to Paperclip / other UIs without buffering the full turn.
          onChunk: (chunk) => {
            for (const choice of chunk.choices) {
              const delta = choice.delta;
              if (typeof delta?.content === "string" && delta.content) {
                turnWasStreamed = true;
                onEmit({ type: "text_delta", delta: delta.content });
              }
              const reasoning = delta?.reasoning ?? (delta as Record<string, unknown> | undefined)?.reasoning_content;
              if (typeof reasoning === "string" && reasoning) {
                turnWasStreamed = true;
                onEmit({ type: "thinking_delta", delta: reasoning });
              }
            }
          },
        },
        maxRetries,
        (msg) => onLog?.("stderr", msg),
      ),
      );

      // Mid-stream error after retries exhausted — treat as fatal loop error
      if (response.isError) {
        throw new Error(response.errorMessage ?? "OpenRouter stream error");
      }
      circuitBreaker.recordSuccess();

      lastResponseModel = response.model;
      lastFinishReason = response.finishReason;

      // Accumulate usage
      cumulativeUsage.prompt_tokens += response.usage.prompt_tokens;
      cumulativeUsage.completion_tokens += response.usage.completion_tokens;
      cumulativeUsage.total_tokens += response.usage.total_tokens;
      cumulativeCachedTokens += response.cachedTokens;
      cumulativeCacheWriteTokens += response.cacheWriteTokens;

      // Accumulate cost — prefer caller-supplied pricing, fall back to live OpenRouter data
      const previousTurnCostTotal = totalCostUsd;
      const livePricing = getLiveModelPricing(turnOverrides.model ?? model);
      const inputCost = opts.costPerInputToken ?? livePricing?.prompt ?? 0;
      const outputCost = opts.costPerOutputToken ?? livePricing?.completion ?? 0;
      if (inputCost > 0 || outputCost > 0) {
        const turnInputCost  = inputCost  * response.usage.prompt_tokens;
        const turnOutputCost = outputCost * response.usage.completion_tokens;
        totalCostUsd += turnInputCost + turnOutputCost;
        totalCostUsd  = Math.round(totalCostUsd  * 1e8) / 1e8;
        inputCostUsd  += turnInputCost;
        outputCostUsd += turnOutputCost;
      }

      // ── PostLLMResponse hook ──────────────────────────────────────────────
      if (effectiveOpts.hooks?.PostLLMResponse) {
        await fireHooks("PostLLMResponse", effectiveOpts.hooks.PostLLMResponse, {
          event: "PostLLMResponse",
          sessionId,
          model: lastResponseModel,
          turn,
          inputTokens: response.usage.prompt_tokens,
          outputTokens: response.usage.completion_tokens,
          ts: new Date().toISOString(),
        }, _hookOpts, (msg) => onLog?.("stderr", msg));
      }

      // ── OTel metrics: token counts ────────────────────────────────────────
      recordTokens(response.usage.prompt_tokens, response.usage.completion_tokens, lastResponseModel);

      // ── Generation metadata (fire-and-forget) ────────────────────────────
      if (response.generationId) {
        fetchGenerationMeta(apiKey, response.generationId).then((meta) => {
          if (!meta) return;
          // Use actual cost if available (overrides token-based estimate)
          if (meta.totalCost > 0) {
            const estimatedTurnCost = totalCostUsd - previousTurnCostTotal;
            totalCostUsd = previousTurnCostTotal + meta.totalCost;
            totalCostUsd = Math.round(totalCostUsd * 1e8) / 1e8;
            // Warn when actual cost diverges significantly from the token-based estimate
            // (can happen with model-specific pricing, volume discounts, or new model tiers)
            if (estimatedTurnCost > 0) {
              const divergence = Math.abs(meta.totalCost - estimatedTurnCost) / meta.totalCost;
              if (divergence > 0.05) {
                onLog?.("stderr",
                  `[orager] cost estimate divergence: estimated $${estimatedTurnCost.toFixed(6)}, actual $${meta.totalCost.toFixed(6)} (${(divergence * 100).toFixed(1)}% off) — update costPerInputToken/costPerOutputToken for accuracy\n`,
                );
                log.warn("cost_estimate_divergence", { sessionId, turn, estimatedTurnCost, actualTurnCost: meta.totalCost, divergencePct: Math.round(divergence * 100) });
              }
            }
            // ── Cost anomaly detection (P3-5) ────────────────────────────────
            // Warn when this turn's actual cost exceeds COST_ANOMALY_MULTIPLIER × rolling average.
            _turnCosts.push(meta.totalCost);
            if (_turnCosts.length >= 2) {
              // Compute rolling average excluding the current turn
              const prevCosts = _turnCosts.slice(0, -1);
              const rollingAvg = prevCosts.reduce((s, c) => s + c, 0) / prevCosts.length;
              if (rollingAvg > 0 && meta.totalCost > COST_ANOMALY_MULTIPLIER * rollingAvg) {
                onLog?.("stderr",
                  `[orager] WARNING: cost anomaly — turn ${turn} cost $${meta.totalCost.toFixed(6)} is ${(meta.totalCost / rollingAvg).toFixed(1)}× the rolling average ($${rollingAvg.toFixed(6)})\n`,
                );
                log.warn("cost_anomaly", { sessionId, turn, turnCost: meta.totalCost, rollingAvg, multiplier: meta.totalCost / rollingAvg });
              }
            }
          }
          // Update provider health with the real provider name
          recordProviderSuccess(response.model, meta.providerName, meta.latencyMs);
          log.info("generation_meta", {
            sessionId,
            turn,
            generationId: meta.id,
            providerName: meta.providerName,
            actualCostUsd: meta.totalCost,
            cacheDiscountUsd: meta.cacheDiscount,
            nativeTokensPrompt: meta.nativeTokensPrompt,
            nativeTokensCompletion: meta.nativeTokensCompletion,
            latencyMs: meta.latencyMs,
          });
        }).catch((err: unknown) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[orager] WARNING: generation metadata fetch failed for ${sessionId}: ${errMsg}\n`);
      });
      }

      // Build assistant message and add to history
      const assistantMsg: AssistantMessage = {
        role: "assistant",
        content: response.content || null,
        tool_calls: response.toolCalls.length > 0 ? response.toolCalls : undefined,
      };
      messages.push(assistantMsg);

      // Track last assistant text for result summary
      if (response.content) {
        lastAssistantText = response.content;
      }

      // ── JSON healing ─────────────────────────────────────────────────────
      // When response_format is json_object, verify the response parses as JSON.
      // On failure, inject a one-shot correction message and continue the loop
      // so the model gets another chance. Capped at one healing attempt per run.
      if (
        opts.response_format?.type === "json_object" &&
        !jsonHealingUsed &&
        response.content &&
        response.toolCalls.length === 0
      ) {
        try {
          JSON.parse(response.content);
        } catch {
          jsonHealingUsed = true;
          onLog?.("stderr", "[orager] JSON healing: previous response was not valid JSON — requesting retry\n");
          messages.push({
            role: "user",
            content: "Your previous response was not valid JSON. Please respond with only valid JSON, no markdown fences.",
          });
          continue; // skip tool execution, go directly to next turn
        }
      }

      // Build content blocks for the emit event
      type ThinkingBlock = { type: "thinking"; thinking: string };
      type TextBlock = { type: "text"; text: string };
      type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
      const contentBlocks: Array<ThinkingBlock | TextBlock | ToolUseBlock> = [];

      if (response.reasoning) {
        contentBlocks.push({ type: "thinking", thinking: response.reasoning });
      }
      if (response.content) {
        contentBlocks.push({ type: "text", text: response.content });
      }
      for (const toolCall of response.toolCalls) {
        let parsedInput: Record<string, unknown> = {};
        try {
          parsedInput = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
        } catch {
          parsedInput = { _raw: toolCall.function.arguments };
        }
        contentBlocks.push({ type: "tool_use", id: toolCall.id, name: toolCall.function.name, input: parsedInput });
      }

      onEmit({ type: "assistant", streamed: turnWasStreamed || undefined, message: { role: "assistant", content: contentBlocks } });

      // Only break when there are truly no tools to execute
      if (response.toolCalls.length === 0) {
        break;
      }

      // ── Execute tool calls (sequential or parallel with concurrency cap) ──
      const toolResults = opts.parallel_tool_calls
        ? await runConcurrent(response.toolCalls, MAX_PARALLEL_TOOLS, executeOne)
        : await (async () => {
            const results: Awaited<ReturnType<typeof executeOne>>[] = [];
            for (const tc of response.toolCalls) results.push(await executeOne(tc));
            return results;
          })();

      type ToolEventItem = { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean; image_url?: string };
      const toolEventContent: ToolEventItem[] = [];

      // Pre-build lookup maps to avoid O(n²) find() calls in the tool result loop
      const toolCallById = new Map(response.toolCalls.map((tc) => [tc.id, tc]));
      const toolResultById = new Map(toolResults.map((r) => [r.id, r]));
      const MAX_TOOL_RESULT_CHARS = 50_000;
      // Collect image follow-up messages separately so all tool messages come
      // as a contiguous block before any user messages — models expect strict
      // assistant → [tool…] → assistant turn ordering.
      const imageFollowUps: UserMessage[] = [];
      for (const { id, content: resultContent, isError } of toolResults) {
        const safeContent = truncateContent(resultContent, MAX_TOOL_RESULT_CHARS);
        // Prompt injection guard: tag external content with its source tool
        const tagToolOutputs = opts.tagToolOutputs !== false; // default true
        const taggedContent = tagToolOutputs
          ? (() => {
              const tc = toolCallById.get(id);
              const name = tc?.function.name ?? "tool";
              return `<tool_result name="${name}">\n${safeContent}\n</tool_result>`;
            })()
          : safeContent;
        messages.push({ role: "tool", tool_call_id: id, content: taggedContent });
        const toolResultWithImage = toolResultById.get(id);
        if (toolResultWithImage?.imageUrl) {
          // Collect image as a follow-up user message — appended after all tool messages
          imageFollowUps.push({
            role: "user",
            content: [
              { type: "text", text: `[Image result from ${toolCallById.get(id)?.function.name ?? "tool"}]` },
              { type: "image_url", image_url: { url: toolResultWithImage.imageUrl } },
            ],
          });
        }
        toolEventContent.push({ type: "tool_result", tool_use_id: id, content: safeContent, is_error: isError || undefined, image_url: toolResultWithImage?.imageUrl });
      }
      // Append image follow-ups after the full tool block
      for (const imgMsg of imageFollowUps) messages.push(imgMsg);

      onEmit({ type: "tool", content: toolEventContent });

      // ── Plan mode: check if exit_plan_mode was called ─────────────────────
      if (inPlanMode) {
        const exitPlanResult = toolResults.find((r) => {
          const tc = toolCallById.get(r.id);
          return tc?.function.name === PLAN_MODE_TOOL_NAME;
        });
        if (exitPlanResult) {
          inPlanMode = false;
          onLog?.("stderr", "[orager] plan mode exited — full execution enabled\n");
        }
      }

      // ── Tool error budget check ───────────────────────────────────────────
      const TOOL_ERROR_BUDGET = 5;
      for (const r of toolResults) {
        const name = toolCallById.get(r.id)?.function.name ?? "unknown";
        if (r.isError) {
          consecutiveToolErrors.set(name, (consecutiveToolErrors.get(name) ?? 0) + 1);
        } else {
          consecutiveToolErrors.set(name, 0);
        }
      }
      let toolBudgetExceeded = false;
      for (const [toolName, errorCount] of consecutiveToolErrors) {
        if (errorCount >= TOOL_ERROR_BUDGET) {
          log.warn("tool_error_budget_exceeded", { sessionId, toolName, consecutiveErrors: errorCount });
          if (toolErrorBudgetHardStop) {
            onLog?.("stderr", `[orager] tool error budget exceeded: '${toolName}' failed ${errorCount} consecutive times — stopping run\n`);
            toolBudgetExceeded = true;
          } else {
            onLog?.("stderr", `[orager] WARNING: tool '${toolName}' has failed ${errorCount} consecutive times this run\n`);
            consecutiveToolErrors.set(toolName, 0); // reset after warning to avoid spam
          }
        }
      }
      if (toolBudgetExceeded) {
        const budgetToolName = [...consecutiveToolErrors.entries()].find(([, c]) => c >= TOOL_ERROR_BUDGET)?.[0] ?? "unknown";
        const budgetResultEvent = {
          type: "result" as const,
          subtype: "error_tool_budget" as const,
          result: `Tool '${budgetToolName}' exceeded the consecutive-failure budget (${TOOL_ERROR_BUDGET} failures). Run stopped.`,
          session_id: sessionId,
          finish_reason: "tool_error_budget",
          usage: {
            input_tokens: cumulativeUsage.prompt_tokens,
            output_tokens: cumulativeUsage.completion_tokens,
            cache_read_input_tokens: cumulativeCachedTokens,
            cache_write_tokens: cumulativeCacheWriteTokens,
          },
          total_cost_usd: totalCostUsd,
          cost_breakdown: costBreakdown(),
          turnCount: turn,
          toolMetrics: Object.fromEntries(toolMetrics),
          filesChanged: opts.trackFileChanges ? Array.from(filesChanged) : undefined,
        };
        await saveSession({
          sessionId,
          model: lastResponseModel,
          messages,
          createdAt,
          updatedAt: new Date().toISOString(),
          turnCount: turn,
          cwd,
          cumulativeCostUsd: totalCostUsd,
        }).catch((err: unknown) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[orager] WARNING: session save failed (budget-exceeded) for ${sessionId}: ${errMsg}\n`);
        onEmit({ type: "warn", message: "session_save_failed_budget_exceeded: " + errMsg });
      });
        await emitResult(budgetResultEvent);
        return;
      }

      // ── Loop detection ────────────────────────────────────────────────────
      if (maxIdenticalTurns > 0 && response.toolCalls.length > 0) {
        const sig = response.toolCalls
          .map((tc) => `${tc.function.name}:${tc.function.arguments}`)
          .sort()
          .join("|");
        if (sig === lastToolCallSig) {
          identicalTurnStreak++;
        } else {
          identicalTurnStreak = 1;
          lastToolCallSig = sig;
          stuckAttempt = 0;
        }
        if (identicalTurnStreak >= maxIdenticalTurns) {
          onLog?.(
            "stderr",
            `[orager] loop detected: identical tool calls for ${identicalTurnStreak} consecutive turns — injecting warning\n`,
          );
          log.warn("loop_detected", { sessionId, turn, streak: identicalTurnStreak, sig });
          messages.push({
            role: "user" as const,
            content: makeStuckMessage(identicalTurnStreak, stuckAttempt++),
          });
          // After 3 injected warnings without the model breaking the pattern,
          // abort to prevent indefinite token waste. stuckAttempt was just
          // post-incremented above, so the value is 1-based here.
          if (stuckAttempt >= 3) {
            onLog?.(
              "stderr",
              `[orager] loop_abort: identical tool calls for ${identicalTurnStreak} turns — terminating after ${stuckAttempt} warnings\n`,
            );
            log.warn("loop_abort", { sessionId, turn, streak: identicalTurnStreak, stuckAttempt });
            loopAborted = true;
            break;
          }
          // Do NOT reset identicalTurnStreak — escalate by injecting a warning on every
          // subsequent stuck turn until the pattern breaks naturally. Cap at threshold
          // to avoid the number appearing misleadingly large in logs.
          identicalTurnStreak = maxIdenticalTurns;
        }
      }

      // ── Question mode: check if any tool triggered an approval request ────
      const approvalResult = toolResults.find((r) => (r as { _approvalPending?: true })._approvalPending);
      // Use type assertion to work around TypeScript loop narrowing (pendingApprovalRequest is reset at end of loop, so TS narrows it to null at loop start)
      const capturedPendingApproval = pendingApprovalRequest as {
        toolCallId: string;
        toolName: string;
        input: Record<string, unknown>;
      } | null;
      if (approvalResult && capturedPendingApproval) {
        // Emit the question event
        onEmit({
          type: "question",
          prompt: `Agent wants to run: ${capturedPendingApproval.toolName}(${JSON.stringify(capturedPendingApproval.input).slice(0, 200)})`,
          choices: [
            { key: "approve", label: "Approve", description: `Allow ${capturedPendingApproval.toolName} to run` },
            { key: "deny",    label: "Deny",    description: `Skip ${capturedPendingApproval.toolName}` },
          ],
          toolCallId: capturedPendingApproval.toolCallId,
          toolName: capturedPendingApproval.toolName,
        });

        // Save pending approval to session so the next run can resolve it.
        // Save messages BEFORE the assistant message (we'll re-inject it on resume).
        // At this point messages = [...priorMsgs, assistantMsg, ...toolResultMsgs]
        // So we need to strip off 1 (assistantMsg) + toolResults.length (tool msgs)
        const messagesBeforeThisTurn = messages.slice(0, messages.length - 1 - toolResults.length);
        const questionedAt = new Date().toISOString();
        await saveSession({
          sessionId,
          model: lastResponseModel,
          messages: messagesBeforeThisTurn,
          createdAt,
          updatedAt: questionedAt,
          turnCount: turn,
          cwd,
          cumulativeCostUsd: totalCostUsd,
          pendingApproval: {
            toolCallId: capturedPendingApproval.toolCallId,
            toolName: capturedPendingApproval.toolName,
            input: capturedPendingApproval.input,
            assistantMessage: assistantMsg,
            toolCalls: response.toolCalls,
            questionedAt,
          },
        }).catch((err: unknown) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[orager] WARNING: session save failed (tool-approval) for ${sessionId}: ${errMsg}\n`);
        onEmit({ type: "warn", message: "session_save_failed_tool_approval: " + errMsg });
      });

        // End the run — emit result with success subtype so session is preserved
        {
          const resultEvent = {
            type: "result" as const,
            subtype: "success" as const,
            result: `[awaiting approval for ${capturedPendingApproval.toolName}]`,
            session_id: sessionId,
            finish_reason: "approval_required",
            usage: {
              input_tokens: cumulativeUsage.prompt_tokens,
              output_tokens: cumulativeUsage.completion_tokens,
              cache_read_input_tokens: cumulativeCachedTokens,
              cache_write_tokens: cumulativeCacheWriteTokens,
            },
            total_cost_usd: totalCostUsd,
          cost_breakdown: costBreakdown(),
            turnCount: turn,
            toolMetrics: Object.fromEntries(toolMetrics),
            filesChanged: opts.trackFileChanges ? Array.from(filesChanged) : undefined,
          };
          await emitResult(resultEvent);
        }
        return; // Exit the agent loop
      }
      // Reset for next turn
      pendingApprovalRequest = null;

      // ── Finish tool detection ─────────────────────────────────────────────
      if (opts.useFinishTool) {
        const finishCallId = response.toolCalls.find(
          (tc) => tc.function.name === FINISH_TOOL_NAME,
        )?.id;
        if (finishCallId) {
          const finishResult = toolResults.find((r) => r.id === finishCallId);
          if (finishResult && !finishResult.isError) {
            lastAssistantText = finishResult.content || lastAssistantText;
          }
          break;
        }
      }

      // ── Session summarization check ───────────────────────────────────────
      const tokenCount = await estimateTokens(messages, lastResponseModel);
      const overTokenThreshold = summarizeAt > 0 && tokenCount > contextWindow * summarizeAt;
      const overMessageCap = messages.length > MAX_SESSION_MESSAGES;

      // Skip summarization if the last attempt failed within SUMMARIZE_COOLDOWN_TURNS turns.
      // This prevents repeated expensive API calls when the summarize model is unavailable.
      const summarizeCoolingDown = turn - summarizeFailedAtTurn <= SUMMARIZE_COOLDOWN_TURNS;

      if ((overTokenThreshold || overMessageCap) && !summarizeCoolingDown) {
        const reason = overMessageCap
          ? `message count (${messages.length}) exceeded hard cap (${MAX_SESSION_MESSAGES})`
          : `token estimate (${tokenCount}) exceeds ${Math.round(summarizeAt * 100)}% of context window`;
        onLog?.("stderr", `[orager] ${reason} — summarizing session...\n`);
        try {
          // Selective summarization: keep the last N assistant turns intact.
          // Find the index to split at: walk backwards counting assistant turns.
          let keepFromIndex = 0; // by default summarize everything
          if (summarizeKeepRecentTurns > 0) {
            let assistantCount = 0;
            for (let i = messages.length - 1; i >= 0; i--) {
              if (messages[i].role === "assistant") {
                assistantCount++;
                if (assistantCount >= summarizeKeepRecentTurns) {
                  keepFromIndex = i;
                  break;
                }
              }
            }
          }

          const messagesToSummarize = keepFromIndex > 0 ? messages.slice(0, keepFromIndex) : messages;
          const messagesToKeep = keepFromIndex > 0 ? messages.slice(keepFromIndex) : [];

          const summary = await summarizeSession(messagesToSummarize, apiKey, model, summarizeModel, opts.summarizePrompt);
          const systemMsg = messages[0]?.role === "system" ? messages[0] : null;
          const compacted: Message[] = [
            ...(systemMsg ? [systemMsg] : []),
            { role: "user" as const, content: `[Session summary — prior context compacted]\n${summary}` },
            ...messagesToKeep,
          ];
          messages = compacted;
          onLog?.("stderr", keepFromIndex > 0
            ? `[orager] session summarized (kept last ${summarizeKeepRecentTurns} turns).\n`
            : "[orager] session summarized and compacted.\n"
          );
          await saveSession({
            sessionId,
            model: lastResponseModel,
            messages,
            createdAt,
            updatedAt: new Date().toISOString(),
            turnCount: turn,
            cwd,
            summarized: true,
            cumulativeCostUsd: totalCostUsd,
          }).catch((err: unknown) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[orager] WARNING: session save failed (post-summarize) for ${sessionId}: ${errMsg}\n`);
        onEmit({ type: "warn", message: "session_save_failed_post_summarize: " + errMsg });
      });
        } catch (summarizeErr) {
          const msg = summarizeErr instanceof Error ? summarizeErr.message : String(summarizeErr);
          onLog?.("stderr", `[orager] summarization failed (will retry in ${SUMMARIZE_COOLDOWN_TURNS} turns): ${msg}\n`);
          summarizeFailedAtTurn = turn;
        }
      } else if ((overTokenThreshold || overMessageCap) && summarizeCoolingDown) {
        const keepN = opts.summarizeFallbackKeep ?? 40;
        const dropped = messages.length - keepN - (messages[0]?.role === "system" ? 1 : 0);
        onLog?.("stderr", `[orager] WARNING: summarization cooling down — discarding ${dropped > 0 ? dropped : "some"} messages to fit context (keeping last ${keepN}; ${SUMMARIZE_COOLDOWN_TURNS - (turn - summarizeFailedAtTurn)} turns until retry)\n`);
        const systemMsg = messages[0]?.role === "system" ? messages[0] : null;
        const recent = messages.slice(-keepN);
        messages = systemMsg ? [systemMsg, ...recent] : recent;
      }

      // ── Soft cost limit warning ────────────────────────────────────────────
      if (
        opts.maxCostUsdSoft !== undefined &&
        totalCostUsd >= opts.maxCostUsdSoft &&
        (opts.maxCostUsd === undefined || totalCostUsd < opts.maxCostUsd)
      ) {
        onLog?.(
          "stderr",
          `[orager] soft cost limit reached ($${totalCostUsd.toFixed(4)} >= $${opts.maxCostUsdSoft}) — stopping agent loop\n`,
        );
        log.warn("cost_soft_limit_exceeded", {
          sessionId,
          totalCostUsd,
          softLimit: opts.maxCostUsdSoft,
          hardLimit: opts.maxCostUsd,
        });
        break; // exit the turn loop
      }

      // ── Cost limit check ──────────────────────────────────────────────────
      if (opts.maxCostUsd !== undefined && totalCostUsd >= opts.maxCostUsd) {
        onLog?.(
          "stderr",
          `[orager] cost limit reached ($${totalCostUsd.toFixed(6)} >= $${opts.maxCostUsd}) — stopping\n`,
        );

        await saveSession({
          sessionId,
          model: lastResponseModel,
          messages,
          createdAt,
          updatedAt: new Date().toISOString(),
          turnCount: turn,
          cwd,
          cumulativeCostUsd: totalCostUsd,
        }).catch((err: unknown) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[orager] WARNING: session save failed (turn-end) for ${sessionId}: ${errMsg}\n`);
        onEmit({ type: "warn", message: "session_save_failed_turn_end: " + errMsg });
      });

        {
          const resultEvent = {
            type: "result" as const,
            subtype: "error_max_cost" as const,
            result: lastAssistantText,
            session_id: sessionId,
            finish_reason: lastFinishReason,
            usage: {
              input_tokens: cumulativeUsage.prompt_tokens,
              output_tokens: cumulativeUsage.completion_tokens,
              cache_read_input_tokens: cumulativeCachedTokens,
              cache_write_tokens: cumulativeCacheWriteTokens,
            },
            total_cost_usd: totalCostUsd,
          cost_breakdown: costBreakdown(),
            turnCount: turn,
            toolMetrics: Object.fromEntries(toolMetrics),
            filesChanged: opts.trackFileChanges ? Array.from(filesChanged) : undefined,
          };
          await emitResult(resultEvent);
        }
        return;
      }

      log.info("turn_complete", {
        sessionId,
        model: lastResponseModel,
        turn,
        promptTokens: cumulativeUsage.prompt_tokens,
        completionTokens: cumulativeUsage.completion_tokens,
        cachedInputTokens: cumulativeCachedTokens || undefined,
        cacheWriteInputTokens: cumulativeCacheWriteTokens || undefined,
        totalCostUsd,
      });
      turn++;
    }

    // ── 6. After loop ─────────────────────────────────────────────────────
    const subtype = loopAborted
      ? ("error_loop_abort" as const)
      : (maxTurns > 0 && turn >= maxTurns ? "error_max_turns" : "success") as "error_max_turns" | "success";

    // Best-effort session save — a write failure should not turn a successful run into an error
    try {
      await saveSession({
        sessionId,
        model: lastResponseModel,
        messages,
        createdAt,
        updatedAt: new Date().toISOString(),
        turnCount: turn,
        cwd,
        cumulativeCostUsd: totalCostUsd,
      });
    } catch (saveErr) {
      const saveErrMsg = saveErr instanceof Error ? saveErr.message : String(saveErr);
      onLog?.("stderr", `[orager] WARNING: session save failed — session may not be resumable: ${saveErrMsg}\n`);
      log.warn("session_save_failed", { sessionId, error: saveErrMsg });
    }

    spanSetAttributes({ "orager.turns": turn, "orager.cost_usd": totalCostUsd });
    log.info("loop_done", {
      sessionId,
      model: lastResponseModel,
      subtype,
      turns: turn,
      totalCostUsd,
      totalTokens: cumulativeUsage.total_tokens,
    });
    {
      const resultEvent = {
        type: "result" as const,
        subtype,
        result: lastAssistantText,
        session_id: sessionId,
        finish_reason: lastFinishReason,
        usage: {
          input_tokens: cumulativeUsage.prompt_tokens,
          output_tokens: cumulativeUsage.completion_tokens,
          cache_read_input_tokens: cumulativeCachedTokens,
          cache_write_tokens: cumulativeCacheWriteTokens,
        },
        total_cost_usd: totalCostUsd,
        cost_breakdown: costBreakdown(),
        turnCount: turn,
        toolMetrics: Object.fromEntries(toolMetrics),
        filesChanged: opts.trackFileChanges ? Array.from(filesChanged) : undefined,
      };
      await emitResult(resultEvent);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    circuitBreaker.recordFailure();

    // Best-effort session save
    try {
      await saveSession({
        sessionId,
        model: lastResponseModel,
        messages,
        createdAt,
        updatedAt: new Date().toISOString(),
        turnCount: turn,
        cwd,
        cumulativeCostUsd: totalCostUsd,
      });
    } catch {
      // ignore save failure during error handling
    }

    log.error("loop_error", {
      sessionId,
      model: lastResponseModel,
      error: message,
      turns: turn,
      totalCostUsd,
    });
    {
      const resultEvent = {
        type: "result" as const,
        subtype: "error" as const,
        result: message,
        session_id: sessionId,
        finish_reason: lastFinishReason,
        usage: {
          input_tokens: cumulativeUsage.prompt_tokens,
          output_tokens: cumulativeUsage.completion_tokens,
          cache_read_input_tokens: cumulativeCachedTokens,
          cache_write_tokens: cumulativeCacheWriteTokens,
        },
        total_cost_usd: totalCostUsd,
        cost_breakdown: costBreakdown(),
        turnCount: turn,
        toolMetrics: Object.fromEntries(toolMetrics),
        filesChanged: opts.trackFileChanges ? Array.from(filesChanged) : undefined,
      };
      await emitResult(resultEvent);
    }
  } finally {
    // ── Guaranteed session save on any exit path ──────────────────────────
    // Only triggers when no result event was emitted by the normal paths.
    // The individual paths (normal completion, abort check, cost-limit, caught
    // error) all call saveSession and emit a result. The finally block fires as
    // a safety net for unexpected early exits (e.g. throw mid-tool that somehow
    // bypasses the catch block) where neither a save nor a result event occurred.
    if (!_resultEmitted) {
      try {
        await saveSession({
          sessionId,
          model: lastResponseModel,
          messages,
          createdAt,
          updatedAt: new Date().toISOString(),
          turnCount: turn,
          cwd,
          cumulativeCostUsd: totalCostUsd,
        });
      } catch (finalSaveErr) {
        const fsMsg = finalSaveErr instanceof Error ? finalSaveErr.message : String(finalSaveErr);
        process.stderr.write(`[orager] WARNING: finally-block session save failed for ${sessionId}: ${fsMsg}\n`);
      }
      const aborted = _effectiveAbortSignal?.aborted ?? false;
      const fallbackEvent = {
        type: "result" as const,
        subtype: (aborted ? "error_cancelled" : "error") as "error_cancelled" | "error",
        result: aborted ? "Run was aborted" : "Run ended unexpectedly",
        session_id: sessionId,
        finish_reason: null,
        usage: {
          input_tokens: cumulativeUsage.prompt_tokens,
          output_tokens: cumulativeUsage.completion_tokens,
          cache_read_input_tokens: cumulativeCachedTokens,
          cache_write_tokens: cumulativeCacheWriteTokens,
        },
        total_cost_usd: totalCostUsd,
        cost_breakdown: costBreakdown(),
        turnCount: turn,
        toolMetrics: Object.fromEntries(toolMetrics),
        filesChanged: opts.trackFileChanges ? Array.from(filesChanged) : undefined,
      };
      try { _rawOnEmit(fallbackEvent); } catch { /* non-fatal */ }
    }
    // ── SessionStop hook and MCP cleanup ─────────────────────────────────
    if (effectiveOpts.hooks?.SessionStop) {
      await fireHooks("SessionStop", effectiveOpts.hooks.SessionStop, { event: "SessionStop", sessionId, ts: new Date().toISOString() }, _hookOpts, (msg) => onLog?.("stderr", msg));
      // Note: hookErrorMode "fail" not enforced in SessionStop — already in cleanup
    }
    for (const h of mcpHandles) await h.close();
    await releaseLock?.();
    toolResultCache.clear(); // prevent cross-session stale cache hits
  }
  }); // end withSpan("agent_loop")
}
