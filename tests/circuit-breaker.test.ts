import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CircuitBreaker, getAgentCircuitBreaker, clearAllAgentCircuitBreakers } from "../src/circuit-breaker.js";

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
