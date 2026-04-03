import { describe, it, expect, beforeEach, vi } from "vitest";

// Reset the singleton tracker state before each test.
// vi.resetModules() is a no-op under bun, so we also call
// _resetRateLimitTrackerForTesting() explicitly.
beforeEach(async () => {
  vi.resetModules();
  const { _resetRateLimitTrackerForTesting } = await import("../src/rate-limit-tracker.js");
  _resetRateLimitTrackerForTesting();
});

describe("getRateLimitState", () => {
  it("returns null before any update", async () => {
    const { getRateLimitState } = await import("../src/rate-limit-tracker.js");
    expect(getRateLimitState()).toBeNull();
  });
});

describe("updateRateLimitState", () => {
  it("does not update state when all limit values are zero (guard condition)", async () => {
    const { updateRateLimitState, getRateLimitState } = await import("../src/rate-limit-tracker.js");
    updateRateLimitState({
      "x-ratelimit-limit-requests": "0",
      "x-ratelimit-remaining-requests": "0",
      "x-ratelimit-limit-tokens": "0",
      "x-ratelimit-remaining-tokens": "0",
    });
    expect(getRateLimitState()).toBeNull();
  });

  it("sets state correctly from a plain Record with valid headers", async () => {
    const { updateRateLimitState, getRateLimitState } = await import("../src/rate-limit-tracker.js");
    updateRateLimitState({
      "x-ratelimit-limit-requests": "1000",
      "x-ratelimit-remaining-requests": "800",
      "x-ratelimit-limit-tokens": "500000",
      "x-ratelimit-remaining-tokens": "450000",
      "x-ratelimit-reset-requests": "2026-03-26T12:00:00.000Z",
      "x-ratelimit-reset-tokens": "2026-03-26T12:00:00.000Z",
    });
    const state = getRateLimitState();
    expect(state).not.toBeNull();
    expect(state!.limitRequests).toBe(1000);
    expect(state!.remainingRequests).toBe(800);
    expect(state!.limitTokens).toBe(500000);
    expect(state!.remainingTokens).toBe(450000);
    expect(state!.updatedAt).toBeInstanceOf(Date);
  });

  it("parses reset date strings into Date objects", async () => {
    const { updateRateLimitState, getRateLimitState } = await import("../src/rate-limit-tracker.js");
    const resetStr = "2026-03-26T15:30:00.000Z";
    updateRateLimitState({
      "x-ratelimit-limit-requests": "100",
      "x-ratelimit-remaining-requests": "50",
      "x-ratelimit-limit-tokens": "0",
      "x-ratelimit-remaining-tokens": "0",
      "x-ratelimit-reset-requests": resetStr,
      "x-ratelimit-reset-tokens": resetStr,
    });
    const state = getRateLimitState();
    expect(state!.resetRequestsAt).toBeInstanceOf(Date);
    expect(state!.resetTokensAt).toBeInstanceOf(Date);
    expect(state!.resetRequestsAt!.toISOString()).toBe(resetStr);
  });

  it("handles Headers object input format", async () => {
    const { updateRateLimitState, getRateLimitState } = await import("../src/rate-limit-tracker.js");
    const headers = new Headers({
      "x-ratelimit-limit-requests": "200",
      "x-ratelimit-remaining-requests": "180",
      "x-ratelimit-limit-tokens": "100000",
      "x-ratelimit-remaining-tokens": "90000",
    });
    updateRateLimitState(headers);
    const state = getRateLimitState();
    expect(state).not.toBeNull();
    expect(state!.limitRequests).toBe(200);
    expect(state!.remainingRequests).toBe(180);
    expect(state!.limitTokens).toBe(100000);
    expect(state!.remainingTokens).toBe(90000);
  });
});

