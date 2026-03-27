/**
 * orager HTTP daemon — persistent server mode.
 *
 * Start with:  orager --serve [--port 3456] [--max-concurrent 3] [--idle-timeout 30m]
 *
 * The adapter sends a POST /run request (Authorization: Bearer <jwt>) and
 * receives a stream of newline-delimited JSON events (same format as CLI stdout).
 *
 * Security properties (non-negotiable):
 * - Bind to 127.0.0.1 only — never 0.0.0.0
 * - JWT verification on every /run request (HS256, 5-min TTL)
 * - Max concurrent runs enforced (503 if exceeded)
 * - Per-request timeout (default 5 min)
 * - Auto idle shutdown (default 30 min)
 * - Audit logs: timestamp + agentId + duration + status — never prompt/response content
 * - Signing key at ~/.orager/daemon.key (chmod 600), generated on first start
 *
 * Cache warmth (Phase 4):
 * - 4c: On startup, send a no-op 1-token request to pre-warm the LLM prompt cache
 * - 4e: Keep-alive ping every 4 minutes to maintain Anthropic cache warmth (TTL=5min)
 */

import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { runAgentLoop } from "./loop.js";
import { mintJwt, verifyJwt, loadOrCreateSigningKey, KEY_PATH } from "./jwt.js";
import { callOpenRouter } from "./openrouter.js";
import type { EmitEvent, AgentLoopOptions } from "./types.js";
import { ensureSessionsDirPermissions, pruneOldSessions, listSessions, searchSessions } from "./session.js";
import { getAllProviderStats, getDegradedProviders } from "./provider-health.js";
import { getRateLimitState } from "./rate-limit-tracker.js";
import { initTelemetry } from "./telemetry.js";
import { checkAndLogApiKeyHealth, fetchApiKeyInfo } from "./openrouter-key.js";
import type { ApiKeyInfo } from "./openrouter-key.js";
import { openRouterCircuitBreaker } from "./circuit-breaker.js";

// ── Port file ─────────────────────────────────────────────────────────────────
// Written on startup so clients (adapter) can discover the port without config.

const PORT_FILE = path.join(os.homedir(), ".orager", "daemon.port");
const PID_FILE = path.join(os.homedir(), ".orager", "daemon.pid");

// ── Cached API key info (for /metrics endpoint) ───────────────────────────────
let _cachedKeyInfo: { info: ApiKeyInfo | null; fetchedAt: number } | null = null;
const KEY_INFO_TTL_MS = 5 * 60 * 1000;

async function getCachedKeyInfo(apiKey: string): Promise<ApiKeyInfo | null> {
  const now = Date.now();
  if (_cachedKeyInfo && now - _cachedKeyInfo.fetchedAt < KEY_INFO_TTL_MS) {
    return _cachedKeyInfo.info;
  }
  const info = await fetchApiKeyInfo(apiKey).catch(() => null);
  _cachedKeyInfo = { info, fetchedAt: now };
  return info;
}

async function writePortFile(port: number): Promise<void> {
  await fs.mkdir(path.dirname(PORT_FILE), { recursive: true });
  await fs.writeFile(PORT_FILE, String(port), { encoding: "utf8", mode: 0o600 });
}

async function removePortFile(): Promise<void> {
  await fs.unlink(PORT_FILE).catch(() => {});
}

export async function readDaemonPort(): Promise<number | null> {
  try {
    const raw = await fs.readFile(PORT_FILE, "utf8");
    const n = parseInt(raw.trim(), 10);
    return isNaN(n) ? null : n;
  } catch {
    return null;
  }
}

/**
 * Write a PID lock file. If a live daemon process is already running (PID is
 * alive), throw a clear error. If the PID file exists but the PID is dead
 * (stale from a crash), overwrite it silently — this also handles fix #6
 * (stale port file cleanup).
 */
