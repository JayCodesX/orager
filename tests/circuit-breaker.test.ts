import { describe, it, expect, beforeEach, vi } from "vitest";
import { CircuitBreaker } from "../src/circuit-breaker.js";

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
