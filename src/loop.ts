import type {
  AgentLoopOptions,
  AssistantMessage,
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
import { loadMemoryStore, pruneExpired, renderMemoryBlock, renderRetrievedBlock, retrieveEntries, memoryKeyFromCwd } from "./memory.js";
import { runHook } from "./hooks.js";
import type { HookConfig } from "./hooks.js";
import { loadSettings, mergeSettings, loadClaudeDesktopMcpServers } from "./settings.js";
import { exitPlanModeTool, PLAN_MODE_TOOL_NAME } from "./tools/plan.js";
import path from "node:path";
import { loadSession, saveSession, newSessionId, acquireSessionLock } from "./session.js";
import { callWithRetry } from "./retry.js";
import { fetchGenerationMeta, shouldUseDirect } from "./openrouter.js";
import { fetchLiveModelMeta, getLiveModelPricing, isLiveModelMetaCacheWarm, liveModelSupportsTools } from "./openrouter-model-meta.js";
import { recordProviderSuccess } from "./provider-health.js";
import { loadSkillsFromDirs, buildSkillsSystemPrompt, buildSkillTools } from "./skills.js";
import { ALL_TOOLS, finishTool, BROWSER_TOOLS } from "./tools/index.js";
import { FINISH_TOOL_NAME } from "./tools/finish.js";
import { promptApproval } from "./approval.js";
import { CircuitBreaker, openRouterCircuitBreaker as _openRouterCircuitBreakerSingleton } from "./circuit-breaker.js";
import { log } from "./logger.js";
import { auditApproval } from "./audit.js";
import { truncateContent } from "./truncate.js";
import { checkDeprecatedModel } from "./deprecated-models.js";
import { getModelCapabilities } from "./model-capabilities.js";
import { withSpan, spanSetAttributes } from "./telemetry.js";
import { isNearRateLimit, rateLimitSummary, getRateLimitState } from "./rate-limit-tracker.js";
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

export async function runAgentLoop(opts: AgentLoopOptions): Promise<void> {
  const {
    prompt,
    model,
    apiKey,
    addDirs,
    maxTurns,
    cwd,
    verbose: _verbose,
    onEmit,
    onLog,
  } = opts;

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

  // Per-run circuit breaker — isolates circuit state between daemon runs so one
  // agent's failure streak doesn't block all subsequent runs in the same process.
  const circuitBreaker = new CircuitBreaker({ threshold: 3, resetAfterMs: 30_000 });

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
      releaseLock = await acquireSessionLock(opts.sessionId);
    } catch (lockErr) {
      const msg = lockErr instanceof Error ? lockErr.message : String(lockErr);
      onLog?.("stderr", `[orager] could not acquire session lock: ${msg}\n`);
      // Non-fatal: proceed without lock (better than blocking indefinitely)
    }
    const existing = await loadSession(opts.sessionId);
    if (existing && (forceResume || existing.cwd === cwd)) {
      sessionId = existing.sessionId;
      messages = existing.messages;
      createdAt = existing.createdAt;
      isResume = true;
      pendingApproval = existing.pendingApproval ?? null;
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
    ...buildSkillTools(skills),
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
  // Use provided memoryKey, or derive a stable key from the cwd for standalone use
  const effectiveMemoryKey = (typeof opts.memoryKey === "string" && opts.memoryKey.trim())
    ? opts.memoryKey.trim()
    : memoryKeyFromCwd(cwd);
  if (memoryEnabled) {
    // Load + prune the store, inject into system prompt, and register the tool
    try {
      const memStore = pruneExpired(await loadMemoryStore(effectiveMemoryKey));
      const threshold = typeof opts.memoryRetrievalThreshold === "number"
        ? opts.memoryRetrievalThreshold
        : 15;
      const memBlock = memStore.entries.length <= threshold
        ? renderMemoryBlock(memStore, memoryMaxChars)
        : renderRetrievedBlock(
            retrieveEntries(memStore, prompt, { topK: 12 }),
            memoryMaxChars,
          );
      if (memBlock) {
        systemPrompt += "\n\n## Your persistent memory\n\n" + memBlock;
      }
    } catch { /* non-fatal — memory load failure must never abort a run */ }
    allTools.push(makeRememberTool(effectiveMemoryKey, memoryMaxChars));
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

        onLog?.("stderr", `[orager] spawning sub-agent${agentLabel} (depth ${currentSpawnDepth + 1}/${maxSpawnDepth}): ${subTask.slice(0, 100)}\n`);

        await runAgentLoop({
          ...opts,
          prompt: subTask,
          model: subModel,
          maxTurns: subMaxTurns,
          sessionId: null, // fresh session for each sub-agent
          _spawnDepth: currentSpawnDepth + 1,
          _parentSessionIds: [...parentSessionIds, ...(sessionId ? [sessionId] : [])],
          onEmit: (event) => {
            if (event.type === "result") {
              subResult = event.result ?? "";
              subTurns = event.turnCount ?? 0;
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

        return {
          toolCallId: "",
          content: `Sub-agent${agentLabel} completed in ${subTurns} turn(s):\n${subResult || "(no result text)"}`,
          isError: false,
        };
      },
    });
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
    const _hookOpts = { timeoutMs: effectiveOpts.hookTimeoutMs, errorMode: effectiveOpts.hookErrorMode };
    const _sr = await runHook("SessionStart", effectiveOpts.hooks.SessionStart, { sessionId }, (msg) => onLog?.("stderr", msg), _hookOpts);
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
  let totalCostUsd = 0;
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
          return { id: toolCall.id, content, isError };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
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
          return { id: toolCall.id, content: `Tool '${toolName}' was denied by the user`, isError: true };
        }
      }
    }

    // ── PreToolCall hook ──────────────────────────────────────────────────
    if (effectiveOpts.hooks?.PreToolCall) {
      const _hookOpts = { timeoutMs: effectiveOpts.hookTimeoutMs, errorMode: effectiveOpts.hookErrorMode };
      const _pr = await runHook("PreToolCall", effectiveOpts.hooks.PreToolCall, { sessionId, toolName, toolInput: parsedInput }, (msg) => onLog?.("stderr", msg), _hookOpts);
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
        try {
          const toolTimeoutMs = _effectiveToolTimeout(toolName);
          const result = toolTimeoutMs != null
            ? await Promise.race([
                executeFn(parsedInput, cwd, { sandboxRoot: opts.sandboxRoot, bashPolicy: effectiveOpts.bashPolicy, sessionId }),
                new Promise<never>((_, reject) =>
                  setTimeout(() => reject(new Error(`Tool '${toolName}' timed out after ${toolTimeoutMs}ms`)), toolTimeoutMs),
                ),
              ])
            : await executeFn(parsedInput, cwd, { sandboxRoot: opts.sandboxRoot, bashPolicy: effectiveOpts.bashPolicy, sessionId });
          if (readOnly && !result.isError) {
            // Store truncated content in cache — prevents untruncated hits from
            // exceeding context limits when consumed by the message assembly loop
            const MAX_TOOL_CACHE_CHARS = 50_000;
            setCached(cacheKey, { result: result.content.slice(0, MAX_TOOL_CACHE_CHARS), timestamp: Date.now() });
          } else if (!readOnly) {
            toolResultCache.clear();
          }
          metricIsError = result.isError;
          return { id: toolCall.id, content: result.content, isError: result.isError, imageUrl: result.imageUrl };
        } catch (err) {
          metricIsError = true;
          const msg = err instanceof Error ? err.message : String(err);
          return { id: toolCall.id, content: `Tool threw an unexpected error: ${msg}`, isError: true };
        } finally {
          const elapsed = Date.now() - metricStart;
          const m = toolMetrics.get(toolName) ?? { calls: 0, errors: 0, totalMs: 0 };
          m.calls++;
          if (metricIsError) m.errors++;
          m.totalMs += elapsed;
          toolMetrics.set(toolName, m);
        }
      },
    );

    // ── PostToolCall hook ─────────────────────────────────────────────────
    if (effectiveOpts.hooks?.PostToolCall) {
      const _hookOpts = { timeoutMs: effectiveOpts.hookTimeoutMs, errorMode: effectiveOpts.hookErrorMode };
      const _por = await runHook("PostToolCall", effectiveOpts.hooks.PostToolCall, { sessionId, toolName, toolInput: parsedInput, isError: toolResult.isError }, (msg) => onLog?.("stderr", msg), _hookOpts);
      if (!_por.ok && effectiveOpts.hookErrorMode === "fail") {
        return { id: toolCall.id, content: `PostToolCall hook failed: ${_por.error}`, isError: true };
      }
    }

    return toolResult;
  }

  await withSpan("agent_loop", { "orager.session_id": sessionId, "orager.model": model }, async (rootSpan) => {
  void rootSpan; // rootSpan available for attribute setting
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
      }).catch(() => {});

      const elapsedMs = pendingApproval.questionedAt
        ? Date.now() - new Date(pendingApproval.questionedAt).getTime()
        : null;
      const elapsedStr = elapsedMs !== null
        ? ` (waited ${elapsedMs < 60_000 ? `${Math.round(elapsedMs / 1000)}s` : `${Math.round(elapsedMs / 60_000)}m`})`
        : "";
      onLog?.("stderr", `[orager] approval resolved (${approved ? "approved" : "denied"})${elapsedStr} — resuming run\n`);
    }

    const firedOnce = new Set<number>();

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
        }).catch(() => {});
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
            turnCount: turn,
            toolMetrics: Object.fromEntries(toolMetrics),
            filesChanged: opts.trackFileChanges ? Array.from(filesChanged) : undefined,
          };
          onEmit(resultEvent);
          if (opts.webhookUrl) await postWebhook(opts.webhookUrl, resultEvent);
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
      if (isNearRateLimit()) {
        const rlState = getRateLimitState();
        const resetAt = rlState?.resetRequestsAt ?? rlState?.resetTokensAt;
        const waitMs = resetAt ? Math.max(0, resetAt.getTime() - Date.now()) : 0;
        if (waitMs > 0 && waitMs <= 60_000) {
          onLog?.("stderr", `[orager] near rate limit — waiting ${Math.ceil(waitMs / 1000)}s for reset (${rateLimitSummary()})\n`);
          log.warn("rate_limit_wait", { sessionId, waitMs, summary: rateLimitSummary() });
          await new Promise<void>((r) => setTimeout(r, waitMs));
        } else {
          onLog?.("stderr", `[orager] WARNING: approaching OpenRouter rate limit — ${rateLimitSummary()}\n`);
          log.warn("rate_limit_near", { sessionId, summary: rateLimitSummary() });
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
            turnCount: turn,
            toolMetrics: Object.fromEntries(toolMetrics),
            filesChanged: opts.trackFileChanges ? Array.from(filesChanged) : undefined,
          };
          onEmit(resultEvent);
          if (opts.webhookUrl) await postWebhook(opts.webhookUrl, resultEvent);
        }
        return;
      }

      // Track whether any text_delta / thinking_delta events were emitted for
      // this turn so the downstream assistant event can set streamed: true and
      // consumers can skip re-rendering already-streamed text.
      let turnWasStreamed = false;
      const response = await withSpan(
        "llm_turn",
        { "orager.turn": turn, "orager.model": turnOverrides.model ?? model },
        async () => callWithRetry(
        {
          apiKey,
          apiKeys: opts.apiKeys,
          model: turnOverrides.model ?? model,
          models: opts.models,
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
          response_format: opts.response_format,
          disableContextCompression: summarizeAt > 0,
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
        totalCostUsd += inputCost * response.usage.prompt_tokens + outputCost * response.usage.completion_tokens;
        totalCostUsd = Math.round(totalCostUsd * 1e8) / 1e8;
      }

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
        }).catch(() => {});
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
        }).catch(() => {});
        onEmit(budgetResultEvent);
        if (opts.webhookUrl) await postWebhook(opts.webhookUrl, budgetResultEvent);
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
          pendingApproval: {
            toolCallId: capturedPendingApproval.toolCallId,
            toolName: capturedPendingApproval.toolName,
            input: capturedPendingApproval.input,
            assistantMessage: assistantMsg,
            toolCalls: response.toolCalls,
            questionedAt,
          },
        }).catch(() => {});

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
            turnCount: turn,
            toolMetrics: Object.fromEntries(toolMetrics),
            filesChanged: opts.trackFileChanges ? Array.from(filesChanged) : undefined,
          };
          onEmit(resultEvent);
          if (opts.webhookUrl) await postWebhook(opts.webhookUrl, resultEvent);
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
          }).catch(() => {});
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
        }).catch(() => {});

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
            turnCount: turn,
            toolMetrics: Object.fromEntries(toolMetrics),
            filesChanged: opts.trackFileChanges ? Array.from(filesChanged) : undefined,
          };
          onEmit(resultEvent);
          if (opts.webhookUrl) await postWebhook(opts.webhookUrl, resultEvent);
        }
        return;
      }

      log.info("turn_complete", {
        sessionId,
        model: lastResponseModel,
        turn,
        promptTokens: cumulativeUsage.prompt_tokens,
        completionTokens: cumulativeUsage.completion_tokens,
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
        turnCount: turn,
        toolMetrics: Object.fromEntries(toolMetrics),
        filesChanged: opts.trackFileChanges ? Array.from(filesChanged) : undefined,
      };
      onEmit(resultEvent);
      if (opts.webhookUrl) await postWebhook(opts.webhookUrl, resultEvent);
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
        turnCount: turn,
        toolMetrics: Object.fromEntries(toolMetrics),
        filesChanged: opts.trackFileChanges ? Array.from(filesChanged) : undefined,
      };
      onEmit(resultEvent);
      if (opts.webhookUrl) await postWebhook(opts.webhookUrl, resultEvent);
    }
  } finally {
    // ── SessionStop hook and MCP cleanup ─────────────────────────────────
    if (effectiveOpts.hooks?.SessionStop) {
      const _hookOpts = { timeoutMs: effectiveOpts.hookTimeoutMs, errorMode: effectiveOpts.hookErrorMode };
      await runHook("SessionStop", effectiveOpts.hooks.SessionStop, { sessionId }, (msg) => onLog?.("stderr", msg), _hookOpts);
      // Note: hookErrorMode "fail" not enforced in SessionStop — already in cleanup
    }
    for (const h of mcpHandles) await h.close();
    await releaseLock?.();
  }
  }); // end withSpan("agent_loop")
}
