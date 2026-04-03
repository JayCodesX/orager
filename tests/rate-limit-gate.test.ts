/**
 * Integration tests for rate-limit-gate.ts (waitIfRateLimited).
 *
 * Uses fake timers to assert that the gate sleeps for the correct duration
 * based on the RateLimitState provided.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { waitIfRateLimited } from "../src/rate-limit-gate.js";
import type { RateLimitState } from "../src/rate-limit-tracker.js";

function makeState(overrides: Partial<RateLimitState> = {}): RateLimitState {
  return {
    limitRequests: 0,
    remainingRequests: 0,
    limitTokens: 0,
    remainingTokens: 0,
    resetRequestsAt: null,
    resetTokensAt: null,
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("waitIfRateLimited", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("returns immediately when state is null", async () => {
    const p = waitIfRateLimited(null);
    // resolve without advancing timers
    await p;
  });

  it("returns immediately when both budgets are healthy (> 5%)", async () => {
    const state = makeState({ limitRequests: 100, remainingRequests: 10 }); // 10%
    const p = waitIfRateLimited(state);
    await p; // should resolve without advancing timers
  });

  it("sleeps until resetRequestsAt when requests near exhaustion", async () => {
    const resetAt = new Date(Date.now() + 5_000);
    const state = makeState({ limitRequests: 100, remainingRequests: 2, resetRequestsAt: resetAt });

    let resolved = false;
    const p = waitIfRateLimited(state).then(() => { resolved = true; });

    vi.advanceTimersByTime(4_999);
    await Promise.resolve(); // flush microtasks
    expect(resolved).toBe(false);

    vi.advanceTimersByTime(2);
    await p;
    expect(resolved).toBe(true);
  });

  it("sleeps until resetTokensAt when tokens near exhaustion", async () => {
    const resetAt = new Date(Date.now() + 3_000);
    const state = makeState({ limitTokens: 10_000, remainingTokens: 100, resetTokensAt: resetAt }); // 1%

    let resolved = false;
    const p = waitIfRateLimited(state).then(() => { resolved = true; });

    vi.advanceTimersByTime(2_999);
    await Promise.resolve();
    expect(resolved).toBe(false);

    vi.advanceTimersByTime(2);
    await p;
    expect(resolved).toBe(true);
  });

  it("caps wait at MAX_WAIT_MS (60 s) for far-future resets", async () => {
    const farFuture = new Date(Date.now() + 300_000); // 5 minutes
    const state = makeState({ limitRequests: 100, remainingRequests: 1, resetRequestsAt: farFuture });

    let resolved = false;
    const p = waitIfRateLimited(state).then(() => { resolved = true; });

    vi.advanceTimersByTime(60_001);
    await p;
    expect(resolved).toBe(true);
  });

  it("falls back to 2 000 ms conservative back-off when no reset timestamp", async () => {
    const state = makeState({ limitRequests: 100, remainingRequests: 1 });

    let resolved = false;
    const p = waitIfRateLimited(state).then(() => { resolved = true; });

    vi.advanceTimersByTime(1_999);
    await Promise.resolve();
    expect(resolved).toBe(false);

    vi.advanceTimersByTime(2);
    await p;
    expect(resolved).toBe(true);
  });

  it("calls onLog with kind and remaining when gate activates", async () => {
    const resetAt = new Date(Date.now() + 1_000);
    const state = makeState({ limitRequests: 100, remainingRequests: 3, resetRequestsAt: resetAt });
    const logs: string[] = [];

    const p = waitIfRateLimited(state, (msg) => logs.push(msg));
    vi.advanceTimersByTime(1_001);
    await p;

    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0]).toContain("requests");
    expect(logs[0]).toContain("3");
  });

  it("does not call onLog when budget is healthy", async () => {
    const state = makeState({ limitRequests: 100, remainingRequests: 50 });
    const logs: string[] = [];
    await waitIfRateLimited(state, (msg) => logs.push(msg));
    expect(logs).toHaveLength(0);
  });

  it("falls back to 2 000 ms conservative back-off when reset header is a malformed date string", async () => {
    // Without the parseResetDate fix in RateLimitTracker, new Date("not-a-date")
    // would be stored as-is and propagate NaN into the gate:
    //   Math.min(NaN) → NaN → setTimeout(fn, NaN) → fires at 0 ms (no wait).
    // After the fix, parseResetDate returns null for invalid strings, so
    // resetRequestsAt is null and the gate falls back to the 2 s conservative backoff.
    const { RateLimitTracker } = await import("../src/rate-limit-tracker.js");
    const tracker = new RateLimitTracker();
    tracker.updateFromHeaders({
      "x-ratelimit-limit-requests": "100",
      "x-ratelimit-remaining-requests": "2",   // < 5% — triggers gate
      "x-ratelimit-limit-tokens": "0",
      "x-ratelimit-remaining-tokens": "0",
      "x-ratelimit-reset-requests": "not-a-date", // malformed — must not produce NaN
    });
    const state = tracker.getState()!;
    expect(state.resetRequestsAt).toBeNull(); // fix: stored as null, not Invalid Date

    let resolved = false;
    const p = waitIfRateLimited(state).then(() => { resolved = true; });

    // Must NOT resolve immediately — that would mean the gate fired at 0 ms
    await Promise.resolve();
    expect(resolved).toBe(false);

    // Should resolve after the 2 000 ms conservative back-off
    vi.advanceTimersByTime(1_999);
    await Promise.resolve();
    expect(resolved).toBe(false);

    vi.advanceTimersByTime(2);
    await p;
    expect(resolved).toBe(true);
  });
});
