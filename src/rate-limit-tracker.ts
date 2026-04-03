/**
 * Tracks OpenRouter rate limit state from response headers.
 *
 * OpenRouter returns these headers on every response:
 *   X-RateLimit-Limit-Requests      — total request budget
 *   X-RateLimit-Remaining-Requests  — remaining requests
 *   X-RateLimit-Limit-Tokens        — total token budget
 *   X-RateLimit-Remaining-Tokens    — remaining tokens
 *   X-RateLimit-Reset-Requests      — ISO timestamp when request budget resets
 *   X-RateLimit-Reset-Tokens        — ISO timestamp when token budget resets
 *
 * When the remaining budget drops below WARNING_THRESHOLD_PCT of the limit,
 * isNearLimit() returns true so callers can slow down or warn.
 */

export interface RateLimitState {
  limitRequests: number;
  remainingRequests: number;
  limitTokens: number;
  remainingTokens: number;
  resetRequestsAt: Date | null;
  resetTokensAt: Date | null;
  updatedAt: Date;
}

const WARNING_THRESHOLD_PCT = 0.1; // warn at 10% remaining

/**
 * Parse a reset-timestamp string from a rate-limit header into a Date.
 * Returns null if the string is absent or not a valid date — guards against
 * malformed / proxy-modified headers propagating NaN into downstream math.
 */
function parseResetDate(s: string | null): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : null;
}

export class RateLimitTracker {
  private _state: RateLimitState | null = null;

  updateFromHeaders(headers: Headers | Record<string, string | null>): void {
    const get = (k: string): string | null =>
      typeof (headers as Headers).get === "function"
        ? (headers as Headers).get(k)
        : (headers as Record<string, string | null>)[k] ?? null;

    const limitReq     = parseInt(get("x-ratelimit-limit-requests")     ?? "", 10);
    const remainReq    = parseInt(get("x-ratelimit-remaining-requests")  ?? "", 10);
    const limitTok     = parseInt(get("x-ratelimit-limit-tokens")        ?? "", 10);
    const remainTok    = parseInt(get("x-ratelimit-remaining-tokens")    ?? "", 10);
    const resetReqStr  = get("x-ratelimit-reset-requests");
    const resetTokStr  = get("x-ratelimit-reset-tokens");

    if (!Number.isFinite(limitReq) || !Number.isFinite(remainReq) ||
        !Number.isFinite(limitTok) || !Number.isFinite(remainTok)) return;
    if (limitReq === 0 && limitTok === 0) return;

    this._state = {
      limitRequests:     limitReq,
      remainingRequests: remainReq,
      limitTokens:       limitTok,
      remainingTokens:   remainTok,
      resetRequestsAt:   parseResetDate(resetReqStr),
      resetTokensAt:     parseResetDate(resetTokStr),
      updatedAt:         new Date(),
    };
  }

  getState(): RateLimitState | null { return this._state; }

  isNearLimit(): boolean {
    if (!this._state) return false;
    if (this._state.limitRequests > 0 && this._state.remainingRequests / this._state.limitRequests < WARNING_THRESHOLD_PCT) return true;
    if (this._state.limitTokens > 0 && this._state.remainingTokens / this._state.limitTokens < WARNING_THRESHOLD_PCT) return true;
    return false;
  }

  summary(): string {
    if (!this._state) return "no rate limit data";
    const reqPct = this._state.limitRequests > 0
      ? ` (${Math.round((this._state.remainingRequests / this._state.limitRequests) * 100)}% req remaining)`
      : "";
    const tokPct = this._state.limitTokens > 0
      ? ` (${Math.round((this._state.remainingTokens / this._state.limitTokens) * 100)}% tok remaining)`
      : "";
    return `${this._state.remainingRequests}/${this._state.limitRequests} requests${reqPct}, ${this._state.remainingTokens}/${this._state.limitTokens} tokens${tokPct}`;
  }
}

/** Process-level singleton for backward compatibility. Per-session code should use RateLimitTracker instances. */
let _singletonTracker = new RateLimitTracker();

/** Reset the singleton tracker state — for testing only. */
export function _resetRateLimitTrackerForTesting(): void {
  _singletonTracker = new RateLimitTracker();
}

/**
 * Update rate limit state from response headers. Call after each API response.
 */
export function updateRateLimitState(headers: Headers | Record<string, string | null>): void {
  _singletonTracker.updateFromHeaders(headers);
}

/** Returns the current rate limit state, or null if no headers seen yet. */
export function getRateLimitState(): RateLimitState | null {
  return _singletonTracker.getState();
}

/**
 * Returns true when either requests or tokens remaining is below
 * WARNING_THRESHOLD_PCT of the limit.
 */
export function isNearRateLimit(): boolean {
  return _singletonTracker.isNearLimit();
}

/** Formatted summary for logging. */
export function rateLimitSummary(): string {
  return _singletonTracker.summary();
}
