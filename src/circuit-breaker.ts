/**
 * Simple three-state circuit breaker for the OpenRouter API client.
 *
 * States:
 *   CLOSED   — Normal operation. Failures are counted.
 *   OPEN     — Fast-fail mode. All calls are rejected immediately.
 *              Transitions to HALF_OPEN after resetAfterMs.
 *   HALF_OPEN — One test request is allowed through.
 *              Closes on success, re-opens on failure.
 *
 * Usage:
 *   const cb = new CircuitBreaker();
 *   if (cb.isOpen()) throw new Error("circuit open");
 *   try {
 *     const result = await callOpenRouter(...);
 *     cb.recordSuccess();
 *     return result;
 *   } catch (err) {
 *     cb.recordFailure();
 *     throw err;
 *   }
 */

type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  /** Number of consecutive failures before opening the circuit. Default 3. */
  threshold?: number;
  /** How long (ms) to keep the circuit open before testing again. Default 30 000. */
  resetAfterMs?: number;
}

export class CircuitBreaker {
  private state: CircuitState = "closed";
  consecutiveFailures = 0;
  private openedAt = 0;
  private _halfOpenInFlight = false;

  readonly threshold: number;
  readonly resetAfterMs: number;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.threshold = opts.threshold ?? 3;
    this.resetAfterMs = opts.resetAfterMs ?? 30_000;
  }

  /**
   * Returns true when the circuit is OPEN (fast-fail) or HALF_OPEN pending a
   * test. Callers should skip the actual network call and surface an error.
   *
   * After `resetAfterMs` has elapsed since opening, the first `isOpen()` call
   * transitions to HALF_OPEN so one test request can proceed.
   */
  isOpen(): boolean {
    if (this.state === "closed") return false;

    if (this.state === "open") {
      if (Date.now() - this.openedAt >= this.resetAfterMs) {
        // Transition to half-open — allow exactly one test request through.
        // Set _halfOpenInFlight atomically here so a second caller racing this
        // transition sees the flag set and is blocked.
        this.state = "half-open";
        this._halfOpenInFlight = true;
        return false;
      }
      return true;
    }

    // HALF_OPEN: exactly one test request allowed — block subsequent calls until
    // the in-flight test resolves via recordSuccess / recordFailure.
    if (this._halfOpenInFlight) return true;
    this._halfOpenInFlight = true;
    return false;
  }

  /** Call after a successful API response. Resets the breaker to CLOSED. */
  recordSuccess(): void {
    this._halfOpenInFlight = false;
    this.consecutiveFailures = 0;
    this.state = "closed";
  }

  /**
   * Call after a failed API response (any non-success, including rate limits
   * and timeouts).  Opens the circuit once the threshold is reached.
   */
  recordFailure(): void {
    this._halfOpenInFlight = false;
    this.consecutiveFailures++;
    if (this.state === "half-open" || this.consecutiveFailures >= this.threshold) {
      this.state = "open";
      this.openedAt = Date.now();
    }
  }

  /** Current state string — useful for logging. */
  get currentState(): CircuitState {
    return this.state;
  }

  /** Seconds until the circuit tries again (0 if already half-open or closed). */
  get retryInMs(): number {
    if (this.state !== "open") return 0;
    return Math.max(0, this.resetAfterMs - (Date.now() - this.openedAt));
  }
}

/**
 * Process-level singleton. Shared across all turns in the current run so that
 * a sustained outage detected in one turn prevents hammering in subsequent turns.
 */
export const openRouterCircuitBreaker = new CircuitBreaker({
  threshold: 3,
  resetAfterMs: 30_000,
});

// ── Per-agent circuit breaker map ─────────────────────────────────────────────
// Keyed by agentId so one agent's failure streak cannot block other agents.
// Each entry records a lastUsed timestamp so idle entries can be evicted.
const CB_IDLE_EVICT_MS = 60 * 60 * 1000; // 1 hour
const CB_EVICT_INTERVAL_MS = 10 * 60 * 1000; // check every 10 minutes

interface AgentCbEntry {
  cb: CircuitBreaker;
  lastUsed: number;
}
const _agentCircuitBreakers = new Map<string, AgentCbEntry>();

// Start a background eviction timer (unref'd so it doesn't keep the process alive).
const _cbEvictTimer = setInterval(() => {
  const cutoff = Date.now() - CB_IDLE_EVICT_MS;
  for (const [id, entry] of _agentCircuitBreakers) {
    if (entry.lastUsed < cutoff) _agentCircuitBreakers.delete(id);
  }
}, CB_EVICT_INTERVAL_MS);
if (typeof _cbEvictTimer.unref === "function") _cbEvictTimer.unref();

/**
 * Returns (or lazily creates) a per-agent CircuitBreaker keyed by agentId.
 * Ensures that one noisy agent's sustained failures do not block other agents
 * running concurrently on the same daemon process.
 */
export function getAgentCircuitBreaker(
  agentId: string,
  opts: CircuitBreakerOptions = {},
): CircuitBreaker {
  let entry = _agentCircuitBreakers.get(agentId);
  if (!entry) {
    entry = {
      cb: new CircuitBreaker({
        threshold:    opts.threshold    ?? 3,
        resetAfterMs: opts.resetAfterMs ?? 30_000,
      }),
      lastUsed: Date.now(),
    };
    _agentCircuitBreakers.set(agentId, entry);
  } else {
    entry.lastUsed = Date.now();
  }
  return entry.cb;
}

/** Remove a specific agent's circuit breaker (e.g. to reset state after a clean run). */
export function clearAgentCircuitBreaker(agentId: string): void {
  _agentCircuitBreakers.delete(agentId);
}

/** Clear ALL per-agent circuit breakers — intended for test teardown only. */
export function clearAllAgentCircuitBreakers(): void {
  _agentCircuitBreakers.clear();
}

/** Set the lastUsed timestamp for a specific agent — for testing only. */
export function _setAgentLastUsedForTesting(agentId: string, timestamp: number): void {
  const entry = _agentCircuitBreakers.get(agentId);
  if (entry) entry.lastUsed = timestamp;
}

/** Run the eviction pass immediately using the real cutoff — for testing only. */
export function _runEvictionNowForTesting(): void {
  const cutoff = Date.now() - CB_IDLE_EVICT_MS;
  for (const [id, entry] of _agentCircuitBreakers) {
    if (entry.lastUsed < cutoff) _agentCircuitBreakers.delete(id);
  }
}

/**
 * Returns a snapshot of all per-agent circuit breaker states.
 * Used by the daemon /metrics endpoint so operators can see which agents
 * are currently experiencing circuit-open conditions.
 */
export function getAllAgentCircuitBreakerStates(): Record<string, {
  state: string;
  consecutiveFailures: number;
  retryInMs: number;
}> {
  const result: Record<string, { state: string; consecutiveFailures: number; retryInMs: number }> = {};
  for (const [agentId, { cb }] of _agentCircuitBreakers) {
    result[agentId] = {
      state: cb.currentState,
      consecutiveFailures: cb.consecutiveFailures,
      retryInMs: cb.retryInMs,
    };
  }
  return result;
}
