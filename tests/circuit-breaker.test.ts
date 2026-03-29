import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  CircuitBreaker,
  getAgentCircuitBreaker,
  clearAllAgentCircuitBreakers,
  getAllAgentCircuitBreakerStates,
  _setAgentLastUsedForTesting,
  _runEvictionNowForTesting,
} from "../src/circuit-breaker.js";

describe("CircuitBreaker", () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    cb = new CircuitBreaker({ threshold: 3, resetAfterMs: 1000 });
  });

  it("starts closed", () => {
    expect(cb.currentState).toBe("closed");
    expect(cb.isOpen()).toBe(false);
  });

  it("opens after threshold consecutive failures", () => {
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.currentState).toBe("closed");
    cb.recordFailure();
    expect(cb.currentState).toBe("open");
    expect(cb.isOpen()).toBe(true);
  });

  it("resets to closed on success", () => {
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.currentState).toBe("open");
    cb.recordSuccess();
    expect(cb.currentState).toBe("closed");
    expect(cb.isOpen()).toBe(false);
  });

  it("transitions to half-open after resetAfterMs", async () => {
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.isOpen()).toBe(true);

    // Fake time passing
    vi.useFakeTimers();
    vi.advanceTimersByTime(1001);
    expect(cb.isOpen()).toBe(false); // half-open: lets one through
    expect(cb.currentState).toBe("half-open");
    vi.useRealTimers();
  });

  it("re-opens from half-open on failure", () => {
    const cb2 = new CircuitBreaker({ threshold: 1, resetAfterMs: 0 });
    cb2.recordFailure();
    expect(cb2.isOpen()).toBe(false); // transitions to half-open immediately
    cb2.recordFailure();
    expect(cb2.currentState).toBe("open");
  });

  it("closes from half-open on success", () => {
    const cb2 = new CircuitBreaker({ threshold: 1, resetAfterMs: 0 });
    cb2.recordFailure();
    cb2.isOpen(); // transition to half-open
    cb2.recordSuccess();
    expect(cb2.currentState).toBe("closed");
  });

  it("retryInMs is positive when open, 0 otherwise", () => {
    expect(cb.retryInMs).toBe(0);
    cb.recordFailure(); cb.recordFailure(); cb.recordFailure();
    expect(cb.retryInMs).toBeGreaterThan(0);
    expect(cb.retryInMs).toBeLessThanOrEqual(1000);
  });
});

// ── Per-agent circuit breaker isolation (A1) ──────────────────────────────────

describe("getAgentCircuitBreaker — per-agent isolation (A1)", () => {
  afterEach(() => {
    clearAllAgentCircuitBreakers();
  });

  it("returns a CircuitBreaker instance for a given agentId", () => {
    const cb = getAgentCircuitBreaker("agent-1");
    expect(cb).toBeDefined();
    expect(cb.currentState).toBe("closed");
  });

  it("returns the same instance on repeated calls for the same agentId", () => {
    const cb1 = getAgentCircuitBreaker("agent-1");
    const cb2 = getAgentCircuitBreaker("agent-1");
    expect(cb1).toBe(cb2);
  });

  it("returns different instances for different agentIds", () => {
    const cb1 = getAgentCircuitBreaker("agent-1");
    const cb2 = getAgentCircuitBreaker("agent-2");
    expect(cb1).not.toBe(cb2);
  });

  it("tripping one agent's CB does not affect another agent", () => {
    const cb1 = getAgentCircuitBreaker("agent-noisy");
    const cb2 = getAgentCircuitBreaker("agent-clean");

    // Trip agent-noisy's circuit
    cb1.recordFailure();
    cb1.recordFailure();
    cb1.recordFailure(); // threshold = 3

    expect(cb1.isOpen()).toBe(true);
    // agent-clean should be unaffected
    expect(cb2.isOpen()).toBe(false);
  });

  it("clearAllAgentCircuitBreakers resets state for all agents", () => {
    const cb = getAgentCircuitBreaker("agent-tripped");
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.isOpen()).toBe(true);

    clearAllAgentCircuitBreakers();

    // After clear, a fresh CB is returned for the same agentId
    const fresh = getAgentCircuitBreaker("agent-tripped");
    expect(fresh.isOpen()).toBe(false);
    expect(fresh.currentState).toBe("closed");
  });
});

// ── T-gap2: daemon run handler — circuit breaker state transitions ─────────────
// Simulates the daemon's runAgentLoop integration pattern:
//   let _runFailed = false;
//   runAgentLoop(loopOpts)
//     .catch(() => { _runFailed = true; agentCb.recordFailure(); })
//     .finally(() => { if (!_runFailed) agentCb.recordSuccess(); });
// This verifies the glue code logic between daemon.ts and circuit-breaker.ts.

