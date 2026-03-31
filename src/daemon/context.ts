/**
 * Shared mutable state for the daemon, passed to all route handlers and
 * lifecycle helpers so they can coordinate without closures.
 */
import { verifyJwt } from "../jwt.js";

export interface DaemonContext {
  // ── Config (immutable after startup) ─────────────────────────────────────
  readonly port: number;
  readonly maxConcurrent: number;
  readonly perAgentMaxConcurrent: number;
  readonly apiKey: string;
  readonly model: string;
  readonly idleTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly allowedCwdPrefixes: string[] | undefined;
  readonly previousKeyTtlMs: number;

  // ── Key state (mutable — updated on rotation) ─────────────────────────────
  signingKey: string;
  previousKey: string | null;
  previousKeyExpiresAt: Date | null;

  // ── Run counters and tracking ─────────────────────────────────────────────
  activeRuns: number;
  activeRunsByAgent: Map<string, number>;
  activeRunControllers: Map<string, AbortController>;
  draining: boolean;
  completedRuns: number;
  errorRuns: number;

  // ── Timing ────────────────────────────────────────────────────────────────
  readonly daemonStartedAt: number;
  lastActivityAt: number;
  lastRealRequestAt: number;

  // ── Keep-alive ────────────────────────────────────────────────────────────
  keepAliveTimer: ReturnType<typeof setInterval> | null;
  usedModels: Set<string>;
  modelLastUsedAt: Map<string, number>;

  // ── Per-agent cost tracking (audit E-12) ─────────────────────────────────
  /** Cumulative cost in USD per agentId. */
  costByAgent: Map<string, number>;
  /** Max cost per agent in USD. 0 = unlimited. Configurable via ORAGER_MAX_COST_PER_AGENT. */
  readonly maxCostPerAgent: number;
}

/**
 * Verify a JWT against both the current signing key and (within the overlap
 * window) the previous key after a rotation. Throws if neither key validates.
 */
export function verifyJwtDualKey(
  ctx: DaemonContext,
  token: string,
): ReturnType<typeof verifyJwt> {
  try {
    return verifyJwt(token, ctx.signingKey);
  } catch (currentKeyErr) {
    if (
      ctx.previousKey &&
      ctx.previousKeyExpiresAt &&
      Date.now() < ctx.previousKeyExpiresAt.getTime()
    ) {
      return verifyJwt(token, ctx.previousKey);
    }
    throw currentKeyErr;
  }
}
