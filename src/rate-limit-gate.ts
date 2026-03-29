/**
 * Pre-flight rate-limit gate for callWithRetry.
 *
 * When the per-run RateLimitTracker shows near-exhaustion (< 5% remaining),
 * this module sleeps until the earliest reset time instead of immediately
 * making a call that is very likely to return 429.
 *
 * Using a tighter threshold (5%) than the warning threshold (10%) so that
 * the warning in loop.ts fires first and the gate only activates when truly
 * at risk of exhaustion.
 */

import type { RateLimitState } from "./rate-limit-tracker.js";
import { trace } from "@opentelemetry/api";

/** Fraction of remaining budget below which the gate activates. */
const GATE_THRESHOLD = 0.05;

/** Maximum time to wait even if the reset timestamp is far in the future. */
const MAX_WAIT_MS = 60_000;

/**
 * If `state` shows near-exhaustion on requests or tokens, sleep until the
 * earliest reset time (capped at MAX_WAIT_MS). No-op if state is null or
 * the budget is healthy.
 *
 * @param state  Latest RateLimitState from the per-run tracker. Pass null to skip.
 * @param onLog  Optional structured log callback.
 */
export async function waitIfRateLimited(
  state: RateLimitState | null,
  onLog?: (msg: string) => void,
): Promise<void> {
  if (!state) return;

  const reqExhausted =
    state.limitRequests > 0 &&
    state.remainingRequests / state.limitRequests < GATE_THRESHOLD;
  const tokExhausted =
    state.limitTokens > 0 &&
    state.remainingTokens / state.limitTokens < GATE_THRESHOLD;

  if (!reqExhausted && !tokExhausted) return;

  // Determine how long to wait by looking at the earliest applicable reset time.
  const resetCandidates: Date[] = [];
  if (reqExhausted && state.resetRequestsAt) resetCandidates.push(state.resetRequestsAt);
  if (tokExhausted && state.resetTokensAt) resetCandidates.push(state.resetTokensAt);

  const now = Date.now();
  let waitMs: number;

  if (resetCandidates.length > 0) {
    const earliest = Math.min(...resetCandidates.map((d) => d.getTime()));
    waitMs = Math.max(0, earliest - now);
  } else {
    // No reset timestamp available — conservative back-off.
    waitMs = 2_000;
  }

  waitMs = Math.min(waitMs, MAX_WAIT_MS);
  if (waitMs <= 0) return;

  const kind = reqExhausted ? "requests" : "tokens";
  const remaining = reqExhausted ? state.remainingRequests : state.remainingTokens;
  onLog?.(
    `[orager] rate-limit ${kind} near exhaustion (${remaining} remaining)` +
      ` — waiting ${waitMs}ms for reset\n`,
  );
  trace.getActiveSpan()?.addEvent("rate_limit.gate_wait", {
    "rate_limit.kind": kind,
    "rate_limit.remaining": remaining,
    "rate_limit.wait_ms": waitMs,
  });
  await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
}
