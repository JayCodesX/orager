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

// ── Port file ─────────────────────────────────────────────────────────────────
// Written on startup so clients (adapter) can discover the port without config.

const PORT_FILE = path.join(os.homedir(), ".orager", "daemon.port");

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

// ── Daemon run request schema ─────────────────────────────────────────────────

export interface DaemonRunRequest {
  prompt: string;
  /** Full AgentLoopOptions minus apiKey (key comes from env on daemon side). */
  opts: Omit<AgentLoopOptions, "apiKey" | "onEmit" | "onLog">;
}

// ── Daemon server ─────────────────────────────────────────────────────────────

export interface DaemonStartOptions {
  port?: number;
  maxConcurrent?: number;
  /** Idle timeout in ms; daemon auto-exits if no requests arrive in this window. Default 30 min. */
  idleTimeoutMs?: number;
  /** Per-request timeout in ms. Default 5 min. */
  requestTimeoutMs?: number;
  /** API key (from env). */
  apiKey: string;
  /** Model for cache-warming and keep-alive pings. */
  model: string;
}

export async function startDaemon(daemonOpts: DaemonStartOptions): Promise<void> {
  const {
    port = 3456,
    maxConcurrent = 3,
    idleTimeoutMs = 30 * 60 * 1000,
    requestTimeoutMs = 5 * 60 * 1000,
    apiKey,
    model,
  } = daemonOpts;

  const signingKey = await loadOrCreateSigningKey();
  process.stderr.write(`[orager daemon] signing key loaded from ${KEY_PATH}\n`);

  let activeRuns = 0;
  let lastActivityAt = Date.now();
  let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

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
        max_tokens: 1,
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
      await callOpenRouter({
        apiKey,
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      }).catch(() => {});
      process.stderr.write(`[orager daemon] keep-alive ping sent\n`);
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
      res.end(JSON.stringify({ status: "ok", activeRuns, model }));
      return;
    }

    // Run endpoint
    if (req.method === "POST" && req.url === "/run") {
      handleRun(req, res);
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

    // ── Concurrency gate ────────────────────────────────────────────────────
    if (activeRuns >= maxConcurrent) {
      res.writeHead(503, { "Retry-After": "5" });
      res.end(JSON.stringify({ error: "max concurrent runs exceeded" }));
      auditLog({ timestamp: new Date().toISOString(), agentId, durationMs: 0, status: "rejected", statusCode: 503 });
      return;
    }

    // ── Parse body ──────────────────────────────────────────────────────────
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });

    req.on("end", () => {
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

      activeRuns++;

      // Stream newline-delimited JSON events back to the client
      res.writeHead(200, {
        "Content-Type": "application/x-ndjson",
        "Transfer-Encoding": "chunked",
        "Cache-Control": "no-cache",
      });

      // ── Per-request timeout ─────────────────────────────────────────────
      let timedOut = false;
      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        res.write(
          JSON.stringify({ type: "result", subtype: "error", result: "Request timed out", session_id: "", finish_reason: null, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 }, total_cost_usd: 0 }) + "\n",
        );
        res.end();
        activeRuns--;
        auditLog({ timestamp: new Date().toISOString(), agentId, durationMs: Date.now() - startTime, status: "timeout", statusCode: 200 });
      }, requestTimeoutMs);

      // ── Execute run ─────────────────────────────────────────────────────
      const loopOpts: AgentLoopOptions = {
        ...runReq.opts,
        prompt: runReq.prompt,
        apiKey,
        onEmit: (event: EmitEvent) => {
          if (!timedOut && !res.destroyed) {
            res.write(JSON.stringify(event) + "\n");
          }
        },
        onLog: (stream, chunk) => {
          if (stream === "stderr") process.stderr.write(chunk);
        },
      };

      runAgentLoop(loopOpts)
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          if (!timedOut && !res.destroyed) {
            res.write(
              JSON.stringify({ type: "result", subtype: "error", result: msg, session_id: "", finish_reason: null, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 }, total_cost_usd: 0 }) + "\n",
            );
          }
        })
        .finally(() => {
          if (!timedOut) {
            clearTimeout(timeoutHandle);
            if (!res.destroyed) res.end();
            auditLog({ timestamp: new Date().toISOString(), agentId, durationMs: Date.now() - startTime, status: timedOut ? "timeout" : "ok", statusCode: 200 });
          }
          activeRuns--;
        });
    });

    req.on("error", () => {
      activeRuns--;
      res.destroy();
    });
  }

  // ── Start server ────────────────────────────────────────────────────────────
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

  // Graceful shutdown
  process.on("SIGTERM", async () => {
    process.stderr.write("[orager daemon] SIGTERM — shutting down\n");
    stopKeepAlive();
    await removePortFile();
    server.close(() => process.exit(0));
  });
  process.on("SIGINT", async () => {
    stopKeepAlive();
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
