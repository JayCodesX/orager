import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  recordProviderSuccess,
  recordProviderError,
  isProviderDegraded,
  getDegradedProviders,
  getAllProviderStats,
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