describe("isNearRateLimit", () => {
  it("returns false when state is null", async () => {
    const { isNearRateLimit } = await import("../src/rate-limit-tracker.js");
    expect(isNearRateLimit()).toBe(false);
  });

  it("returns false when well above threshold (90% remaining)", async () => {
    const { updateRateLimitState, isNearRateLimit } = await import("../src/rate-limit-tracker.js");
    updateRateLimitState({
      "x-ratelimit-limit-requests": "1000",
      "x-ratelimit-remaining-requests": "900", // 90% remaining
      "x-ratelimit-limit-tokens": "500000",
      "x-ratelimit-remaining-tokens": "450000", // 90% remaining
    });
    expect(isNearRateLimit()).toBe(false);
  });

  it("returns true when requests are near limit (< 10% remaining)", async () => {
    const { updateRateLimitState, isNearRateLimit } = await import("../src/rate-limit-tracker.js");
    updateRateLimitState({
      "x-ratelimit-limit-requests": "1000",
      "x-ratelimit-remaining-requests": "50", // 5% remaining — near limit
      "x-ratelimit-limit-tokens": "500000",
      "x-ratelimit-remaining-tokens": "400000", // 80% remaining — fine
    });
    expect(isNearRateLimit()).toBe(true);
  });

  it("returns true when tokens are near limit (< 10% remaining)", async () => {
    const { updateRateLimitState, isNearRateLimit } = await import("../src/rate-limit-tracker.js");
    updateRateLimitState({
      "x-ratelimit-limit-requests": "1000",
      "x-ratelimit-remaining-requests": "800", // 80% remaining — fine
      "x-ratelimit-limit-tokens": "500000",
      "x-ratelimit-remaining-tokens": "20000", // 4% remaining — near limit
    });
    expect(isNearRateLimit()).toBe(true);
  });
});

describe("rateLimitSummary", () => {
  it("returns 'no rate limit data' when state is null", async () => {
    const { rateLimitSummary } = await import("../src/rate-limit-tracker.js");
    expect(rateLimitSummary()).toBe("no rate limit data");
  });

  it("returns formatted string with percentages after update", async () => {
    const { updateRateLimitState, rateLimitSummary } = await import("../src/rate-limit-tracker.js");
    updateRateLimitState({
      "x-ratelimit-limit-requests": "1000",
      "x-ratelimit-remaining-requests": "750",
      "x-ratelimit-limit-tokens": "500000",
      "x-ratelimit-remaining-tokens": "250000",
    });
    const summary = rateLimitSummary();
    expect(summary).toContain("750");
    expect(summary).toContain("1000");
    expect(summary).toContain("75%");
    expect(summary).toContain("250000");
    expect(summary).toContain("500000");
    expect(summary).toContain("50%");
  });
});

describe("invalid reset-date header handling", () => {
  it("stores null for resetRequestsAt when header value is not a valid date", async () => {
    const { updateRateLimitState, getRateLimitState } = await import("../src/rate-limit-tracker.js");
    updateRateLimitState({
      "x-ratelimit-limit-requests": "1000",
      "x-ratelimit-remaining-requests": "10",
      "x-ratelimit-limit-tokens": "500000",
      "x-ratelimit-remaining-tokens": "5000",
      "x-ratelimit-reset-requests": "not-a-date",
      "x-ratelimit-reset-tokens":   "also-invalid",
    });
    const state = getRateLimitState();
    expect(state).not.toBeNull();
    expect(state!.resetRequestsAt).toBeNull();
    expect(state!.resetTokensAt).toBeNull();
  });

  it("stores null for resetRequestsAt when header value is an empty string", async () => {
    const { updateRateLimitState, getRateLimitState } = await import("../src/rate-limit-tracker.js");
    updateRateLimitState({
      "x-ratelimit-limit-requests": "100",
      "x-ratelimit-remaining-requests": "5",
      "x-ratelimit-limit-tokens": "0",
      "x-ratelimit-remaining-tokens": "0",
      "x-ratelimit-reset-requests": "",
    });
    const state = getRateLimitState();
    expect(state!.resetRequestsAt).toBeNull();
  });

  it("still stores a valid date alongside an invalid one", async () => {
    const { updateRateLimitState, getRateLimitState } = await import("../src/rate-limit-tracker.js");
    const validDate = "2026-04-03T12:00:00.000Z";
    updateRateLimitState({
      "x-ratelimit-limit-requests": "1000",
      "x-ratelimit-remaining-requests": "10",
      "x-ratelimit-limit-tokens": "500000",
      "x-ratelimit-remaining-tokens": "5000",
      "x-ratelimit-reset-requests": validDate,
      "x-ratelimit-reset-tokens":   "garbage",
    });
    const state = getRateLimitState();
    expect(state!.resetRequestsAt?.toISOString()).toBe(validDate);
    expect(state!.resetTokensAt).toBeNull();
  });
});
