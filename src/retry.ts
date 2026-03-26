import { callOpenRouter } from "./openrouter.js";
import type { OpenRouterCallOptions, OpenRouterCallResult } from "./types.js";

// Errors that should not be retried — auth failures, malformed requests, etc.
const FATAL_PATTERNS = [
  /\b401\b/,
  /\b403\b/,
  /unauthorized/i,
  /forbidden/i,
  /invalid.{0,20}api.{0,20}key/i,
  /\b400\b.*bad.request/i,
];

// Errors that indicate rate-limiting or temporary unavailability — after the
// first retry on the same model, we rotate to the next fallback model if one
// is available in opts.models.
const MODEL_ROTATE_PATTERNS = [
  /\b429\b/,   // Too Many Requests (rate limit)
  /\b503\b/,   // Service Unavailable (provider down)
  /rate.{0,10}limit/i,
  /too.many.requests/i,
  /service.{0,10}unavailable/i,
  /overloaded/i,
];

function isFatal(message: string): boolean {
  return FATAL_PATTERNS.some((p) => p.test(message));
}

function shouldRotateModel(message: string): boolean {
  return MODEL_ROTATE_PATTERNS.some((p) => p.test(message));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calls OpenRouter with exponential-backoff retry on transient errors.
 * Fatal errors (auth, bad request) are returned/thrown immediately without retrying.
 *
 * Model rotation: on 429/503 errors, after the first retry on the same model,
 * the next model from opts.models is tried.  Each model gets one retry attempt
 * before rotating.  If all models are exhausted the original error is returned.
 *
 * @param maxRetries Number of retries after the first attempt (0 = no retries).
 */
export async function callWithRetry(
  opts: OpenRouterCallOptions,
  maxRetries: number,
  onLog?: (msg: string) => void,
): Promise<OpenRouterCallResult> {
  let attempt = 0;
  // Track which fallback model index we're on.  Index 0 means the primary model
  // (opts.model); index > 0 means we've rotated into opts.models[modelIndex - 1].
  let modelIndex = 0;
  // Tracks whether we've already retried the current model once before rotating.
  let retriedCurrentModel = false;

  function currentModel(): string {
    if (modelIndex === 0) return opts.model;
    return (opts.models ?? [])[modelIndex - 1] ?? opts.model;
  }

  while (true) {
    const callOpts: OpenRouterCallOptions = {
      ...opts,
      model: currentModel(),
    };

    try {
      const result = await callOpenRouter(callOpts);

      // Clean response — return immediately
      if (!result.isError) return result;

      const errMsg = result.errorMessage ?? "stream error";

      // Fatal errors — surface immediately without retrying
      if (isFatal(errMsg)) return result;

      // Out of total retries — surface the error
      if (attempt >= maxRetries) return result;

      // Check whether to rotate model (429/503 after first retry on this model)
      const fallbackModels = opts.models ?? [];
      if (shouldRotateModel(errMsg) && retriedCurrentModel && modelIndex < fallbackModels.length) {
        modelIndex++;
        retriedCurrentModel = false;
        onLog?.(
          `[orager] rate-limit/unavailable on model "${currentModel() !== opts.model ? (fallbackModels[modelIndex - 2] ?? opts.model) : opts.model}", falling back to "${currentModel()}" (attempt ${attempt + 1}/${maxRetries + 1})\n`,
        );
      } else {
        retriedCurrentModel = true;
        const backoffMs = 1000 * 2 ** attempt;
        onLog?.(
          `[orager] retryable stream error on "${currentModel()}" (attempt ${attempt + 1}/${maxRetries + 1}): ${errMsg} — retrying in ${backoffMs}ms\n`,
        );
        await sleep(backoffMs);
      }
      attempt++;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);

      // Fatal or out of retries — rethrow
      if (isFatal(errMsg) || attempt >= maxRetries) throw err;

      // Check whether to rotate model
      const fallbackModels = opts.models ?? [];
      if (shouldRotateModel(errMsg) && retriedCurrentModel && modelIndex < fallbackModels.length) {
        modelIndex++;
        retriedCurrentModel = false;
        onLog?.(
          `[orager] rate-limit/unavailable on model "${currentModel() !== opts.model ? (fallbackModels[modelIndex - 2] ?? opts.model) : opts.model}", falling back to "${currentModel()}" (attempt ${attempt + 1}/${maxRetries + 1})\n`,
        );
      } else {
        retriedCurrentModel = true;
        const backoffMs = 1000 * 2 ** attempt;
        onLog?.(
          `[orager] retryable error on "${currentModel()}" (attempt ${attempt + 1}/${maxRetries + 1}): ${errMsg} — retrying in ${backoffMs}ms\n`,
        );
        await sleep(backoffMs);
      }
      attempt++;
    }
  }
}
