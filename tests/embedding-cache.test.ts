import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  getCachedQueryEmbedding,
  setCachedQueryEmbedding,
  _clearEmbeddingCacheForTesting,
} from "../src/embedding-cache.js";

beforeEach(() => {
  _clearEmbeddingCacheForTesting();
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("embedding cache", () => {
  it("cache miss returns null for unknown (model, text)", () => {
    const result = getCachedQueryEmbedding("text-embedding-ada-002", "hello world");
    expect(result).toBeNull();
  });

  it("cache hit returns stored vector", () => {
    const vec = [0.1, 0.2, 0.3];
    setCachedQueryEmbedding("text-embedding-ada-002", "hello world", vec);
    const result = getCachedQueryEmbedding("text-embedding-ada-002", "hello world");
    expect(result).toEqual(vec);
  });

  it("different models with same text are cached independently", () => {
    const vecA = [1, 0, 0];
    const vecB = [0, 1, 0];
    setCachedQueryEmbedding("model-a", "same text", vecA);
    setCachedQueryEmbedding("model-b", "same text", vecB);

    expect(getCachedQueryEmbedding("model-a", "same text")).toEqual(vecA);
    expect(getCachedQueryEmbedding("model-b", "same text")).toEqual(vecB);
  });

  it("same model with different texts are cached independently", () => {
    const v1 = [1, 2];
    const v2 = [3, 4];
    setCachedQueryEmbedding("model", "text one", v1);
    setCachedQueryEmbedding("model", "text two", v2);

    expect(getCachedQueryEmbedding("model", "text one")).toEqual(v1);
    expect(getCachedQueryEmbedding("model", "text two")).toEqual(v2);
  });

  it("TTL expiry — null after 5 minutes (vi.useFakeTimers)", () => {
    vi.useFakeTimers();

    const vec = [0.5, 0.5];
    setCachedQueryEmbedding("model", "expiring text", vec);

    // Just before expiry — still valid
    vi.advanceTimersByTime(4 * 60 * 1000 + 59 * 1000); // 4m59s
    expect(getCachedQueryEmbedding("model", "expiring text")).toEqual(vec);

    // Advance past the 5-minute TTL
    vi.advanceTimersByTime(2 * 1000); // +2s → 5m01s
    expect(getCachedQueryEmbedding("model", "expiring text")).toBeNull();
  });

  it("max entries eviction — oldest evicted when limit exceeded", () => {
    // Fill the cache to the 100-entry limit
    for (let i = 0; i < 100; i++) {
      setCachedQueryEmbedding("model", `text-${i}`, [i]);
    }

    // The first entry (text-0) should still be present
    expect(getCachedQueryEmbedding("model", "text-0")).toEqual([0]);

    // Adding the 101st entry should evict the oldest (text-0)
    setCachedQueryEmbedding("model", "text-100", [100]);

    // text-0 must have been evicted
    expect(getCachedQueryEmbedding("model", "text-0")).toBeNull();

    // text-100 must be present
    expect(getCachedQueryEmbedding("model", "text-100")).toEqual([100]);

    // text-1 (second oldest) must still be present
    expect(getCachedQueryEmbedding("model", "text-1")).toEqual([1]);
  });

  it("_clearEmbeddingCacheForTesting resets cache", () => {
    setCachedQueryEmbedding("model", "some text", [1, 2, 3]);
    expect(getCachedQueryEmbedding("model", "some text")).toEqual([1, 2, 3]);

    _clearEmbeddingCacheForTesting();

    expect(getCachedQueryEmbedding("model", "some text")).toBeNull();
  });

  it("updating an existing key refreshes the vector", () => {
    const v1 = [1, 0];
    const v2 = [0, 1];
    setCachedQueryEmbedding("model", "same key", v1);
    setCachedQueryEmbedding("model", "same key", v2);

    expect(getCachedQueryEmbedding("model", "same key")).toEqual(v2);
  });

  it("cache is keyed by sha256 hash — identical text hits the same entry", () => {
    const vec = [9, 8, 7];
    const text = "the quick brown fox";
    setCachedQueryEmbedding("model", text, vec);

    // Retrieve with a freshly created string (not the same reference)
    const result = getCachedQueryEmbedding("model", "the quick brown fox");
    expect(result).toEqual(vec);
  });
});
