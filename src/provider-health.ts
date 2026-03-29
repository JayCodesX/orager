/**
 * In-memory provider health tracker.
 *
 * Tracks per-model-per-provider success/error rates and average latency.
 * The retry logic uses this to prefer healthy providers over degraded ones.
 *
 * State is process-scoped (not persisted). Resets on daemon restart.
 */

export interface ProviderStats {
  successCount: number;
  errorCount: number;
  totalRequests: number;
  totalLatencyMs: number;
  lastErrorAt: number; // Date.now() of last error, 0 = never
  consecutiveErrors: number;
  lastUsedAt: number;  // Date.now() of last record call — used for TTL eviction
}

/** Key format: "model::provider" (provider may be "unknown") */
const _stats = new Map<string, ProviderStats>();

function key(model: string, provider: string): string {
  return `${model}::${provider}`;
}

const MAX_STATS_ENTRIES = 500;
const STATS_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours — evict stale provider entries

/**
 * Evict all entries that haven't been used in the last STATS_TTL_MS.
 * Called lazily on each new-entry insertion to amortise the scan cost.
 */
function evictStale(): void {
  const cutoff = Date.now() - STATS_TTL_MS;
  for (const [k, s] of _stats) {
    if (s.lastUsedAt < cutoff) _stats.delete(k);
  }
}

function getOrCreate(model: string, provider: string): ProviderStats {
  const k = key(model, provider);
  const existing = _stats.get(k);
  if (existing) {
    // Move to end of Map to mark as most-recently used (LRU eviction pattern)
    _stats.delete(k);
    existing.lastUsedAt = Date.now();
    _stats.set(k, existing);
    return existing;
  }
  // Evict stale entries before adding a new one
  evictStale();
  const s: ProviderStats = { successCount: 0, errorCount: 0, totalRequests: 0, totalLatencyMs: 0, lastErrorAt: 0, consecutiveErrors: 0, lastUsedAt: Date.now() };
  _stats.set(k, s);
  // LRU cap: evict least-recently-used entry if still over cap after TTL eviction
  if (_stats.size > MAX_STATS_ENTRIES) {
    const lru = _stats.keys().next().value;
    if (lru !== undefined) _stats.delete(lru);
  }
  return s;
}

/**
 * Record a successful request.
 */
export function recordProviderSuccess(model: string, provider: string, latencyMs: number): void {
  const s = getOrCreate(model, provider);
  s.successCount++;
  s.totalRequests++;
  s.totalLatencyMs += latencyMs;
  s.consecutiveErrors = 0;
}

/**
 * Record a failed request.
 */
export function recordProviderError(model: string, provider: string, latencyMs: number): void {
  const s = getOrCreate(model, provider);
  s.errorCount++;
  s.totalRequests++;
  s.totalLatencyMs += latencyMs;
  s.lastErrorAt = Date.now();
  s.consecutiveErrors++;
}

/** Degraded = 3+ consecutive errors OR error rate > 50% with 5+ requests */
export function isProviderDegraded(model: string, provider: string): boolean {
  const s = _stats.get(key(model, provider));
  if (!s) return false;
  if (s.consecutiveErrors >= 3) return true;
  if (s.totalRequests >= 5 && s.errorCount / s.totalRequests > 0.5) return true;
  return false;
}

/** Average latency in ms, or 0 if no data. */
export function avgProviderLatencyMs(model: string, provider: string): number {
  const s = _stats.get(key(model, provider));
  if (!s || s.totalRequests === 0) return 0;
  return s.totalLatencyMs / s.totalRequests;
}

/** Extended stats shape returned by getAllProviderStats — includes computed fields. */
export type ProviderStatsSummary = ProviderStats & {
  /** Average latency in ms across all recorded requests (0 when no data). */
  avgLatencyMs: number;
  /** Error rate as a fraction 0–1 (0 when no requests). */
  errorRate: number;
};

/** Return all stats as a plain object with computed fields (for /metrics endpoint). */
export function getAllProviderStats(): Record<string, ProviderStatsSummary> {
  const out: Record<string, ProviderStatsSummary> = {};
  for (const [k, s] of _stats) {
    out[k] = {
      ...s,
      avgLatencyMs: s.totalRequests > 0 ? s.totalLatencyMs / s.totalRequests : 0,
      errorRate: s.totalRequests > 0 ? s.errorCount / s.totalRequests : 0,
    };
  }
  return out;
}

/**
 * Log a summary of degraded providers (for periodic health check logging).
 * Returns list of degraded provider keys.
 */
export function getDegradedProviders(): string[] {
  const degraded: string[] = [];
  for (const [k, s] of _stats) {
    if (s.consecutiveErrors >= 3 || (s.totalRequests >= 5 && s.errorCount / s.totalRequests > 0.5)) {
      degraded.push(k);
    }
  }
  return degraded;
}
