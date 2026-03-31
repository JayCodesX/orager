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
 * Internal implementation is split across src/daemon/:
 * - context.ts      — DaemonContext interface + verifyJwtDualKey
 * - lifecycle.ts    — warmCache, keepAlive, auditLog, scheduleIdleCheck
 * - drain.ts        — drainAndExit
 * - key-cache.ts    — getCachedKeyInfo (5-min TTL API key info cache)
 * - sanitize.ts     — sanitizeDaemonRunOpts allowlist
 * - routes/health.ts, metrics.ts, sessions.ts, rotate-key.ts, cancel.ts, run.ts
 */

import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { mintJwt, loadOrCreateSigningKey, KEY_PATH } from "./jwt.js";
import { ensureSessionsDirPermissions, pruneOldSessions, getSessionsDir } from "./session.js";
import { initTelemetry } from "./telemetry.js";
import { checkAndLogApiKeyHealth } from "./openrouter-key.js";
import { fetchModelContextLengths } from "./loop-helpers.js";
import { fetchLiveModelMeta } from "./openrouter-model-meta.js";

// ── Submodule imports ──────────────────────────────────────────────────────────
import type { DaemonContext } from "./daemon/context.js";
import { warmCache, startKeepAlive, scheduleIdleCheck } from "./daemon/lifecycle.js";
import { drainAndExit as _drainAndExitImpl } from "./daemon/drain.js";
import { handleHealth } from "./daemon/routes/health.js";
import { handleMetrics } from "./daemon/routes/metrics.js";
import { handleRun } from "./daemon/routes/run.js";
import { handleSessions } from "./daemon/routes/sessions.js";
import { handleRotateKey } from "./daemon/routes/rotate-key.js";
import { handleCancel } from "./daemon/routes/cancel.js";

// Re-export for external callers (adapter, index.ts, tests)
export { sanitizeDaemonRunOpts } from "./daemon/sanitize.js";
export type { DaemonContext };

// ── Port / PID files ──────────────────────────────────────────────────────────

const PORT_FILE = path.join(os.homedir(), ".orager", "daemon.port");
const PID_FILE  = path.join(os.homedir(), ".orager", "daemon.pid");

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

async function acquirePidLock(port: number): Promise<void> {
  const pidData = JSON.stringify({ pid: process.pid, port });
  await fs.mkdir(path.dirname(PID_FILE), { recursive: true });

  try {
    await fs.writeFile(PID_FILE, pidData, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return;
  } catch (writeErr) {
    const code = (writeErr as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw writeErr;
  }

  try {
    const existing = await fs.readFile(PID_FILE, "utf8");
    const parsed = JSON.parse(existing) as { pid: number; port: number };
    try {
      process.kill(parsed.pid, 0);
      throw new Error(
        `[orager daemon] already running (PID ${parsed.pid}, port ${parsed.port}). ` +
        `Stop it first with: kill ${parsed.pid}`,
      );
    } catch (killErr) {
      const code = (killErr as NodeJS.ErrnoException).code;
      if (code === "EPERM") {
        throw new Error(
          `[orager daemon] appears to be running (PID ${parsed.pid}). Stop it first.`,
        );
      }
      if ((killErr as Error).message?.includes("orager daemon")) throw killErr;
    }
  } catch (readErr) {
    if ((readErr as Error).message?.includes("orager daemon")) throw readErr;
  }

  await fs.unlink(PID_FILE).catch(() => {});
  try {
    await fs.writeFile(PID_FILE, pidData, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch {
    const existing2 = await fs.readFile(PID_FILE, "utf8").catch(() => "{}");
    const parsed2 = JSON.parse(existing2) as { pid?: number; port?: number };
    if (parsed2.pid && parsed2.pid !== process.pid) {
      throw new Error(
        `[orager daemon] race: another daemon started (PID ${parsed2.pid}). ` +
        `Only one daemon can run at a time.`,
      );
    }
  }
}

async function releasePidLock(): Promise<void> {
  await fs.unlink(PID_FILE).catch(() => {});
}

// ── In-process token-bucket rate limiter ──────────────────────────────────────

const RATE_LIMIT_WINDOW_MS = 60_000;

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

const _rateLimitMap = new Map<string, RateLimitEntry>();
let _rateLimitCleanupTimer: ReturnType<typeof setInterval> | null = null;

function _startRateLimitCleanup(): void {
  if (_rateLimitCleanupTimer) return;
  _rateLimitCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of _rateLimitMap) {
      if (now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) _rateLimitMap.delete(ip);
    }
  }, 5 * 60_000);
  if (_rateLimitCleanupTimer.unref) _rateLimitCleanupTimer.unref();
}

export function _getRateLimitState(): Map<string, RateLimitEntry> { return _rateLimitMap; }
export function _clearRateLimitState(): void { _rateLimitMap.clear(); }

export function checkRateLimit(
  ip: string,
  isRunEndpoint: boolean,
): { allowed: true } | { allowed: false; retryAfter: number } {
  const runRpm = (() => {
    const v = parseInt(process.env["ORAGER_RATE_LIMIT_RPM"] ?? "", 10);
    return Number.isFinite(v) && v > 0 ? v : 60;
  })();
  const limit = isRunEndpoint ? runRpm : runRpm * 5;
  const now = Date.now();
  const entry = _rateLimitMap.get(ip);

  if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    _rateLimitMap.set(ip, { count: 1, windowStart: now });
    return { allowed: true };
  }
  if (entry.count < limit) {
    entry.count++;
    return { allowed: true };
  }
  const retryAfter = Math.ceil((RATE_LIMIT_WINDOW_MS - (now - entry.windowStart)) / 1000);
  return { allowed: false, retryAfter };
}

