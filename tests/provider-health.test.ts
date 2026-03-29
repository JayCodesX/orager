import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  recordProviderSuccess,
  recordProviderError,
  isProviderDegraded,
  getDegradedProviders,
  getAllProviderStats,
  avgProviderLatencyMs,
} from "../src/provider-health.js";

// provider-health uses a module-level Map, so we use unique model/provider keys
// per test to avoid state bleed between tests.

describe("provider health tracking", () => {
  it("new provider is not degraded", () => {
    expect(isProviderDegraded("gpt-4o-new-test", "openai-new")).toBe(false);
  });

  it("marks degraded after 3 consecutive errors", () => {
    const model = "model-a-" + Math.random().toString(36).slice(2);
    const provider = "provider-x-" + Math.random().toString(36).slice(2);
    recordProviderError(model, provider, 100);
    recordProviderError(model, provider, 100);
    expect(isProviderDegraded(model, provider)).toBe(false);
    recordProviderError(model, provider, 100);
    expect(isProviderDegraded(model, provider)).toBe(true);
  });

  it("resets consecutive errors on success", () => {
    const model = "model-b-" + Math.random().toString(36).slice(2);
    const provider = "provider-y-" + Math.random().toString(36).slice(2);
    recordProviderError(model, provider, 100);
    recordProviderError(model, provider, 100);
    recordProviderError(model, provider, 100);
    expect(isProviderDegraded(model, provider)).toBe(true);
    recordProviderSuccess(model, provider, 50);
    expect(isProviderDegraded(model, provider)).toBe(false);
  });

  it("getDegradedProviders returns only degraded ones", () => {
    const model = "model-c-" + Math.random().toString(36).slice(2);
    const provider = "prov-z-" + Math.random().toString(36).slice(2);
    recordProviderError(model, provider, 100);
    recordProviderError(model, provider, 100);
    recordProviderError(model, provider, 100);
    const degraded = getDegradedProviders();
    expect(degraded.some((k) => k.includes(model))).toBe(true);
  });
});

// ── Computed fields (4-B) ────────────────────────────────────────────────────

describe("provider health — computed fields in getAllProviderStats", () => {
  it("getAllProviderStats includes avgLatencyMs and errorRate", () => {
    const model = "4b-model-" + Math.random().toString(36).slice(2);
    const provider = "4b-prov-" + Math.random().toString(36).slice(2);

    recordProviderSuccess(model, provider, 100);
    recordProviderSuccess(model, provider, 200);
    recordProviderError(model, provider, 300);

    const stats = getAllProviderStats()[`${model}::${provider}`];
    expect(stats).toBeDefined();
    // avgLatencyMs = (100 + 200 + 300) / 3
    expect(stats!.avgLatencyMs).toBeCloseTo(200, 0);
    // errorRate = 1 error / 3 requests
    expect(stats!.errorRate).toBeCloseTo(1 / 3, 5);
  });

  it("avgLatencyMs is 0 when no requests recorded", () => {
    const model = "4b-empty-" + Math.random().toString(36).slice(2);
    const provider = "4b-prov2-" + Math.random().toString(36).slice(2);
    // nothing recorded yet
    expect(avgProviderLatencyMs(model, provider)).toBe(0);
  });

  it("errorRate is 0 for a provider with only successes", () => {
    const model = "4b-ok-" + Math.random().toString(36).slice(2);
    const provider = "4b-ok-prov-" + Math.random().toString(36).slice(2);

    recordProviderSuccess(model, provider, 50);
    recordProviderSuccess(model, provider, 80);

    const stats = getAllProviderStats()[`${model}::${provider}`];
    expect(stats!.errorRate).toBe(0);
    expect(stats!.avgLatencyMs).toBeCloseTo(65, 0);
  });

  it("getDegradedProviders key matches getAllProviderStats key format", () => {
    const model = "4b-deg-" + Math.random().toString(36).slice(2);
    const provider = "4b-deg-prov-" + Math.random().toString(36).slice(2);
    for (let i = 0; i < 3; i++) recordProviderError(model, provider, 100);

    const degradedKeys = getDegradedProviders();
    const statsKeys = Object.keys(getAllProviderStats());
    const expectedKey = `${model}::${provider}`;

    expect(degradedKeys).toContain(expectedKey);
    expect(statsKeys).toContain(expectedKey);
  });
});

// ── TTL eviction + LRU ───────────────────────────────────────────────────────

describe("provider health — TTL eviction and LRU", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("evicts stale entries after 6 hours on the next new-entry insertion", () => {
    const model = "ttl-model-" + Math.random().toString(36).slice(2);
    const provider = "ttl-prov-" + Math.random().toString(36).slice(2);

    // Record a success at t=0
    recordProviderSuccess(model, provider, 50);
    expect(getAllProviderStats()[`${model}::${provider}`]).toBeDefined();

    // Advance time past the 6-hour TTL
    vi.advanceTimersByTime(6 * 60 * 60 * 1000 + 1);

    // Trigger eviction by inserting a new entry
    const newModel = "ttl-new-" + Math.random().toString(36).slice(2);
    recordProviderSuccess(newModel, "some-provider", 10);

    // The stale entry should have been evicted
    expect(getAllProviderStats()[`${model}::${provider}`]).toBeUndefined();
    // The new entry should be present
    expect(getAllProviderStats()[`${newModel}::some-provider`]).toBeDefined();
  });

  it("does NOT evict entries that are still within the 6-hour TTL", () => {
    const model = "ttl-fresh-" + Math.random().toString(36).slice(2);
    const provider = "ttl-fresh-prov-" + Math.random().toString(36).slice(2);

    recordProviderSuccess(model, provider, 50);

    // Advance time to just under the TTL
    vi.advanceTimersByTime(6 * 60 * 60 * 1000 - 1000);

    // Trigger eviction check by inserting another entry
    const newModel = "ttl-trigger-" + Math.random().toString(36).slice(2);
    recordProviderSuccess(newModel, "trigger-prov", 10);

    // Fresh entry should still be present
    expect(getAllProviderStats()[`${model}::${provider}`]).toBeDefined();
  });

  it("updates lastUsedAt on access (LRU touch)", () => {
    const model = "lru-model-" + Math.random().toString(36).slice(2);
    const provider = "lru-prov-" + Math.random().toString(36).slice(2);

    // Record at t=0
    recordProviderSuccess(model, provider, 50);
    const firstUsedAt = getAllProviderStats()[`${model}::${provider}`]!.lastUsedAt;

    // Advance time and access again
    vi.advanceTimersByTime(5000);
    recordProviderError(model, provider, 100);
    const secondUsedAt = getAllProviderStats()[`${model}::${provider}`]!.lastUsedAt;

    expect(secondUsedAt).toBeGreaterThan(firstUsedAt);
  });
});
