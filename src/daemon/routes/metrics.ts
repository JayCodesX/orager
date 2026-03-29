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
    }));
  })();
}