async function acquirePidLock(port: number): Promise<void> {
  const pidData = JSON.stringify({ pid: process.pid, port });

  // Ensure the directory exists before any file operations
  await fs.mkdir(path.dirname(PID_FILE), { recursive: true });

  // Try exclusive atomic write first — succeeds if no lock file exists
  try {
    await fs.writeFile(PID_FILE, pidData, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return; // Successfully acquired
  } catch (writeErr) {
    const code = (writeErr as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw writeErr; // Unexpected error
  }

  // File exists — check if the existing process is alive
  try {
    const existing = await fs.readFile(PID_FILE, "utf8");
    const parsed = JSON.parse(existing) as { pid: number; port: number };
    try {
      process.kill(parsed.pid, 0); // signal 0 = existence check
      throw new Error(
        `[orager daemon] already running (PID ${parsed.pid}, port ${parsed.port}). ` +
        `Stop it first with: kill ${parsed.pid}`
      );
    } catch (killErr) {
      const code = (killErr as NodeJS.ErrnoException).code;
      if (code === "EPERM") {
        throw new Error(
          `[orager daemon] appears to be running (PID ${parsed.pid}). Stop it first.`
        );
      }
      // ESRCH = process not found, or the error we threw above — if it's our own error, rethrow
      if ((killErr as Error).message?.includes("orager daemon")) throw killErr;
      // Stale lock — process is dead, remove and re-acquire atomically
    }
  } catch (readErr) {
    if ((readErr as Error).message?.includes("orager daemon")) throw readErr;
    // File is unreadable/malformed — treat as stale
  }

  // Remove stale lock and write exclusively
  await fs.unlink(PID_FILE).catch(() => {});
  try {
    await fs.writeFile(PID_FILE, pidData, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch {
    // Another process raced us — check again
    const existing2 = await fs.readFile(PID_FILE, "utf8").catch(() => "{}");
    const parsed2 = JSON.parse(existing2) as { pid?: number; port?: number };
    if (parsed2.pid && parsed2.pid !== process.pid) {
      throw new Error(
        `[orager daemon] race: another daemon started (PID ${parsed2.pid}). ` +
        `Only one daemon can run at a time.`
      );
    }
  }
}

async function releasePidLock(): Promise<void> {
  await fs.unlink(PID_FILE).catch(() => {});
}

// ── Daemon run request schema ─────────────────────────────────────────────────

export interface DaemonRunRequest {
  prompt: string;
  /** Structured multimodal content for the first user message (optional). */
  promptContent?: unknown[];
  /** Full AgentLoopOptions minus apiKey (key comes from env on daemon side). */
  opts: Omit<AgentLoopOptions, "apiKey" | "onEmit" | "onLog">;
}

/** Allowlist of AgentLoopOptions fields that callers are permitted to set via daemon /run. */
const ALLOWED_DAEMON_OPTS = new Set([
  "model", "models", "maxTurns", "prompt", "systemPrompt", "appendSystemPrompt",
  "cwd", "sessionId", "forceNewSession", "summarizeAt", "summarizeModel",
  "temperature", "top_p", "top_k", "seed", "stop", "maxTokens",
  "reasoning", "provider", "transforms", "preset", "site_url", "site_name",
  "profile", "planMode", "tagToolOutputs", "trackFileChanges",
  "maxIdenticalToolCallTurns", "webhookUrl", "useFinishTool",
  "enableBrowserTools", "parallel_tool_calls", "tool_choice",
  "response_format", "frequency_penalty", "presence_penalty",
  "repetition_penalty", "min_p", "maxCostUsdSoft",
  "addDirs", "maxRetries", "verbose", "forceResume", "approvalMode",
  "approvalAnswer", "approvalTimeoutMs", "mcpServers", "requireMcpServers",
  "toolTimeouts", "maxSpawnDepth", "toolErrorBudgetHardStop",
  "summarizeKeepRecentTurns", "summarizePrompt", "summarizeFallbackKeep",
  "turnModelRules", "promptContent", "siteUrl", "siteName",
  "costPerInputToken", "costPerOutputToken", "maxCostUsd",
  "hooks", "hooksEnabled", "source",
  "apiKeys", "timeoutSec", "requiredEnvVars",
]);

function sanitizeDaemonRunOpts(raw: Record<string, unknown>): { safe: Record<string, unknown>; rejected: string[] } {
  const safe: Record<string, unknown> = {};
  const rejected: string[] = [];
  for (const [k, v] of Object.entries(raw)) {
    if (ALLOWED_DAEMON_OPTS.has(k)) {
      safe[k] = v;
    } else {
      rejected.push(k);
    }
  }
  // Security-sensitive fields: never allow callers to override sandboxRoot or requireApproval
  delete safe["sandboxRoot"];
  delete safe["requireApproval"];
  delete safe["bashPolicy"];
  delete safe["dangerouslySkipPermissions"];
  return { safe, rejected };
}

// ── Daemon server ─────────────────────────────────────────────────────────────

export interface DaemonStartOptions {
  port?: number;
  maxConcurrent?: number;
  /** Idle timeout in ms; daemon auto-exits if no requests arrive in this window. Default 30 min. */
  idleTimeoutMs?: number;
  /** Per-request timeout in ms. Default 5 min. */
  requestTimeoutMs?: number;
  /** Max concurrent runs per agent ID. Default 2. Prevents one agent from starving all others. */
  perAgentMaxConcurrent?: number;
  /** API key (from env). */
  apiKey: string;
  /** Model for cache-warming and keep-alive pings. */
  model: string;
  /** When set, restrict agent runs to cwds within these path prefixes. */
  allowedCwdPrefixes?: string[];
}

export async function startDaemon(daemonOpts: DaemonStartOptions): Promise<void> {
  // Mark process as daemon mode so approval.ts skips TTY prompts
  process.env.ORAGER_DAEMON_MODE = "1";

  await initTelemetry("orager-daemon");

  const {
    port = 3456,
    maxConcurrent = 3,
    idleTimeoutMs = 30 * 60 * 1000,
    requestTimeoutMs = 5 * 60 * 1000,
    perAgentMaxConcurrent = 2,
    apiKey,
    model,
  } = daemonOpts;

  const signingKey = await loadOrCreateSigningKey();
  process.stderr.write(`[orager daemon] signing key loaded from ${KEY_PATH}\n`);

  let activeRuns = 0;
  const activeRunsByAgent = new Map<string, number>();
  // Track AbortControllers by runId for cancellation
  const activeRunControllers = new Map<string, AbortController>();
  let draining = false;
  let completedRuns = 0;
  let errorRuns = 0;
  const daemonStartedAt = Date.now();
  let lastActivityAt = Date.now();
  let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  const usedModels = new Set<string>([model]);
  let lastRealRequestAt = Date.now();

  // ── Audit log (metadata only — no prompt/response content) ─────────────────
  function auditLog(entry: {
    timestamp: string;
    agentId: string;
    durationMs: number;
    status: "ok" | "error" | "timeout" | "rejected";
    statusCode: number;
  }): void {
    process.stderr.write(`[orager daemon] ${JSON.stringify(entry)}\n`);
  }

  // ── Cache warming (4c) ──────────────────────────────────────────────────────
  async function warmCache(): Promise<void> {
    try {
      await callOpenRouter({
        apiKey,
        model,
        messages: [{ role: "user", content: "ping" }],
        max_completion_tokens: 1,
      });
      process.stderr.write(`[orager daemon] cache warmed (model: ${model})\n`);
    } catch {
      // Non-fatal — cache warming failure doesn't stop the daemon
    }
  }

  // ── Keep-alive ping (4e) ────────────────────────────────────────────────────
  // Anthropic cache TTL is 5 minutes. Send a 1-token ping every 4 min so the
  // cache never goes cold between heartbeat runs.
  function startKeepAlive(): void {
    if (keepAliveTimer) return;
    const PING_INTERVAL_MS = 4 * 60 * 1000; // 4 minutes
    keepAliveTimer = setInterval(async () => {
      // Skip if a real request completed recently — cache is already warm (#8)
      if (Date.now() - lastRealRequestAt < PING_INTERVAL_MS) {
        return;
      }
      // Ping all models that have been used (#5)
      for (const m of usedModels) {
        await callOpenRouter({
          apiKey,
          model: m,
          messages: [{ role: "user", content: "ping" }],
          max_completion_tokens: 1,
        }).catch(() => {});
      }
      process.stderr.write(`[orager daemon] keep-alive ping sent (${usedModels.size} model(s))\n`);
    }, PING_INTERVAL_MS);
    // Don't let the interval block process exit
    if (keepAliveTimer.unref) keepAliveTimer.unref();
  }

  function stopKeepAlive(): void {
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
  }

  /**
   * Check OpenRouter account balance. Logs a warning if remaining credits
   * are below $1.00. Non-fatal — a check failure is silently ignored.
   */
  async function checkCredits(key: string): Promise<void> {
    try {
      const openrouterBase = (process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
      const res = await fetch(`${openrouterBase}/auth/key`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return;
      const body = await res.json() as {
        data?: { limit?: number | null; usage?: number; rate_limited?: boolean };
      };
      const { limit, usage } = body.data ?? {};
      if (typeof limit === "number" && typeof usage === "number") {
        const remaining = limit - usage;
        if (remaining < 1.0) {
          process.stderr.write(
            `[orager daemon] WARNING: OpenRouter credit balance low ($${remaining.toFixed(2)} remaining)\n`
          );
        } else {
          process.stderr.write(
            `[orager daemon] OpenRouter credits OK ($${remaining.toFixed(2)} remaining)\n`
          );
        }
      }
    } catch {
      // Non-fatal — ignore check failures
    }
  }

  // ── Idle shutdown ───────────────────────────────────────────────────────────
  function scheduleIdleCheck(): ReturnType<typeof setInterval> {
    const timer = setInterval(() => {
      if (activeRuns === 0 && Date.now() - lastActivityAt > idleTimeoutMs) {
        process.stderr.write("[orager daemon] idle timeout — shutting down\n");
        stopKeepAlive();
        removePortFile().finally(() => process.exit(0));
      }
    }, 60_000); // check every minute
    if (timer.unref) timer.unref();
    return timer;
  }

  // ── HTTP request handler ────────────────────────────────────────────────────

  const server = http.createServer((req, res) => {
    lastActivityAt = Date.now();

    // Health check
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", activeRuns, maxConcurrent, model }));
      return;
    }

    // Metrics endpoint — requires valid JWT (same as /run) to avoid exposing
    // internal state (dbPath, provider health, activeRunsByAgent) to unauthenticated callers
    if (req.method === "GET" && req.url === "/metrics") {
      const metricsAuthHeader = req.headers["authorization"] ?? "";
      const metricsToken = metricsAuthHeader.startsWith("Bearer ") ? metricsAuthHeader.slice(7) : "";
      if (!metricsToken) {
        res.writeHead(401);
        res.end();
        return;
      }
      try {
        verifyJwt(metricsToken, signingKey);
      } catch {
        res.writeHead(403);
        res.end();
        return;
      }
      void (async () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          activeRuns,
          maxConcurrent,
          completedRuns,
          errorRuns,
          draining,
          uptimeMs: Date.now() - daemonStartedAt,
          model,
          usedModels: Array.from(usedModels),
          activeRunsByAgent: Object.fromEntries(activeRunsByAgent),
          providerHealth: getAllProviderStats(),
          degradedProviders: getDegradedProviders(),
          dbBackend: process.env["ORAGER_DB_PATH"] ? "sqlite" : "filesystem",
          dbPath: process.env["ORAGER_DB_PATH"] ?? null,
          rateLimit: getRateLimitState(),
          keyInfo: await getCachedKeyInfo(apiKey),
        }));
      })();
      return;
    }

    // Run endpoint
    if (req.method === "POST" && req.url === "/run") {
      handleRun(req, res);
      return;
    }

    // GET /sessions — list sessions (paginated, sorted by updatedAt DESC)
    // GET /sessions?limit=N&offset=N — pagination
    // GET /sessions/search?q=... — full-text search
    if (req.method === "GET" && req.url?.startsWith("/sessions")) {
      const sessAuthHeader = req.headers["authorization"] ?? "";
      const sessToken = sessAuthHeader.startsWith("Bearer ") ? sessAuthHeader.slice(7) : "";
      if (!sessToken) { res.writeHead(401); res.end(); return; }
      try { verifyJwt(sessToken, signingKey); } catch { res.writeHead(403); res.end(); return; }

      void (async () => {
        try {
          const parsedUrl = new URL(req.url!, `http://127.0.0.1`);
          const pathname = parsedUrl.pathname;

          // GET /sessions/search?q=...
          if (pathname === "/sessions/search") {
            const q = parsedUrl.searchParams.get("q") ?? "";
            const limit = Math.min(parseInt(parsedUrl.searchParams.get("limit") ?? "20", 10), 100);
            if (!q.trim()) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "q parameter is required" }));
              return;
            }
            const results = await searchSessions(q.trim(), limit);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ sessions: results, total: results.length, query: q }));
            return;
          }

          // GET /sessions/:sessionId — single session summary
          const sessionIdMatch = pathname.match(/^\/sessions\/([^/]+)$/);
          if (sessionIdMatch) {
            const sessionId = sessionIdMatch[1]!;
            // Validate session ID to prevent path traversal (alphanumeric + hyphens only)
            if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "invalid session id format" }));
              return;
            }
            const all = await listSessions();
            const session = all.find((s) => s.sessionId === sessionId);
            if (!session) {
              res.writeHead(404, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "session not found" }));
              return;
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(session));
            return;
          }

          // GET /sessions — paginated list
          if (pathname === "/sessions") {
            const limit = Math.min(parseInt(parsedUrl.searchParams.get("limit") ?? "50", 10), 200);
            const offset = Math.max(parseInt(parsedUrl.searchParams.get("offset") ?? "0", 10), 0);
            const all = await listSessions();
            const page = all.slice(offset, offset + limit);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ sessions: page, total: all.length, limit, offset }));
            return;
          }

          res.writeHead(404); res.end();
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      })();
      return;
    }

    // POST /runs/:runId/cancel
    if (req.method === "POST" && req.url?.startsWith("/runs/") && req.url.endsWith("/cancel")) {
      const runId = req.url.slice("/runs/".length, -"/cancel".length);
      // Validate UUID format before using as a Map key to prevent path-injection attacks
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(runId)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid run id format" }));
        return;
      }
      const controller = activeRunControllers.get(runId);
      if (!controller) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "run not found" }));
        return;
      }
      controller.abort();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, runId }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  async function handleRun(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const startTime = Date.now();
    let agentId = "unknown";

    // ── Drain check ─────────────────────────────────────────────────────────
    if (draining) {
      res.writeHead(503, { "Retry-After": "5" });
      res.end(JSON.stringify({ error: "daemon shutting down" }));
      return;
    }

    // ── JWT verification ────────────────────────────────────────────────────
    const authHeader = req.headers["authorization"] ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) {
      res.writeHead(401);
      res.end();
      return;
    }
    let claims: { agentId: string };
    try {
      claims = verifyJwt(token, signingKey);
      agentId = claims.agentId;
    } catch {
      res.writeHead(401);
      res.end();
      return;
    }

    // ── Per-agent concurrency gate ───────────────────────────────────────
    // Prevents a single agent from monopolising all available slots.
    const agentSlots = activeRunsByAgent.get(agentId) ?? 0;
    if (agentSlots >= perAgentMaxConcurrent) {
      res.writeHead(429, { "Retry-After": "10" });
      res.end(JSON.stringify({ error: `per-agent concurrency limit (${perAgentMaxConcurrent}) exceeded` }));
      auditLog({
        timestamp: new Date().toISOString(),
        agentId,
        durationMs: 0,
        status: "rejected",
        statusCode: 429,
      });
      return;
    }

    // ── Concurrency gate ────────────────────────────────────────────────────
    if (activeRuns >= maxConcurrent) {
      res.writeHead(503, { "Retry-After": "5" });
      res.end(JSON.stringify({ error: "max concurrent runs exceeded" }));
      auditLog({ timestamp: new Date().toISOString(), agentId, durationMs: 0, status: "rejected", statusCode: 503 });
      return;
    }

    // ── Parse body ──────────────────────────────────────────────────────────
    const MAX_REQUEST_BODY_BYTES = 50 * 1024 * 1024; // 50 MB
    let body = "";
    let bodySize = 0;
    let bodyTooLarge = false;

    let runCounted = false;
    let agentCountDecremented = false;
    function decrementAgentCount() {
      if (agentCountDecremented) return;
      agentCountDecremented = true;
      const cur = activeRunsByAgent.get(agentId) ?? 1;
      if (cur <= 1) activeRunsByAgent.delete(agentId);
      else activeRunsByAgent.set(agentId, cur - 1);
    }
    req.on("data", (chunk: Buffer) => {
      bodySize += chunk.length;
      if (bodySize > MAX_REQUEST_BODY_BYTES) {
        bodyTooLarge = true;
        req.destroy(); // stop reading
        return;
      }
      body += chunk.toString();
    });

    req.on("end", () => { void (async () => {
      if (bodyTooLarge) {
        if (!res.destroyed) {
          res.writeHead(413);
          res.end(JSON.stringify({ error: "request body too large (max 50 MB)" }));
        }
        return;
      }
      let runReq: DaemonRunRequest;
      try {
        runReq = JSON.parse(body) as DaemonRunRequest;
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "invalid JSON body" }));
        return;
      }

      if (!runReq.prompt?.trim()) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "prompt is required" }));
        return;
      }

      // ── Sandbox root enforcement ─────────────────────────────────────────
      const { allowedCwdPrefixes } = daemonOpts;
      if (allowedCwdPrefixes && allowedCwdPrefixes.length > 0) {
        const reqCwd = runReq.opts?.cwd ?? "";
        // Resolve symlinks before prefix-matching to prevent symlink bypass attacks
        // (e.g. /tmp/mylink → /etc would otherwise pass a prefix check for /tmp).
        let canonicalCwd = reqCwd;
        try {
          canonicalCwd = await fs.realpath(reqCwd);
        } catch {
          // Path doesn't exist yet — fall back to raw path; mkdir will fail later if needed
          canonicalCwd = reqCwd;
        }
        const allowed = allowedCwdPrefixes.some(
          (prefix) => canonicalCwd === prefix || canonicalCwd.startsWith(prefix + "/"),
        );
        if (!allowed) {
          res.writeHead(403);
          res.end(JSON.stringify({ error: `cwd '${reqCwd}' is not within an allowed prefix` }));
          auditLog({ timestamp: new Date().toISOString(), agentId, durationMs: 0, status: "rejected", statusCode: 403 });
          return;
        }
      }

      // Track which models are being used for multi-model keep-alive (#5)
      if (runReq.opts?.model) usedModels.add(runReq.opts.model);
      lastRealRequestAt = Date.now();

      activeRuns++;
      activeRunsByAgent.set(agentId, (activeRunsByAgent.get(agentId) ?? 0) + 1);
      runCounted = true;
      if (activeRuns >= maxConcurrent) {
        process.stderr.write(`[orager daemon] warning: at max concurrent runs (${activeRuns}/${maxConcurrent})\n`);
      }
      res.writeHead(200, {
        "Content-Type": "application/x-ndjson",
        "Transfer-Encoding": "chunked",
        "Cache-Control": "no-cache",
      });

      // ── Per-request timeout ─────────────────────────────────────────────
      const runId = crypto.randomUUID();
      const abortController = new AbortController();
      activeRunControllers.set(runId, abortController);

      // Abort the agent loop if the client disconnects mid-stream so we don't
      // waste resources running to completion for a gone caller.
      res.on("close", () => {
        if (runCounted && !timedOut) abortController.abort();
      });

      let timedOut = false;
      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        abortController.abort();
        res.write(
          JSON.stringify({ type: "result", subtype: "error", result: "Request timed out", session_id: "", finish_reason: null, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 }, total_cost_usd: 0 }) + "\n",
        );
        res.end();
        activeRuns--;
        decrementAgentCount();
        auditLog({ timestamp: new Date().toISOString(), agentId, durationMs: Date.now() - startTime, status: "timeout", statusCode: 200 });
      }, requestTimeoutMs);

      // ── Execute run ─────────────────────────────────────────────────────

      const { safe: safeOpts, rejected: rejectedOpts } = sanitizeDaemonRunOpts(runReq.opts as unknown as Record<string, unknown>);
      if (rejectedOpts.length > 0) {
        const msg = `[orager daemon] WARNING: ignoring disallowed opts fields from caller: ${rejectedOpts.join(", ")}`;
        process.stderr.write(msg + "\n");
        res.write(JSON.stringify({ type: "warn", message: msg, dropped_opts: rejectedOpts }) + "\n");
      }
      const loopOpts: AgentLoopOptions = {
        // Secure defaults — callers cannot override these via the request opts
        dangerouslySkipPermissions: false,
        verbose: false,
        ...safeOpts,
        prompt: runReq.prompt,
        promptContent: (() => {
          if (!Array.isArray(runReq.promptContent)) return undefined;
          // Validate each element has a known type and no unexpected fields
          const validated = (runReq.promptContent as unknown[]).filter((item): item is { type: string } => {
            if (!item || typeof item !== "object") return false;
            const t = (item as Record<string, unknown>).type;
            // Only allow text and image_url content types
            return t === "text" || t === "image_url";
          });
          return validated.length > 0 ? validated as AgentLoopOptions["promptContent"] : undefined;
        })(),
        apiKey,
        abortSignal: abortController.signal,
        onEmit: (event: EmitEvent) => {
          if (!timedOut && !res.destroyed) {
            res.write(JSON.stringify(event) + "\n");
          }
        },
        onLog: (stream, chunk) => {
          if (stream === "stderr") process.stderr.write(chunk);
        },
      } as AgentLoopOptions;

      // Only check circuit breaker for OpenRouter calls (direct Anthropic path bypasses it)
      const isDirectPath = typeof runReq.opts?.model === "string" && runReq.opts.model.startsWith("anthropic/") && !!process.env.ANTHROPIC_API_KEY?.trim();
      if (!isDirectPath && openRouterCircuitBreaker.isOpen()) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          type: "result",
          subtype: "error_circuit_open",
          result: "OpenRouter API circuit breaker is open due to sustained failures. Retry in " + Math.ceil(openRouterCircuitBreaker.retryInMs / 1000) + "s.",
          session_id: "",
          turn_count: 0,
          total_cost_usd: 0,
          exit_code: 1,
        }));
        return;
      }

      runAgentLoop(loopOpts)
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          if (!timedOut && !res.destroyed) {
            res.write(
              JSON.stringify({ type: "result", subtype: "error", result: msg, session_id: "", finish_reason: null, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 }, total_cost_usd: 0 }) + "\n",
            );
          }
          errorRuns++;
        })
        .finally(() => {
          activeRunControllers.delete(runId);
          if (!timedOut) {
            clearTimeout(timeoutHandle);
            if (!res.destroyed) res.end();
            auditLog({ timestamp: new Date().toISOString(), agentId, durationMs: Date.now() - startTime, status: "ok", statusCode: 200 });
            activeRuns--;
            decrementAgentCount();
          }
          completedRuns++;
        });
    })(); });

    req.on("error", () => {
      if (runCounted) {
        activeRuns--;
        decrementAgentCount();
      }
      res.destroy();
    });
  }

  // ── Start server ────────────────────────────────────────────────────────────
  await acquirePidLock(port);
  await ensureSessionsDirPermissions();

  // Non-blocking API key health check at startup
  checkAndLogApiKeyHealth(
    apiKey,
    (msg) => process.stderr.write(msg),
  ).catch(() => {}); // fire-and-forget

  await new Promise<void>((resolve, reject) => {
    server.listen(port, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });

  await writePortFile(port);
  scheduleIdleCheck();

  process.stderr.write(`[orager daemon] listening on 127.0.0.1:${port} (max ${maxConcurrent} concurrent runs)\n`);
  process.stderr.write(`[orager daemon] idle shutdown after ${idleTimeoutMs / 60_000}min\n`);

  // Warm cache on startup (Phase 4c)
  await warmCache();
  startKeepAlive();

  // ── Session auto-prune ─────────────────────────────────────────────────────
  // Prune sessions older than 30 days once at startup and then every 24 hours.
  // Runs fire-and-forget so they never delay request handling.
  const SESSION_PRUNE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
  const runSessionPrune = (): void => {
    pruneOldSessions(SESSION_PRUNE_TTL_MS).then((result) => {
      if (result.deleted > 0) {
        process.stderr.write(`[orager daemon] pruned ${result.deleted} old session(s) (kept ${result.kept})\n`);
      }
    }).catch(() => {});
  };
  runSessionPrune();
  setInterval(runSessionPrune, 24 * 60 * 60 * 1000).unref();

  // Graceful shutdown
  process.on("SIGTERM", async () => {
    draining = true;
    process.stderr.write("[orager daemon] SIGTERM — draining in-flight runs...\n");
    stopKeepAlive();
    await releasePidLock();
    await removePortFile();

    const DRAIN_TIMEOUT_MS = 120_000; // 2 minutes
    const drainStart = Date.now();
    while (activeRuns > 0 && Date.now() - drainStart < DRAIN_TIMEOUT_MS) {
      await new Promise<void>((r) => setTimeout(r, 500));
    }
    if (activeRuns > 0) {
      process.stderr.write(
        `[orager daemon] drain timeout — ${activeRuns} run(s) abandoned\n`
      );
    } else {
      process.stderr.write("[orager daemon] all runs completed — exiting\n");
    }
    server.close(() => process.exit(0));
  });
  process.on("SIGINT", async () => {
    stopKeepAlive();
    await releasePidLock();
    await removePortFile();
    server.close(() => process.exit(0));
  });
}

// ── Daemon client helpers (used by the adapter's execute-cli.ts) ──────────────

/**
 * Check if the daemon is reachable at the given URL.
 * Returns true only if /health responds with { status: "ok" }.
 */
export async function isDaemonAlive(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return false;
    const body = await res.json() as { status?: string };
    return body.status === "ok";
  } catch {
    return false;
  }
}

/**
 * Send a run request to the daemon and return a readable stream of
 * newline-delimited JSON events (same format as CLI stdout).
 *
 * @param baseUrl     e.g. "http://127.0.0.1:3456"
 * @param signingKey  Contents of ~/.orager/daemon.key
 * @param agentId     Identifier passed in JWT claims (for audit logs)
 * @param req         Run request payload
 */
export async function runOnDaemon(
  baseUrl: string,
  signingKey: string,
  agentId: string,
  req: DaemonRunRequest,
): Promise<ReadableStream<Uint8Array>> {
  const token = mintJwt(signingKey, agentId);
  const response = await fetch(`${baseUrl}/run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(req),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "(unreadable)");
    throw new Error(`Daemon error ${response.status}: ${text.slice(0, 200)}`);
  }

  if (!response.body) {
    throw new Error("Daemon response has no body");
  }

  return response.body;
}
