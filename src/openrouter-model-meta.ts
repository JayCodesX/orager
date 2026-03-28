/**
 * Extended model metadata from OpenRouter /api/v1/models.
 *
 * Fetches and caches: supported_parameters, input_modalities, output_modalities,
 * and per-token pricing. Supplements (and eventually replaces) the static
 * regex table in model-capabilities.ts.
 *
 * Same 6-hour TTL as the context window cache. Shares the same fetch request.
 */

export interface LiveModelMeta {
  supportedParameters: string[];   // e.g. ["tools", "response_format", "reasoning"]
  inputModalities: string[];        // e.g. ["text", "image"]
  outputModalities: string[];       // e.g. ["text"]
  pricingPrompt: number;            // USD per token (prompt)
  pricingCompletion: number;        // USD per token (completion)
  contextLength: number;
}

const _metaCache = new Map<string, LiveModelMeta>();
let _metaCachedAt = 0;
let _metaFetchInFlight: Promise<void> | null = null;
const META_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Fetch and populate the live model metadata cache.
 * Skips if cache is fresh (within TTL). Safe to call multiple times.
 */
export async function fetchLiveModelMeta(apiKey: string): Promise<void> {
  const now = Date.now();
  if (_metaCachedAt > 0 && now - _metaCachedAt < META_CACHE_TTL_MS) return;
  if (_metaFetchInFlight) return _metaFetchInFlight;

  _metaFetchInFlight = (async () => {
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
      const json = await res.json() as {
        data?: Array<{
          id: string;
          context_length?: number;
          supported_parameters?: string[];
          input_modalities?: string[];
          output_modalities?: string[];
          pricing?: {
            prompt?: string | number;
            completion?: string | number;
          };
          architecture?: {
            input_modalities?: string[];
            output_modalities?: string[];
            tokenizer?: string;
          };
        }>;
      };
      if (!Array.isArray(json.data)) return;
      for (const m of json.data) {
        if (!m.id) continue;
        _metaCache.set(m.id, {
          supportedParameters: m.supported_parameters ?? [],
          inputModalities: m.input_modalities ?? m.architecture?.input_modalities ?? [],
          outputModalities: m.output_modalities ?? m.architecture?.output_modalities ?? [],
          pricingPrompt: parseFloat(String(m.pricing?.prompt ?? "0")) || 0,
          pricingCompletion: parseFloat(String(m.pricing?.completion ?? "0")) || 0,
          contextLength: m.context_length ?? 0,
        });
      }
      _metaCachedAt = Date.now();
    } catch {
      // Network failure — silently fall back to static table
    } finally {
      _metaFetchInFlight = null;
    }
  })();

  return _metaFetchInFlight;
}

/**
 * Returns true when the live model metadata cache has been populated and is
 * still within its TTL. Used by runAgentLoop to skip the fetch on subsequent
 * runs when the daemon has already warmed the cache at startup.
 */
export function isLiveModelMetaCacheWarm(): boolean {
  return _metaCachedAt > 0 && Date.now() - _metaCachedAt < META_CACHE_TTL_MS;
}

/** Get cached metadata for a model (null if not cached yet). */
export function getLiveModelMeta(model: string): LiveModelMeta | null {
  // Try exact match first, then strip provider prefix
  return _metaCache.get(model)
    ?? _metaCache.get(model.includes("/") ? model.split("/").slice(1).join("/") : model)
    ?? null;
}

/** Returns true if the live metadata says the model supports tool/function calling. */
export function liveModelSupportsTools(model: string): boolean | null {
  const meta = getLiveModelMeta(model);
  if (!meta) return null; // unknown — let static table decide
  return meta.supportedParameters.includes("tools");
}

/** Returns true if the live metadata says the model accepts image inputs. */
export function liveModelSupportsVision(model: string): boolean | null {
  const meta = getLiveModelMeta(model);
  if (!meta) return null;
  return meta.inputModalities.includes("image");
}

/** Returns per-token pricing from live data, or null if not cached. */
export function getLiveModelPricing(model: string): { prompt: number; completion: number } | null {
  const meta = getLiveModelMeta(model);
  if (!meta || (meta.pricingPrompt === 0 && meta.pricingCompletion === 0)) return null;
  return { prompt: meta.pricingPrompt, completion: meta.pricingCompletion };
}

/** Returns all cached model IDs. */
export function getCachedModelIds(): string[] {
  return Array.from(_metaCache.keys());
}

/** Expose raw cache for inspection/testing. */
export function getMetaCacheSize(): number {
  return _metaCache.size;
}
