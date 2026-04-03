/**
 * model-cache.ts — Context window size lookup and model-aware timeout heuristics.
 *
 * Extracted from loop-helpers.ts (Sprint 9).
 *
 * Responsibilities:
 *  - Maintain an in-memory cache of model context_length values populated from
 *    the OpenRouter /models endpoint (refreshed at most once every 6 hours).
 *  - Provide static fallback context-window sizes for common model families.
 *  - Expose `defaultTimeoutForModel` for model-aware run-timeout selection.
 */

// ── Context window size lookup ────────────────────────────────────────────────

/**
 * Fallback static map used when the OpenRouter /models endpoint is unavailable
 * or the model isn't listed. Values reflect published context windows as of 2026.
 * Ordered most-specific first (DeepSeek-R1 before generic deepseek).
 */
const CONTEXT_WINDOW_FALLBACK: Array<[RegExp, number]> = [
  // Gemini 2.5 / 1.5 — 1M context window
  [/gemini-[12]\.[05]/i, 1_000_000],
  // Anthropic / Claude — 200k
  [/^anthropic\/|^claude-/i, 200_000],
  // OpenAI o1/o3 reasoning models — 200k
  [/\bo[13](?:-|$)/i, 200_000],
  // GPT-4o (includes gpt-4o-mini) — 128k
  [/gpt-4o/i, 128_000],
  // GPT-4 Turbo — 128k
  [/gpt-4-turbo/i, 128_000],
  // Llama 3 — 128k
  [/llama-?3/i, 128_000],
  // Qwen2 / Qwen2.5 — 128k
  [/qwen2/i, 128_000],
  // DeepSeek-R1 variants — 164k
  [/deepseek.*r1/i, 163_840],
  // DeepSeek-V3 / deepseek-chat — 128k
  [/deepseek/i, 128_000],
  // Mistral / Mixtral — 32k (handled by fallback default)
];

/** In-memory cache: model id → context_length, populated from OpenRouter /models */
const modelContextCache = new Map<string, number>();
/** Timestamp of last successful fetch (0 = never fetched). */
let modelCacheFetchedAt = 0;
/** How long the model context cache is considered fresh (6 hours). */
const MODEL_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
let modelCacheFetchInFlight: Promise<void> | null = null;

/**
 * Fetch context lengths for all models from OpenRouter and populate the cache.
 * Refreshes at most once every MODEL_CACHE_TTL_MS (6 hours) to pick up newly
 * released models while avoiding unnecessary network calls.
 */
export async function fetchModelContextLengths(apiKey: string): Promise<void> {
  const now = Date.now();
  if (modelCacheFetchedAt > 0 && now - modelCacheFetchedAt < MODEL_CACHE_TTL_MS) return;
  if (modelCacheFetchInFlight) return modelCacheFetchInFlight;

  modelCacheFetchInFlight = (async () => {
    try {
      const openrouterBase = (process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
      const res = await fetch(`${openrouterBase}/models`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "HTTP-Referer": "https://paperclip.ai",
        },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) return;
      const json = await res.json() as { data?: Array<{ id: string; context_length?: number }> };
      if (!Array.isArray(json.data)) return;
      for (const m of json.data) {
        if (m.id && typeof m.context_length === "number" && m.context_length > 0) {
          modelContextCache.set(m.id, m.context_length);
        }
      }
      modelCacheFetchedAt = Date.now();
    } catch {
      // Network error or timeout — silently fall through to static map
    } finally {
      modelCacheFetchInFlight = null;
    }
  })();

  return modelCacheFetchInFlight;
}

/**
 * Returns true when the model context-length cache has been populated and is
 * still within its TTL. Used by runAgentLoop to skip the fetch on subsequent
 * runs when the daemon has already warmed the cache at startup.
 */
export function isModelContextCacheWarm(): boolean {
  return modelCacheFetchedAt > 0 && Date.now() - modelCacheFetchedAt < MODEL_CACHE_TTL_MS;
}

/**
 * Reset the model context cache to its initial unfetched state.
 * Only intended for use in tests — do not call from production code.
 */
export function _resetModelCacheForTesting(): void {
  modelCacheFetchedAt = 0;
  modelContextCache.clear();
  modelCacheFetchInFlight = null;
}

export function getContextWindowFromFallback(model: string): number {
  for (const [re, size] of CONTEXT_WINDOW_FALLBACK) {
    if (re.test(model)) return size;
  }
  return 32_000;
}

/**
 * Returns the context window size for a model.
 * Prefers the live OpenRouter value (already fetched into cache);
 * falls back to the static map if the model isn't in the cache.
 */
export function getContextWindow(model: string): number {
  // Strip provider prefix for cache lookup (e.g. "openai/gpt-4o" → "gpt-4o")
  const cached = modelContextCache.get(model);
  if (cached !== undefined) return cached;
  return getContextWindowFromFallback(model);
}

// ── Model-aware timeout heuristic ─────────────────────────────────────────────

/**
 * Returns a sensible default run-level timeout (in seconds) for the given model.
 *
 * Reasoning / thinking models (DeepSeek R1, o1, o3, extended-thinking) can take
 * several minutes to produce a response. Fast chat models (Haiku, Flash, Mini,
 * Turbo) are typically done in under two minutes. Everything else gets the
 * standard 5-minute window.
 *
 * Returns 0 to indicate "no timeout" for unknown / custom model strings.
 */
export function defaultTimeoutForModel(model: string): number {
  const lower = model.toLowerCase();
  if (/\br1\b|deepseek-r1|\/o1|\/o3|thinking|reasoning/.test(lower)) return 600;
  if (/haiku|flash|mini|turbo/.test(lower)) return 120;
  return 300;
}
