/**
 * GET /metrics — operational metrics (JWT-authenticated).
 *
 * Returns run counters, provider health, circuit breaker states, and
 * cached API key info. Requires a valid Bearer JWT to prevent leaking
 * internal state to unauthenticated local processes.
 */
import http from "node:http";
import { verifyJwtDualKey } from "../context.js";
import { getCachedKeyInfo } from "../key-cache.js";
import { getAllProviderStats, getDegradedProviders } from "../../provider-health.js";
import { getRateLimitState } from "../../rate-limit-tracker.js";
import { getAllAgentCircuitBreakerStates } from "../../circuit-breaker.js";
import type { DaemonContext } from "../context.js";

export function handleMetrics(
  ctx: DaemonContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const authHeader = req.headers["authorization"] ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) { res.writeHead(401); res.end(); return; }
  try {
    verifyJwtDualKey(ctx, token);
  } catch {
    res.writeHead(403); res.end(); return;
  }

  void (async () => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      activeRuns: ctx.activeRuns,
      maxConcurrent: ctx.maxConcurrent,
      completedRuns: ctx.completedRuns,
      errorRuns: ctx.errorRuns,
      draining: ctx.draining,
      uptimeMs: Date.now() - ctx.daemonStartedAt,
      model: ctx.model,
      usedModels: Array.from(ctx.usedModels),
      recentModels: (() => {
        const cutoff = Date.now() - 60 * 60 * 1000; // 1 hour
        return Array.from(ctx.modelLastUsedAt.entries())
          .filter(([, ts]) => ts >= cutoff)
          .map(([m]) => m);
      })(),
      modelUsageTimestamps: Object.fromEntries(ctx.modelLastUsedAt),
      activeRunsByAgent: Object.fromEntries(ctx.activeRunsByAgent),
      providerHealth: getAllProviderStats(),
      degradedProviders: getDegradedProviders(),
      dbBackend: process.env["ORAGER_DB_PATH"] ? "sqlite" : "filesystem",
      dbPath: process.env["ORAGER_DB_PATH"] ?? null,
      rateLimit: getRateLimitState(),
      keyInfo: await getCachedKeyInfo(ctx.apiKey),
      circuitBreakersByAgent: getAllAgentCircuitBreakerStates(),
      costByAgent: Object.fromEntries(ctx.costByAgent),
    }));
  })();
}

/**
 * GET /metrics/prometheus — Prometheus exposition format (audit E-13).
 * Requires JWT authentication like /metrics.
 */
export function handleMetricsPrometheus(
  ctx: DaemonContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const authHeader = req.headers["authorization"] ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) { res.writeHead(401); res.end(); return; }
  try {
    verifyJwtDualKey(ctx, token);
  } catch {
    res.writeHead(403); res.end(); return;
  }

  const lines: string[] = [];
  const ts = Date.now();

  lines.push("# HELP orager_active_runs Number of currently active agent runs");
  lines.push("# TYPE orager_active_runs gauge");
  lines.push(`orager_active_runs ${ctx.activeRuns} ${ts}`);

  lines.push("# HELP orager_max_concurrent Maximum allowed concurrent runs");
  lines.push("# TYPE orager_max_concurrent gauge");
  lines.push(`orager_max_concurrent ${ctx.maxConcurrent} ${ts}`);

  lines.push("# HELP orager_completed_runs_total Total completed runs since startup");
  lines.push("# TYPE orager_completed_runs_total counter");
  lines.push(`orager_completed_runs_total ${ctx.completedRuns} ${ts}`);

  lines.push("# HELP orager_error_runs_total Total errored runs since startup");
  lines.push("# TYPE orager_error_runs_total counter");
  lines.push(`orager_error_runs_total ${ctx.errorRuns} ${ts}`);

  lines.push("# HELP orager_uptime_seconds Daemon uptime in seconds");
  lines.push("# TYPE orager_uptime_seconds gauge");
  lines.push(`orager_uptime_seconds ${Math.floor((Date.now() - ctx.daemonStartedAt) / 1000)} ${ts}`);

  lines.push("# HELP orager_agent_cost_usd Cumulative cost per agent in USD");
  lines.push("# TYPE orager_agent_cost_usd counter");
  for (const [agent, cost] of ctx.costByAgent) {
    lines.push(`orager_agent_cost_usd{agent_id="${agent.replace(/"/g, '\\"')}"} ${cost} ${ts}`);
  }

  lines.push("# HELP orager_active_runs_by_agent Active runs per agent");
  lines.push("# TYPE orager_active_runs_by_agent gauge");
  for (const [agent, count] of ctx.activeRunsByAgent) {
    lines.push(`orager_active_runs_by_agent{agent_id="${agent.replace(/"/g, '\\"')}"} ${count} ${ts}`);
  }

  lines.push("");
  const body = lines.join("\n");
  res.writeHead(200, {
    "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}
