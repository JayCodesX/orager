/**
 * In-memory cache for query embeddings.
 *
 * Cache key: `${model}:${sha256(text)}`
 * TTL: 5 minutes
 * Max entries: 100 (evict oldest on overflow)
 *
 * Avoids calling callEmbeddings on every run when the same prompt is reused.
 */
import crypto from "node:crypto";

const TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ENTRIES = 100;

interface CacheEntry {
  vector: number[];
  expiresAt: number; // Date.now() + TTL_MS
}

// Insertion-ordered map — oldest entry is the first key (Map preserves insertion order)
const _cache = new Map<string, CacheEntry>();

function cacheKey(model: string, text: string): string {
  const hash = crypto.createHash("sha256").update(text).digest("hex");
  return `${model}:${hash}`;
}

/**
 * Return a cached embedding vector for (model, text), or null on a miss or
 * if the cached entry has expired.
 */
export function getCachedQueryEmbedding(model: string, text: string): number[] | null {
  const key = cacheKey(model, text);
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    _cache.delete(key);
    return null;
  }
  return entry.vector;
}

/**
 * Store an embedding vector in the cache.
 * Evicts the oldest entry when the cache has reached MAX_ENTRIES.
 */
export function setCachedQueryEmbedding(model: string, text: string, vec: number[]): void {
  const key = cacheKey(model, text);

  // Evict oldest entry if at capacity (and this key isn't already in the cache)
  if (!_cache.has(key) && _cache.size >= MAX_ENTRIES) {
    const oldest = _cache.keys().next().value;
    if (oldest !== undefined) {
      _cache.delete(oldest);
    }
  }

  // Delete then re-insert to refresh insertion order on update
  _cache.delete(key);
  _cache.set(key, { vector: vec, expiresAt: Date.now() + TTL_MS });
}

/** Reset cache — for testing only. */
export function _clearEmbeddingCacheForTesting(): void {
  _cache.clear();
}
