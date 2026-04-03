/**
 * Tool executor extracted from runAgentLoop (Sprint 6 decomposition).
 *
 * Handles a single tool call end-to-end: cache lookup, file-change tracking,
 * delegated-tool forwarding, approval check, pre/post hooks, and execution with
 * timeout + OTel span + metrics.
 *
 * The ToolExecCtx passes all closure state that was previously captured inline
 * inside runAgentLoop, making the dependencies explicit and the function testable
 * in isolation.
 */

import type { AgentLoopOptions, ToolCall, ToolMetric } from "./types.js";
import type { ToolExecutor } from "./types.js";
import type { CacheEntry } from "./loop-helpers.js";
import { CACHE_TTL_MS } from "./loop-helpers.js";
import { PLAN_MODE_TOOL_NAME, exitPlanModeTool } from "./tools/plan.js";
import { auditApproval, logToolCall } from "./audit.js";
import { promptApproval } from "./approval.js";
import { withSpan } from "./telemetry.js";
import { recordToolCall } from "./metrics.js";
import { fireHooks } from "./hooks.js";
import path from "node:path";

// ── Context passed to executeOne ──────────────────────────────────────────────

/**
 * All closure state required by executeOne, passed explicitly so the function
 * can live outside runAgentLoop without losing access to shared mutable objects.
 */
export interface ToolExecCtx {
  /** Full tool list for this run (built during setup). */
  allTools: ToolExecutor[];
  /** Original caller opts (before settings merge). */
  opts: AgentLoopOptions;
  /** Caller opts merged with settings.json overrides. */
  effectiveOpts: AgentLoopOptions;
  /** Working directory for the run. */
  cwd: string;
  /** Resolved session ID for audit log entries. */
  sessionId: string;
  /** Accumulates absolute paths of files written/edited during this run. */
  filesChanged: Set<string>;
  /** Per-run read-only tool result cache (never persisted). */
  toolResultCache: Map<string, CacheEntry>;
  /** FIFO-capped cache writer (handles eviction on overflow). */
  setCached: (key: string, val: CacheEntry) => void;
  /** Per-tool call metrics accumulated across all turns. */
  toolMetrics: Map<string, ToolMetric>;
  /** Hook call options (timeout + error mode). */
  _hookOpts: { timeoutMs?: number; errorMode?: "ignore" | "warn" | "fail" };
  /** Per-tool effective timeout, capped by remaining run budget. */
  _effectiveToolTimeout: (toolName: string) => number | undefined;
  /** Log callback (stdout/stderr for warnings/errors). */
  onLog?: (stream: "stdout" | "stderr", chunk: string) => void;
}

// ── Result type ───────────────────────────────────────────────────────────────

export interface ToolExecResult {
  id: string;
  content: string;
  isError: boolean;
  imageUrl?: string;
  /** True when approval is deferred (approvalMode === "question"). */
  _approvalPending?: true;
  /**
   * Set when _approvalPending is true — the caller must persist this to
   * pendingApprovalRequest so the run can be resumed after approval.
   */
  _pendingApprovalRequest?: {
    toolCallId: string;
    toolName: string;
    input: Record<string, unknown>;
  };
}

// ── Main function ─────────────────────────────────────────────────────────────

/**
 * Execute a single tool call.
 *
 * @param toolCall    - The tool call from the LLM response.
 * @param ctx         - Shared run-level context (tools, session, caches, opts).
 * @param inPlanMode  - Whether plan mode is currently active (passed per-call
 *                      because it changes when exit_plan_mode fires).
 */
export async function executeOne(
  toolCall: ToolCall,
  ctx: ToolExecCtx,
  inPlanMode: boolean,
): Promise<ToolExecResult> {
  const { allTools, opts, effectiveOpts, cwd, sessionId, filesChanged,
    toolResultCache, setCached, toolMetrics, _hookOpts, _effectiveToolTimeout, onLog } = ctx;

  const toolName = toolCall.function.name;
  const executor = allTools.find((t) => t.definition.function.name === toolName)
    ?? (toolName === PLAN_MODE_TOOL_NAME ? exitPlanModeTool : undefined);

  if (!executor) {
    return { id: toolCall.id, content: `Unknown tool: ${toolName}`, isError: true };
  }

  // ── Plan mode enforcement ───────────────────────────────────────────────────
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

  // ── File change tracking ────────────────────────────────────────────────────
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

  // ── Tool result cache (read-only tools only) ────────────────────────────────
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

  // ── Delegated tool ──────────────────────────────────────────────────────────
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

  // ── Approval check ──────────────────────────────────────────────────────────
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
        auditApproval({
          ts: new Date().toISOString(),
          sessionId,
          toolName,
          inputSummary: parsedInput,
          decision: "approved", // will be resolved on resume
          mode: "question",
        });
        return {
          id: toolCall.id,
          content: "[approval pending]",
          isError: false,
          _approvalPending: true as const,
          _pendingApprovalRequest: { toolCallId: toolCall.id, toolName, input: parsedInput },
        };
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
        // ── ToolDenied hook ────────────────────────────────────────────────
        if (effectiveOpts.hooks?.ToolDenied) {
          await fireHooks("ToolDenied", effectiveOpts.hooks.ToolDenied, { event: "ToolDenied", sessionId, toolName, toolInput: parsedInput, ts: new Date().toISOString() }, _hookOpts, (msg) => onLog?.("stderr", msg));
        }
        return { id: toolCall.id, content: `Tool '${toolName}' was denied by the user`, isError: true };
      }
    }
  }

  // ── PreToolCall hook ────────────────────────────────────────────────────────
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
        // ── ToolTimeout hook ────────────────────────────────────────────────
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
        // ── OTel metrics: tool call counts ──────────────────────────────────
        recordToolCall(toolName, metricIsError);
        // ── Structured tool-call audit log ──────────────────────────────────
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

  // ── PostToolCall hook ───────────────────────────────────────────────────────
  if (effectiveOpts.hooks?.PostToolCall) {
    const _por = await fireHooks("PostToolCall", effectiveOpts.hooks.PostToolCall, { event: "PostToolCall", sessionId, toolName, toolInput: parsedInput, isError: toolResult.isError, ts: new Date().toISOString() }, _hookOpts, (msg) => onLog?.("stderr", msg));
    if (!_por.ok && effectiveOpts.hookErrorMode === "fail") {
      return { id: toolCall.id, content: `PostToolCall hook failed: ${_por.error}`, isError: true };
    }
  }

  return toolResult;
}
