import { callOpenRouter, callDirect, shouldUseDirect } from "./openrouter.js";
import type { OpenRouterCallOptions, OpenRouterCallResult } from "./types.js";
import { recordProviderSuccess, recordProviderError } from "./provider-health.js";

function classifyError(result: { httpStatus?: number; errorMessage?: string }): "fatal" | "rotate" | "retry" {
  // Classify by HTTP status code first (authoritative)
  const status = result.httpStatus;
  if (status === 401 || status === 403) return "fatal";
  if (status === 400) return "fatal"; // bad request — retrying won't help
  if (status === 402) return "fatal"; // payment required
  if (status === 404) return "fatal"; // model not found
  if (status === 429) return "rotate"; // rate limit — try another model/provider
  if (status === 503) return "rotate"; // overloaded
  if (status === 500 || status === 502 || status === 504) return "retry"; // transient server error

  // Fallback: regex on message string for cases where status is missing
  const msg = (result.errorMessage ?? "").toLowerCase();
  if (/unauthorized|forbidden|invalid.*key|bad request/i.test(msg)) return "fatal";
  if (/rate.?limit|too many|overloaded|capacity/i.test(msg)) return "rotate";
  return "retry";
}

function isFatal(result: { httpStatus?: number; errorMessage?: string }): boolean {
  return classifyError(result) === "fatal";
}

function shouldRotateModel(result: { httpStatus?: number; errorMessage?: string }): boolean {
  return classifyError(result) === "rotate";
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

  // Build the API key pool: primary key + any additional keys in opts.apiKeys.
  // On the first rate-limit hit per model, the next key is tried before escalating
  // to model rotation. This replaces the "blind retry same model" step with a
  // "try a different credential" step that has a higher chance of success.
  const _keyPool: string[] = (() => {
    const extra = (opts.apiKeys ?? []).filter(
      (k): k is string => typeof k === "string" && k.trim().length > 0,
    );
    const primary = opts.apiKey ?? "";
    const all = primary && !extra.includes(primary) ? [primary, ...extra] : extra;
    return all.length > 0 ? all : [primary];
  })();
  let _keyIndex = 0;

  function currentModel(): string {
    if (modelIndex === 0) return opts.model;
    return (opts.models ?? [])[modelIndex - 1] ?? opts.model;
  }

  function currentKey(): string {
    return _keyPool[_keyIndex % _keyPool.length] ?? opts.apiKey;
  }

  while (true) {
    const callOpts: OpenRouterCallOptions = {
      ...opts,
      model: currentModel(),
      apiKey: currentKey(),
    };

    const attemptStart = Date.now();
    try {
      const result = shouldUseDirect(callOpts.model)
        ? await callDirect(callOpts)
        : await callOpenRouter(callOpts);

      // Clean response — return immediately
      if (!result.isError) {
        recordProviderSuccess(callOpts.model, "unknown", Date.now() - attemptStart);
        return result;
      }

      const errInfo = { httpStatus: result.httpStatus, errorMessage: result.errorMessage ?? "stream error" };
      const errMsg = errInfo.errorMessage;

      // Fatal errors — surface immediately without retrying
      if (isFatal(errInfo)) {
        recordProviderError(callOpts.model ?? "unknown", "unknown", Date.now() - attemptStart);
        return result;
      }

      recordProviderError(callOpts.model ?? "unknown", "unknown", Date.now() - attemptStart);

      // Out of total retries — surface the error
      if (attempt >= maxRetries) return result;

      // Check whether to rotate model (429/503 after first retry on this model)
      const fallbackModels = opts.models ?? [];
      if (shouldRotateModel(errInfo) && retriedCurrentModel && modelIndex < fallbackModels.length) {
        const prevModel = currentModel();
        modelIndex++;
        _keyIndex = 0; // reset key pool for the new model
        retriedCurrentModel = false;
        onLog?.(
          `[orager] rate-limit/unavailable on model "${prevModel}", falling back to "${currentModel()}" (attempt ${attempt + 1}/${maxRetries + 1})\n`,
        );
      } else if (shouldRotateModel(errInfo) && retriedCurrentModel && modelIndex >= fallbackModels.length && fallbackModels.length > 0) {
        // All fallback models exhausted — surface the error immediately
        onLog?.(`[orager] all ${fallbackModels.length + 1} models exhausted on rotate-class error — giving up\n`);
        return result; // surface the last error
      } else {
        // First rate-limit hit for this model: rotate to next API key if available,
        // then retry. Falls back to same key when only one key is configured.
        if (shouldRotateModel(errInfo) && _keyPool.length > 1) {
          _keyIndex = (_keyIndex + 1) % _keyPool.length;
          onLog?.(
            `[orager] rate-limit on "${currentModel()}", rotating to API key ${_keyIndex + 1}/${_keyPool.length} (attempt ${attempt + 1}/${maxRetries + 1})\n`,
          );
        }
        retriedCurrentModel = true;
        const backoffMs = Math.min(1000 * 2 ** attempt, 60_000);
        onLog?.(
          `[orager] retryable stream error on "${currentModel()}" (attempt ${attempt + 1}/${maxRetries + 1}): ${errMsg} — retrying in ${backoffMs}ms\n`,
        );
        await sleep(backoffMs);
      }
      attempt++;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const errInfo = { errorMessage: errMsg };

      recordProviderError(callOpts.model ?? "unknown", "unknown", Date.now() - attemptStart);

      // Fatal or out of retries — rethrow
      if (isFatal(errInfo) || attempt >= maxRetries) throw err;

      // Check whether to rotate model
      const fallbackModels = opts.models ?? [];
      if (shouldRotateModel(errInfo) && retriedCurrentModel && modelIndex < fallbackModels.length) {
        const prevModel = currentModel();
        modelIndex++;
        _keyIndex = 0; // reset key pool for the new model
        retriedCurrentModel = false;
        onLog?.(
          `[orager] rate-limit/unavailable on model "${prevModel}", falling back to "${currentModel()}" (attempt ${attempt + 1}/${maxRetries + 1})\n`,
        );
      } else if (shouldRotateModel(errInfo) && retriedCurrentModel && modelIndex >= fallbackModels.length && fallbackModels.length > 0) {
        // All fallback models exhausted — surface the error immediately
        onLog?.(`[orager] all ${fallbackModels.length + 1} models exhausted on rotate-class error — giving up\n`);
        throw err;
      } else {
        if (shouldRotateModel(errInfo) && _keyPool.length > 1) {
          _keyIndex = (_keyIndex + 1) % _keyPool.length;
          onLog?.(
            `[orager] rate-limit on "${currentModel()}", rotating to API key ${_keyIndex + 1}/${_keyPool.length} (attempt ${attempt + 1}/${maxRetries + 1})\n`,
          );
        }
        retriedCurrentModel = true;
        const backoffMs = Math.min(1000 * 2 ** attempt, 60_000);
        onLog?.(
          `[orager] retryable error on "${currentModel()}" (attempt ${attempt + 1}/${maxRetries + 1}): ${errMsg} — retrying in ${backoffMs}ms\n`,
        );
        await sleep(backoffMs);
      }
      attempt++;
    }
  }
}
