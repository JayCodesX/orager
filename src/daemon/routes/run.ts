/**
 * POST /run — execute an agent loop and stream NDJSON events back.
 *
 * Security properties enforced here:
 * - JWT verification (dual-key for key-rotation overlap)
 * - Per-agent concurrency limit
 * - Global concurrency limit
 * - Request body size cap (4 MB)
 * - allowedCwdPrefixes sandbox enforcement (symlink-safe realpath check)
 * - opts allowlist via sanitizeDaemonRunOpts
 * - Per-request timeout with clean abort
 * - Circuit breaker per agent
 */
import http from "node:http";
import fs from "node:fs/promises";
import { runAgentLoop } from "../../loop.js";
import { verifyJwtDualKey } from "../context.js";
import { auditLog } from "../lifecycle.js";
import { sanitizeDaemonRunOpts } from "../sanitize.js";
import { getAgentCircuitBreaker } from "../../circuit-breaker.js";
import type { EmitEvent, AgentLoopOptions } from "../../types.js";
import type { DaemonContext } from "../context.js";

const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024; // 4 MB

export function handleRun(
  ctx: DaemonContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const startTime = Date.now();
  let agentId = "unknown";

  // ── Drain check ────────────────────────────────────────────────────────────
  if (ctx.draining) {
    res.writeHead(503, { "Retry-After": "5" });
    res.end(JSON.stringify({ error: "daemon shutting down" }));
    return;
  }

  // ── JWT verification ───────────────────────────────────────────────────────
  const authHeader = req.headers["authorization"] ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) { res.writeHead(401); res.end(); return; }
  let claims: { agentId: string };
  try {
    claims = verifyJwtDualKey(ctx, token);
    agentId = claims.agentId;
  } catch {
    res.writeHead(401); res.end(); return;
  }

  // ── Per-agent concurrency gate ────────────────────────────────────────────
  const agentSlots = ctx.activeRunsByAgent.get(agentId) ?? 0;
  if (agentSlots >= ctx.perAgentMaxConcurrent) {
    res.writeHead(429, { "Retry-After": "10" });
    res.end(JSON.stringify({
      error: `per-agent concurrency limit (${ctx.perAgentMaxConcurrent}) exceeded`,
    }));
    auditLog({ timestamp: new Date().toISOString(), agentId, durationMs: 0, status: "rejected", statusCode: 429 });
    return;
  }

  // ── Global concurrency gate ────────────────────────────────────────────────
  if (ctx.activeRuns >= ctx.maxConcurrent) {
    res.writeHead(503, { "Retry-After": "5" });
    res.end(JSON.stringify({ error: "max concurrent runs exceeded" }));
    auditLog({ timestamp: new Date().toISOString(), agentId, durationMs: 0, status: "rejected", statusCode: 503 });
    return;
  }

  // ── Reserve concurrency slot immediately (audit B-20) ──────────────────────
  // Increment counters before async body parsing to prevent concurrent requests
  // from racing past the concurrency check during the parse window.
  ctx.activeRuns++;
  ctx.activeRunsByAgent.set(agentId, (ctx.activeRunsByAgent.get(agentId) ?? 0) + 1);

  // Single cleanup flag prevents double-decrement (audit B-21)
  let slotReleased = false;
  function releaseSlot() {
    if (slotReleased) return;
    slotReleased = true;
    ctx.activeRuns--;
    const cur = ctx.activeRunsByAgent.get(agentId) ?? 1;
    if (cur <= 1) ctx.activeRunsByAgent.delete(agentId);
    else ctx.activeRunsByAgent.set(agentId, cur - 1);
  }

  // ── Parse body ──────────────────────────────────────────────────────────────
  let body = "";
  let bodySize = 0;
  let bodyTooLarge = false;

  req.on("data", (chunk: Buffer) => {
    bodySize += chunk.length;
    if (bodySize > MAX_REQUEST_BODY_BYTES) {
      bodyTooLarge = true;
      req.destroy();
      return;
    }
    body += chunk.toString();
  });

  req.on("end", () => { void (async () => {
    if (bodyTooLarge) {
      releaseSlot();
      if (!res.destroyed) {
        res.writeHead(413);
        res.end(JSON.stringify({ error: "request body too large (max 4 MB)" }));
      }
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let runReq: { prompt: string; promptContent?: unknown[]; opts: Record<string, unknown> };
    try {
      runReq = JSON.parse(body) as typeof runReq;
    } catch {
      releaseSlot();
      res.writeHead(400);
      res.end(JSON.stringify({ error: "invalid JSON body" }));
      return;
    }

    if (!runReq.prompt?.trim()) {
      releaseSlot();
      res.writeHead(400);
      res.end(JSON.stringify({ error: "prompt is required" }));
      return;
    }

    // ── Sandbox root enforcement ──────────────────────────────────────────────
    if (ctx.allowedCwdPrefixes && ctx.allowedCwdPrefixes.length > 0) {
      const reqCwd = (runReq.opts?.cwd as string | undefined) ?? "";
      let canonicalCwd = reqCwd;
      try {
        canonicalCwd = await fs.realpath(reqCwd);
      } catch {
        canonicalCwd = reqCwd;
      }
      const allowed = ctx.allowedCwdPrefixes.some(
        (prefix) => canonicalCwd === prefix || canonicalCwd.startsWith(prefix + "/"),
      );
      if (!allowed) {
        releaseSlot();
        res.writeHead(403);
        res.end(JSON.stringify({ error: `cwd '${reqCwd}' is not within an allowed prefix` }));
        auditLog({ timestamp: new Date().toISOString(), agentId, durationMs: 0, status: "rejected", statusCode: 403 });
        return;
      }
    }

    // ── Circuit breaker (before counter increment and writeHead) ─────────────
    // Must run here — after body is parsed (needs runReq.opts.model) but before
    // ctx.activeRuns++ and res.writeHead(200), so a rejection doesn't leak
    // run counters or produce a 503 over an already-started 200 stream.
    const isDirectPath =
      typeof runReq.opts?.model === "string" &&
      runReq.opts.model.startsWith("anthropic/") &&
      !!process.env.ANTHROPIC_API_KEY?.trim();
    const agentCb = getAgentCircuitBreaker(agentId);
    if (!isDirectPath && agentCb.isOpen()) {
      releaseSlot();
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        type: "result",
        subtype: "error_circuit_open",
        result: "OpenRouter API circuit breaker is open due to sustained failures. Retry in " +
          Math.ceil(agentCb.retryInMs / 1000) + "s.",
        session_id: "",
        turn_count: 0,
        total_cost_usd: 0,
        exit_code: 1,
      }));
      return;
    }

    // Track which models are being used for multi-model keep-alive.
    // Cap at 500 entries to prevent unbounded growth on long-running daemons:
    // evict the least-recently-used model when the cap is reached.
    if (runReq.opts?.model && typeof runReq.opts.model === "string") {
      const MODEL_TRACKING_CAP = 500;
      if (!ctx.modelLastUsedAt.has(runReq.opts.model) && ctx.modelLastUsedAt.size >= MODEL_TRACKING_CAP) {
        // Find and remove the oldest entry (Map preserves insertion order;
        // the first key is the one that was set least recently relative to
        // insertion, but we want actual LRU so scan for the lowest timestamp).
        let oldestModel: string | undefined;
        let oldestTime = Infinity;
        for (const [m, t] of ctx.modelLastUsedAt) {
          if (t < oldestTime) { oldestTime = t; oldestModel = m; }
        }
        if (oldestModel !== undefined) {
          ctx.modelLastUsedAt.delete(oldestModel);
          ctx.usedModels.delete(oldestModel);
        }
      }
      ctx.usedModels.add(runReq.opts.model);
      ctx.modelLastUsedAt.set(runReq.opts.model, Date.now());
    }
    ctx.lastRealRequestAt = Date.now();

    if (ctx.activeRuns >= ctx.maxConcurrent) {
      process.stderr.write(
        `[orager daemon] warning: at max concurrent runs (${ctx.activeRuns}/${ctx.maxConcurrent})\n`,
      );
    }
    // ── Per-request timeout + cancellation ────────────────────────────────────
    const runId = crypto.randomUUID();

    res.writeHead(200, {
      "Content-Type": "application/x-ndjson",
      "Transfer-Encoding": "chunked",
      "Cache-Control": "no-cache",
      "X-Orager-Run-Id": runId,
    });
    const abortController = new AbortController();
    ctx.activeRunControllers.set(runId, abortController);

    res.on("close", () => {
      if (!timedOut) abortController.abort();
    });

    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      abortController.abort();
      res.write(
        JSON.stringify({
          type: "result", subtype: "error", result: "Request timed out",
          session_id: "", finish_reason: null,
          usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
          total_cost_usd: 0,
        }) + "\n",
      );
      res.end();
      releaseSlot();
      auditLog({ timestamp: new Date().toISOString(), agentId, durationMs: Date.now() - startTime, status: "timeout", statusCode: 200 });
    }, ctx.requestTimeoutMs);

    // ── Build loop opts ────────────────────────────────────────────────────────
    const { safe: safeOpts, rejected: rejectedOpts } = sanitizeDaemonRunOpts(runReq.opts);
    if ((rejectedOpts as string[]).includes("settingsFile")) {
      const sfMsg =
        "[orager daemon] NOTE: settingsFile is not forwarded to the daemon — " +
        "the daemon always uses its own local settings (ORAGER_SETTINGS_FILE or ~/.orager/settings.json). " +
        "Remove settingsFile from daemonOpts to suppress this message.";
      process.stderr.write(sfMsg + "\n");
      res.write(JSON.stringify({ type: "info", message: sfMsg, field: "settingsFile" }) + "\n");
    }
    if (rejectedOpts.length > 0) {
      const msg = `[orager daemon] WARNING: ignoring disallowed opts fields from caller: ${rejectedOpts.join(", ")}`;
      process.stderr.write(msg + "\n");
      res.write(JSON.stringify({ type: "warn", subtype: "dropped_opts", message: msg, dropped_opts: rejectedOpts }) + "\n");
    }

    const loopOpts: AgentLoopOptions = {
      dangerouslySkipPermissions: false,
      verbose: false,
      ...safeOpts,
      prompt: runReq.prompt,
      promptContent: (() => {
        if (!Array.isArray(runReq.promptContent)) return undefined;
        const validated = (runReq.promptContent as unknown[]).filter((item): item is { type: string } => {
          if (!item || typeof item !== "object") return false;
          const t = (item as Record<string, unknown>).type;
          return t === "text" || t === "image_url";
        });
        return validated.length > 0 ? validated as AgentLoopOptions["promptContent"] : undefined;
      })(),
      apiKey: ctx.apiKey,
      abortSignal: abortController.signal,
      onEmit: (event: EmitEvent) => {
        if (!timedOut && !res.destroyed) res.write(JSON.stringify(event) + "\n");
      },
      onLog: (stream, chunk) => {
        if (stream === "stderr") process.stderr.write(chunk);
      },
    } as AgentLoopOptions;

    // ── Execute ────────────────────────────────────────────────────────────────
    let _runFailed = false;
    runAgentLoop(loopOpts)
      .catch((err: unknown) => {
        _runFailed = true;
        if (!isDirectPath) agentCb.recordFailure();
        const msg = err instanceof Error ? err.message : String(err);
        if (!timedOut && !res.destroyed) {
          res.write(
            JSON.stringify({
              type: "result", subtype: "error", result: msg,
              session_id: "", finish_reason: null,
              usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
              total_cost_usd: 0,
            }) + "\n",
          );
        }
        ctx.errorRuns++;
      })
      .finally(() => {
        if (!_runFailed && !isDirectPath) agentCb.recordSuccess();
        ctx.activeRunControllers.delete(runId);
        if (!timedOut) {
          clearTimeout(timeoutHandle);
          if (!res.destroyed) res.end();
          auditLog({ timestamp: new Date().toISOString(), agentId, durationMs: Date.now() - startTime, status: "ok", statusCode: 200 });
          releaseSlot();
        }
        ctx.completedRuns++;
      });
  })(); });

  req.on("error", () => {
    releaseSlot();
    res.destroy();
  });
}
