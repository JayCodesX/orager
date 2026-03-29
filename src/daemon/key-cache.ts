/**
 * Module-level cache for OpenRouter API key info (used by /metrics endpoint).
 * TTL: 5 minutes — balances freshness against extra API calls.
 */
import { fetchApiKeyInfo } from "../openrouter-key.js";
import type { ApiKeyInfo } from "../openrouter-key.js";

let _cachedKeyInfo: { info: ApiKeyInfo | null; fetchedAt: number } | null = null;
const KEY_INFO_TTL_MS = 5 * 60 * 1000;

export async function getCachedKeyInfo(apiKey: string): Promise<ApiKeyInfo | null> {
  const now = Date.now();
  if (_cachedKeyInfo && now - _cachedKeyInfo.fetchedAt < KEY_INFO_TTL_MS) {
    return _cachedKeyInfo.info;
  }
  const info = await fetchApiKeyInfo(apiKey).catch(() => null);
  _cachedKeyInfo = { info, fetchedAt: now };
  return info;
}

/** Reset the cache — for testing only. */
export function _resetKeyCacheForTesting(): void {
  _cachedKeyInfo = null;
}