describe("daemon run pattern — circuit breaker state transitions (T-gap2)", () => {
  afterEach(() => {
    clearAllAgentCircuitBreakers();
  });

  /** Simulate the daemon's runAgentLoop .catch/.finally CB update pattern. */
  async function simulateDaemonRun(agentId: string, succeeds: boolean): Promise<void> {
    const agentCb = getAgentCircuitBreaker(agentId);
    let _runFailed = false;
    const runPromise = succeeds
      ? Promise.resolve()
      : Promise.reject(new Error("mock run failure"));
    await runPromise
      .catch(() => {
        _runFailed = true;
        agentCb.recordFailure();
      })
      .finally(() => {
        if (!_runFailed) agentCb.recordSuccess();
      });
  }

  it("three consecutive failures open the agent circuit breaker (threshold=3)", async () => {
    const agentId = "daemon-agent-fail";
    const cb = getAgentCircuitBreaker(agentId);

    await simulateDaemonRun(agentId, false);
    await simulateDaemonRun(agentId, false);
    expect(cb.currentState).toBe("closed"); // not yet at threshold
    await simulateDaemonRun(agentId, false);
    expect(cb.isOpen()).toBe(true); // threshold reached
  });

  it("a successful run records success and keeps the CB closed", async () => {
    const agentId = "daemon-agent-ok";
    const cb = getAgentCircuitBreaker(agentId);

    await simulateDaemonRun(agentId, true);
    expect(cb.currentState).toBe("closed");
    expect(cb.isOpen()).toBe(false);
  });

  it("a successful run after partial failures keeps the CB closed", async () => {
    const agentId = "daemon-agent-partial";
    const cb = getAgentCircuitBreaker(agentId);

    // Two failures (below threshold)
    await simulateDaemonRun(agentId, false);
    await simulateDaemonRun(agentId, false);
    expect(cb.currentState).toBe("closed");

    // A successful run resets consecutive failures
    await simulateDaemonRun(agentId, true);
    expect(cb.currentState).toBe("closed");

    // Would need 3 more consecutive failures to open again
    await simulateDaemonRun(agentId, false);
    await simulateDaemonRun(agentId, false);
    expect(cb.currentState).toBe("closed"); // still under threshold
  });

  it("different agents accumulate independent failure counts", async () => {
    const agentA = "daemon-agent-a";
    const agentB = "daemon-agent-b";

    // Trip agentA to threshold
    for (let i = 0; i < 3; i++) await simulateDaemonRun(agentA, false);
    // agentB only has 2 failures
    for (let i = 0; i < 2; i++) await simulateDaemonRun(agentB, false);

    expect(getAgentCircuitBreaker(agentA).isOpen()).toBe(true);
    expect(getAgentCircuitBreaker(agentB).isOpen()).toBe(false);
  });
});

// ── TTL-based eviction of idle circuit breakers (Fix 7) ───────────────────────

describe("_agentCircuitBreakers TTL eviction (Fix 7)", () => {
  afterEach(() => {
    clearAllAgentCircuitBreakers();
  });

  it("evicts an agent whose lastUsed is older than CB_IDLE_EVICT_MS (1 hour)", () => {
    // Create a CB entry, then backdate its lastUsed past the eviction threshold.
    getAgentCircuitBreaker("agent-idle");
    // Backdate to 2 hours ago — comfortably past the 1-hour cutoff.
    _setAgentLastUsedForTesting("agent-idle", Date.now() - 2 * 60 * 60 * 1000);

    _runEvictionNowForTesting();

    const states = getAllAgentCircuitBreakerStates();
    expect(states["agent-idle"]).toBeUndefined();
  });

  it("does not evict an agent that was used recently", () => {
    getAgentCircuitBreaker("agent-active");
    // lastUsed is already Date.now() — well within the 1-hour window.
    _runEvictionNowForTesting();

    const states = getAllAgentCircuitBreakerStates();
    expect(states["agent-active"]).toBeDefined();
  });

  it("evicts only idle agents, leaving recently-used agents intact", () => {
    getAgentCircuitBreaker("agent-old");
    getAgentCircuitBreaker("agent-new");

    // Backdate only "agent-old"
    _setAgentLastUsedForTesting("agent-old", Date.now() - 2 * 60 * 60 * 1000);

    _runEvictionNowForTesting();

    const states = getAllAgentCircuitBreakerStates();
    expect(states["agent-old"]).toBeUndefined();
    expect(states["agent-new"]).toBeDefined();
  });

  it("preserves circuit state (open/closed) for non-evicted agents after eviction pass", () => {
    const cb = getAgentCircuitBreaker("agent-tripped-eviction");
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure(); // open
    expect(cb.isOpen()).toBe(true);

    // Eviction runs but agent is recent — it should remain
    _runEvictionNowForTesting();

    const states = getAllAgentCircuitBreakerStates();
    expect(states["agent-tripped-eviction"]?.state).toBe("open");
  });
});

describe("getAllAgentCircuitBreakerStates — metrics snapshot", () => {
  afterEach(() => {
    clearAllAgentCircuitBreakers();
  });

  it("returns empty object when no agents have circuit breakers", () => {
    clearAllAgentCircuitBreakers();
    const states = getAllAgentCircuitBreakerStates();
    expect(Object.keys(states)).toHaveLength(0);
  });

  it("includes state for agents with circuit breakers", () => {
    const cb = getAgentCircuitBreaker("agent-metrics-test");
    cb.recordFailure();
    const states = getAllAgentCircuitBreakerStates();
    expect(states["agent-metrics-test"]).toBeDefined();
    expect(states["agent-metrics-test"]!.state).toBe("closed");
    expect(states["agent-metrics-test"]!.consecutiveFailures).toBe(1);
  });

  it("reports open state and positive retryInMs for a tripped circuit", () => {
    const cb = getAgentCircuitBreaker("agent-tripped-metrics");
    cb.recordFailure(); cb.recordFailure(); cb.recordFailure();
    const states = getAllAgentCircuitBreakerStates();
    expect(states["agent-tripped-metrics"]!.state).toBe("open");
    expect(states["agent-tripped-metrics"]!.retryInMs).toBeGreaterThan(0);
  });
});