// ── Public types ──────────────────────────────────────────────────────────────

export interface DaemonRunRequest {
  prompt: string;
  promptContent?: unknown[];
  opts: Record<string, unknown>;
}

export interface DaemonStartOptions {
  port?: number;
  maxConcurrent?: number;
  idleTimeoutMs?: number;
  requestTimeoutMs?: number;
  perAgentMaxConcurrent?: number;
  apiKey: string;
  model: string;
  allowedCwdPrefixes?: string[];
}

// ── Module-level drainAndExit export ──────────────────────────────────────────
// Set once the server is live so tests can trigger graceful shutdown.
let _drainAndExit: ((timeoutMs: number) => Promise<void>) | null = null;
export function drainAndExit(timeoutMs: number): Promise<void> {
  if (!_drainAndExit) throw new Error("drainAndExit: no daemon running");
  return _drainAndExit(timeoutMs);
}

// ── startDaemon ───────────────────────────────────────────────────────────────

export async function startDaemon(
  daemonOpts: DaemonStartOptions,
): Promise<{ port: number; shutdown: (timeoutMs: number) => Promise<void> }> {
  process.env.ORAGER_DAEMON_MODE = "1";
  await initTelemetry("orager-daemon");

  const {
    port: requestedPort = 3456,
    maxConcurrent = 3,
    idleTimeoutMs = 30 * 60 * 1000,
    requestTimeoutMs = 5 * 60 * 1000,
    perAgentMaxConcurrent = 2,
    apiKey,
    model,
    allowedCwdPrefixes,
  } = daemonOpts;

  const signingKey = await loadOrCreateSigningKey();
  process.stderr.write(`[orager daemon] signing key loaded from ${KEY_PATH}\n`);

  // ── Build shared context ───────────────────────────────────────────────────
  const ctx: DaemonContext = {
    port: requestedPort,
    maxConcurrent,
    perAgentMaxConcurrent,
    apiKey,
    model,
    idleTimeoutMs,
    requestTimeoutMs,
    allowedCwdPrefixes,
    previousKeyTtlMs: 20 * 60 * 1000, // 20 minutes

    signingKey,
    previousKey: null,
    previousKeyExpiresAt: null,

    activeRuns: 0,
    activeRunsByAgent: new Map(),
    activeRunControllers: new Map(),
    draining: false,
    completedRuns: 0,
    errorRuns: 0,

    daemonStartedAt: Date.now(),
    lastActivityAt: Date.now(),
    lastRealRequestAt: Date.now(),

    keepAliveTimer: null,
    usedModels: new Set([model]),
    modelLastUsedAt: new Map([[model, Date.now()]]),
  };

  // ── HTTP(S) server (audit E-14) ────────────────────────────────────────────
  // When ORAGER_TLS_CERT and ORAGER_TLS_KEY are set, the daemon uses HTTPS
  // so JWTs and API keys are encrypted on the loopback interface.
  const tlsCert = process.env["ORAGER_TLS_CERT"];
  const tlsKey = process.env["ORAGER_TLS_KEY"];
  let useTls = false;
  let tlsOpts: https.ServerOptions | undefined;
  if (tlsCert && tlsKey) {
    try {
      const [certData, keyData] = await Promise.all([
        fs.readFile(tlsCert),
        fs.readFile(tlsKey),
      ]);
      tlsOpts = { cert: certData, key: keyData };
      useTls = true;
      process.stderr.write(`[orager daemon] TLS enabled (cert=${tlsCert})\n`);
    } catch (tlsErr) {
      process.stderr.write(
        `[orager daemon] WARNING: TLS cert/key configured but unreadable: ${tlsErr}. Falling back to plain HTTP.\n`,
      );
    }
  }

  const requestHandler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    ctx.lastActivityAt = Date.now();

    // Rate limiting (all endpoints)
    const ip =
      (Array.isArray(req.headers["x-forwarded-for"])
        ? req.headers["x-forwarded-for"][0]
        : req.headers["x-forwarded-for"]?.split(",")[0])?.trim() ??
      req.socket.remoteAddress ??
      "unknown";
    const isRunEndpoint = req.method === "POST" && req.url === "/run";
    const rl = checkRateLimit(ip, isRunEndpoint);
    if (!rl.allowed) {
      res.writeHead(429, { "Content-Type": "application/json", "Retry-After": String(rl.retryAfter) });
      res.end(JSON.stringify({ error: "rate limit exceeded", retryAfter: rl.retryAfter }));
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      handleHealth(ctx, req, res); return;
    }
    if (req.method === "GET" && req.url === "/metrics") {
      handleMetrics(ctx, req, res); return;
    }
    if (req.method === "POST" && req.url === "/run") {
      handleRun(ctx, req, res); return;
    }
    if (req.url?.startsWith("/sessions")) {
      handleSessions(ctx, req, res); return;
    }
    if (req.method === "POST" && req.url === "/rotate-key") {
      handleRotateKey(ctx, req, res); return;
    }
    if (req.method === "POST" && req.url?.startsWith("/runs/") && req.url.endsWith("/cancel")) {
      handleCancel(ctx, req, res); return;
    }

    res.writeHead(404); res.end();
  };

  const server = useTls
    ? https.createServer(tlsOpts!, requestHandler)
    : http.createServer(requestHandler);

  // ── Check for recovery manifest from previous crash ───────────────────────
  const RECOVERY_FILE = path.join(os.homedir(), ".orager", "recovery.json");
  try {
    const recoveryRaw = await fs.readFile(RECOVERY_FILE, "utf8");
    const recovery = JSON.parse(recoveryRaw) as { abandonedAt?: string; runs?: Array<{ runId?: string; abandonedAt?: string }> };
    if (recovery.runs && Array.isArray(recovery.runs)) {
      for (const run of recovery.runs) {
        process.stderr.write(
          `[orager] warn: run ${run.runId ?? "unknown"} was abandoned during last shutdown at ${run.abandonedAt ?? recovery.abandonedAt ?? "unknown"}\n`,
        );
      }
    } else {
      process.stderr.write(
        `[orager] warn: previous shutdown had abandoned runs at ${recovery.abandonedAt ?? "unknown"}\n`,
      );
    }
    await fs.unlink(RECOVERY_FILE).catch(() => {});
  } catch {
    // Recovery file doesn't exist or can't be read — normal startup
  }

  // ── Start server ───────────────────────────────────────────────────────────
  await acquirePidLock(requestedPort);
  await ensureSessionsDirPermissions();
  _startRateLimitCleanup();

  checkAndLogApiKeyHealth(apiKey, (msg) => process.stderr.write(msg)).catch(() => {});

  await new Promise<void>((resolve, reject) => {
    server.listen(requestedPort, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });

  const actualPort = (server.address() as import("node:net").AddressInfo).port;
  await writePortFile(actualPort);

  const DRAIN_TIMEOUT_MS = 120_000;

  async function drain(timeoutMs: number): Promise<void> {
    return _drainAndExitImpl(ctx, server, timeoutMs, async () => {
      await releasePidLock();
      await removePortFile();
    });
  }
  /** Test-safe shutdown: closes the server without calling process.exit. */
  async function shutdown(timeoutMs: number): Promise<void> {
    return _drainAndExitImpl(ctx, server, timeoutMs, async () => {
      await releasePidLock();
      await removePortFile();
    }, () => { /* no process.exit — safe for test environments */ });
  }
  _drainAndExit = drain;

  scheduleIdleCheck(ctx, drain, DRAIN_TIMEOUT_MS);

  // Prune stale model tracking entries (prevent unbounded growth)
  setInterval(() => {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const [model, lastUsed] of ctx.modelLastUsedAt) {
      if (lastUsed < cutoff) ctx.modelLastUsedAt.delete(model);
    }
  }, 60 * 60 * 1000).unref(); // hourly, non-blocking

  const proto = useTls ? "https" : "http";
  process.stderr.write(
    `[orager daemon] listening on ${proto}://127.0.0.1:${actualPort} (max ${maxConcurrent} concurrent runs)\n`,
  );
  process.stderr.write(
    `[orager daemon] idle shutdown after ${idleTimeoutMs >= 60_000 ? `${idleTimeoutMs / 60_000}min` : `${idleTimeoutMs / 1_000}s`}\n`,
  );

  await warmCache(ctx);
  startKeepAlive(ctx);

  Promise.all([
    fetchModelContextLengths(apiKey).catch(() => {}),
    fetchLiveModelMeta(apiKey).catch(() => {}),
  ]).catch(() => {});

  // Embedding cache prewarm
  if (apiKey) {
    void (async () => {
      try {
        const { callEmbeddings } = await import("./openrouter.js");
        const { setCachedQueryEmbedding } = await import("./embedding-cache.js");
        const sessionsDir = getSessionsDir();
        let sessionFiles: string[] = [];
        try {
          const allFiles = await fs.readdir(sessionsDir);
          sessionFiles = allFiles.filter((f) => f.endsWith(".json") && !f.includes(".run.lock"));
        } catch { return; }

        const withMtime: Array<{ file: string; mtimeMs: number }> = [];
        for (const f of sessionFiles) {
          try {
            const stat = await fs.stat(path.join(sessionsDir, f));
            withMtime.push({ file: f, mtimeMs: stat.mtimeMs });
          } catch {
            withMtime.push({ file: f, mtimeMs: 0 });
          }
        }
        withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);

        await Promise.all(
          withMtime.slice(0, 5).map(async ({ file }) => {
            try {
              const sessionId = file.slice(0, -5);
              const raw = await fs.readFile(path.join(sessionsDir, file), "utf8");
              const session = JSON.parse(raw) as {
                opts?: { memoryEmbeddingModel?: string };
                messages?: Array<{ role: string; content?: string }>;
              };
              const embeddingModel = session.opts?.memoryEmbeddingModel;
              if (!embeddingModel) return;
              const msgs = session.messages ?? [];
              let lastPrompt = "";
              for (let i = msgs.length - 1; i >= 0; i--) {
                const m = msgs[i];
                if (m.role === "user" && typeof m.content === "string" && m.content.trim()) {
                  lastPrompt = m.content.trim().slice(0, 1000);
                  break;
                }
              }
              if (!lastPrompt) return;
              const [vec] = await callEmbeddings(apiKey, embeddingModel, [lastPrompt]);
              setCachedQueryEmbedding(embeddingModel, lastPrompt, vec);
              process.stderr.write(
                `[orager daemon] embedding prewarm: cached ${embeddingModel} for session ${sessionId}\n`,
              );
            } catch { /* best-effort */ }
          }),
        );
      } catch { /* best-effort */ }
    })();
  }

  // Session auto-prune
  const SESSION_RETENTION_DAYS = parseInt(process.env["ORAGER_SESSION_RETENTION_DAYS"] ?? "30", 10);
  const SESSION_PRUNE_TTL_MS = SESSION_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  process.stderr.write(`[orager daemon] session retention: ${SESSION_RETENTION_DAYS} days\n`);
  const runSessionPrune = (): void => {
    pruneOldSessions(SESSION_PRUNE_TTL_MS).then((result) => {
      if (result.deleted > 0) {
        process.stderr.write(
          `[orager daemon] pruned ${result.deleted} old session(s) (kept ${result.kept})\n`,
        );
      }
    }).catch(() => {});
  };
  runSessionPrune();
  setInterval(runSessionPrune, 24 * 60 * 60 * 1000).unref();

  process.on("SIGTERM", () => { void drain(DRAIN_TIMEOUT_MS); });
  process.on("SIGINT",  () => { void drain(30_000); });

  return { port: actualPort, shutdown };
}

// ── Daemon client helpers ─────────────────────────────────────────────────────

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

  if (!response.body) throw new Error("Daemon response has no body");
  return response.body;
}
