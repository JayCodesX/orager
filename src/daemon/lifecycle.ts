/**
 * Daemon lifecycle helpers: cache warming, keep-alive pings, idle shutdown,
 * credit checks, and audit logging.
 */
import { callOpenRouter } from "../openrouter.js";
import { fetchApiKeyInfo } from "../openrouter-key.js";
import type { DaemonContext } from "./context.js";

// ── Audit log ──────────────────────────────────────────────────────────────────
// Logs metadata only — never prompt or response content.

export function auditLog(entry: {
  timestamp: string;
  agentId: string;
  durationMs: number;
  status: "ok" | "error" | "timeout" | "rejected";
  statusCode: number;
}): void {
  process.stderr.write(`[orager daemon] ${JSON.stringify(entry)}\n`);
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
