/**
 * Daemon lifecycle helpers: cache warming, keep-alive pings, idle shutdown,
 * credit checks, and audit logging.
 */
import { callOpenRouter } from "../openrouter.js";
import { fetchApiKeyInfo } from "../openrouter-key.js";
import type { DaemonContext } from "./context.js";

// ── Audit log with rotation (audit E-02) ─────────────────────────────────────
// Logs metadata only — never prompt or response content.
// When ORAGER_AUDIT_LOG is set, writes NDJSON to that file with automatic
// rotation when the file exceeds AUDIT_MAX_BYTES (default 10 MB, max 3 files).

import { appendFileSync, statSync, renameSync, unlinkSync, existsSync } from "node:fs";

const AUDIT_LOG_PATH = process.env["ORAGER_AUDIT_LOG"] ?? "";
const AUDIT_MAX_BYTES = parseInt(process.env["ORAGER_AUDIT_MAX_BYTES"] ?? "", 10) || 10 * 1024 * 1024;
const AUDIT_MAX_FILES = 3;

function rotateAuditLog(): void {
  if (!AUDIT_LOG_PATH) return;
  try {
    const stat = statSync(AUDIT_LOG_PATH);
    if (stat.size < AUDIT_MAX_BYTES) return;
  } catch {
    return; // File doesn't exist yet
  }
  // Rotate: audit.log.2 → delete, audit.log.1 → .2, audit.log → .1
  for (let i = AUDIT_MAX_FILES - 1; i >= 1; i--) {
    const src = i === 1 ? AUDIT_LOG_PATH : `${AUDIT_LOG_PATH}.${i - 1}`;
    const dst = `${AUDIT_LOG_PATH}.${i}`;
    try {
      if (i === AUDIT_MAX_FILES - 1 && existsSync(dst)) unlinkSync(dst);
      if (existsSync(src)) renameSync(src, dst);
    } catch { /* best-effort */ }
  }
}

export function auditLog(entry: {
  timestamp: string;
  agentId: string;
  durationMs: number;
  status: "ok" | "error" | "timeout" | "rejected";
  statusCode: number;
}): void {
  const line = JSON.stringify(entry);
  process.stderr.write(`[orager daemon] ${line}\n`);
  if (AUDIT_LOG_PATH) {
    try {
      rotateAuditLog();
      appendFileSync(AUDIT_LOG_PATH, line + "\n", { mode: 0o600 });
    } catch { /* non-fatal */ }
  }
}

// ── Cache warming (Phase 4c) ───────────────────────────────────────────────────

export async function warmCache(ctx: DaemonContext): Promise<void> {
  try {
    await callOpenRouter({
      apiKey: ctx.apiKey,
      model: ctx.model,
      messages: [{ role: "user", content: "ping" }],
      max_completion_tokens: 1,
    });
    process.stderr.write(`[orager daemon] cache warmed (model: ${ctx.model})\n`);
  } catch {
    // Non-fatal — cache warming failure doesn't stop the daemon
  }
}

// ── Keep-alive pings (Phase 4e) ───────────────────────────────────────────────
// Anthropic cache TTL is 5 minutes; ping every 4 min to keep it warm.

export function startKeepAlive(ctx: DaemonContext): void {
  if (ctx.keepAliveTimer) return;
  const PING_INTERVAL_MS = 4 * 60 * 1000;
  ctx.keepAliveTimer = setInterval(async () => {
    // Skip if a real request completed recently — cache is already warm
    if (Date.now() - ctx.lastRealRequestAt < PING_INTERVAL_MS) return;
    for (const m of ctx.usedModels) {
      await callOpenRouter({
        apiKey: ctx.apiKey,
        model: m,
        messages: [{ role: "user", content: "ping" }],
        max_completion_tokens: 1,
      }).catch((err: unknown) => {
        console.error("[orager] keepalive ping failed:", err instanceof Error ? err.message : String(err));
      });
    }
    process.stderr.write(
      `[orager daemon] keep-alive ping sent (${ctx.usedModels.size} model(s))\n`,
    );
  }, PING_INTERVAL_MS);
  if (ctx.keepAliveTimer.unref) ctx.keepAliveTimer.unref();
}

export function stopKeepAlive(ctx: DaemonContext): void {
  if (ctx.keepAliveTimer) {
    clearInterval(ctx.keepAliveTimer);
    ctx.keepAliveTimer = null;
  }
}

// ── Credit check ──────────────────────────────────────────────────────────────

export async function checkCredits(key: string): Promise<void> {
  try {
    const info = await fetchApiKeyInfo(key);
    if (!info) return;
    if (info.remaining !== null && info.remaining < 1.0) {
      process.stderr.write(
        `[orager daemon] WARNING: OpenRouter credit balance low ($${info.remaining.toFixed(2)} remaining)\n`,
      );
    } else if (info.remaining !== null) {
      process.stderr.write(
        `[orager daemon] OpenRouter credits OK ($${info.remaining.toFixed(2)} remaining)\n`,
      );
    }
  } catch {
    // Non-fatal — ignore check failures
  }
}

// ── Idle shutdown ─────────────────────────────────────────────────────────────

export function scheduleIdleCheck(
  ctx: DaemonContext,
  drainFn: (timeoutMs: number) => Promise<void>,
  drainTimeoutMs: number,
): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    if (ctx.activeRuns === 0 && Date.now() - ctx.lastActivityAt > ctx.idleTimeoutMs) {
      process.stderr.write("[orager daemon] idle timeout — shutting down\n");
      void drainFn(drainTimeoutMs);
    }
  }, 60_000);
  if (timer.unref) timer.unref();
  return timer;
}
