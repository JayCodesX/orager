import type { OpenRouterCallOptions, OpenRouterCallResult } from "./types.js";
import { resolveProvider } from "./providers/index.js";
import { recordProviderSuccess, recordProviderError, isProviderDegraded } from "./provider-health.js";
import { waitIfRateLimited } from "./rate-limit-gate.js";
import { trace } from "@opentelemetry/api";

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

// ── Shared retry-decision state ───────────────────────────────────────────────
//
// Mutable state shared between the result-path and error-path retry branches.
// Extracted into an object so the decision helper can update it without
// closure-variable aliasing.

interface RetryState {
  attempt: number;
  modelIndex: number;
  retriedCurrentModel: boolean;
  keyIndex: number;
}

type RetryDecision =
  | { action: "surface" }
  | { action: "wait"; backoffMs: number }
  | { action: "rotated" }; // model rotated, no backoff needed

/**
 * Evaluate the rotation/backoff decision given the current error and state.
 * Mutates `state` in place (modelIndex, keyIndex, retriedCurrentModel, attempt).
 * Returns what the caller should do next.
 *
 * "surface"  — return/throw the error to the caller immediately.
 * "wait"     — sleep for backoffMs then try again.
 * "rotated"  — a fallback model was selected; retry immediately.
 */
async function applyRetryDecision(
  errInfo: { httpStatus?: number; errorMessage?: string },
  errMsg: string,
  state: RetryState,
  maxRetries: number,
  primaryModel: string,
  fallbackModels: string[],
  keyPool: string[],
  modelLabel: () => string,
  onLog?: (msg: string) => void,
): Promise<RetryDecision> {
  if (isFatal(errInfo) || state.attempt >= maxRetries) {
    trace.getActiveSpan()?.addEvent("retry.give_up", {
      "retry.attempt": state.attempt,
      "retry.reason": isFatal(errInfo) ? "fatal_error" : "max_retries_exceeded",
      "retry.error": errMsg,
    });
    return { action: "surface" };
  }

  const rotate = shouldRotateModel(errInfo);

  if (rotate && state.retriedCurrentModel && state.modelIndex < fallbackModels.length) {
    // Exhausted retries on this model — rotate to the next fallback
    const prevModel = modelLabel();
    state.modelIndex++;
    state.keyIndex = 0; // reset key pool for the new model
    state.retriedCurrentModel = false;
    state.attempt++;
    onLog?.(
      `[orager] rate-limit/unavailable on model "${prevModel}", falling back to "${modelLabel()}" (attempt ${state.attempt}/${maxRetries + 1})\n`,
    );
    trace.getActiveSpan()?.addEvent("retry.model_rotation", {
      "retry.attempt": state.attempt,
      "retry.prev_model": prevModel,
      "retry.next_model": modelLabel(),
      "retry.error": errMsg,
    });
    return { action: "rotated" };
  }

  if (rotate && state.retriedCurrentModel && state.modelIndex >= fallbackModels.length && fallbackModels.length > 0) {
    // All fallback models exhausted
    onLog?.(`[orager] all ${fallbackModels.length + 1} models exhausted on rotate-class error — giving up\n`);
    trace.getActiveSpan()?.addEvent("retry.all_models_exhausted", {
      "retry.attempt": state.attempt,
      "retry.model_count": fallbackModels.length + 1,
    });
    return { action: "surface" };
  }

  // First hit on this model: rotate to next API key if pool has extras, then back off
  if (rotate && keyPool.length > 1) {
    state.keyIndex = (state.keyIndex + 1) % keyPool.length;
    onLog?.(
      `[orager] rate-limit on "${modelLabel()}", rotating to API key ${state.keyIndex + 1}/${keyPool.length} (attempt ${state.attempt + 1}/${maxRetries + 1})\n`,
    );
  }

  state.retriedCurrentModel = true;
  const backoffMs = Math.min(1000 * 2 ** state.attempt, 60_000);
  const prefix = rotate ? "retryable stream error" : "retryable error";
  onLog?.(
    `[orager] ${prefix} on "${modelLabel()}" (attempt ${state.attempt + 1}/${maxRetries + 1}): ${errMsg} — retrying in ${backoffMs}ms\n`,
  );
  trace.getActiveSpan()?.addEvent("retry.backoff", {
    "retry.attempt": state.attempt + 1,
    "retry.backoff_ms": backoffMs,
    "retry.model": modelLabel(),
    "retry.error": errMsg,
    "retry.error_class": rotate ? "rotate" : "transient",
  });
  await sleep(backoffMs);
  state.attempt++;
  return { action: "wait", backoffMs };
}

/**
 * Calls OpenRouter with exponential-backoff retry on transient errors.
 * Fatal errors (auth, bad request) are returned/thrown immediately without retrying.
 *
 * Model rotation: on 429/503 errors, after the first retry on the same model,
 * the next model from opts.models is tried.  Each model gets one retry attempt
 * before rotating.  If all models are exhausted the original error is returned.
 *
 * Proactive degradation skip: if a model is already known-degraded (3+ consecutive
 * errors recorded in the process-level provider health tracker), it is skipped
 * immediately in favour of the next fallback without waiting for a 429.
 *
 * @param maxRetries Number of retries after the first attempt (0 = no retries).
 */
export async function callWithRetry(
  opts: OpenRouterCallOptions,
  maxRetries: number,
  onLog?: (msg: string) => void,
): Promise<OpenRouterCallResult> {
  // Build the API key pool: primary key + any additional keys in opts.apiKeys.
  const _keyPool: string[] = (() => {
    const extra = (opts.apiKeys ?? []).filter(
      (k): k is string => typeof k === "string" && k.trim().length > 0,
    );
    const primary = opts.apiKey ?? "";
    const all = primary && !extra.includes(primary) ? [primary, ...extra] : extra;
    return all.length > 0 ? all : [primary];
  })();

  const fallbackModels = opts.models ?? [];

  const state: RetryState = {
    attempt: 0,
    modelIndex: 0,
    retriedCurrentModel: false,
    keyIndex: 0,
  };

  function currentModel(): string {
    return state.modelIndex === 0
      ? opts.model
      : (fallbackModels[state.modelIndex - 1] ?? opts.model);
  }

  function currentKey(): string {
    return _keyPool[state.keyIndex % _keyPool.length] ?? opts.apiKey;
  }

  while (true) {
    // ── Proactive degradation skip ────────────────────────────────────────────
    // If the current model has 3+ consecutive errors in the health tracker, skip
    // to the next fallback immediately without waiting for another 429.
    // Errors are always recorded against provider="unknown" in this module,
    // so that is the key to check here.
    while (
      isProviderDegraded(currentModel(), "unknown") &&
      state.modelIndex < fallbackModels.length
    ) {
      const skipped = currentModel();
      state.modelIndex++;
      state.keyIndex = 0;
      state.retriedCurrentModel = false;
      onLog?.(
        `[orager] model "${skipped}" is degraded — skipping to "${currentModel()}" proactively\n`,
      );
      trace.getActiveSpan()?.addEvent("retry.degradation_skip", {
        "retry.skipped_model": skipped,
        "retry.next_model": currentModel(),
      });
    }

    const callOpts: OpenRouterCallOptions = {
      ...opts,
      model: currentModel(),
      apiKey: currentKey(),
    };

    // ── Pre-flight rate-limit gate ────────────────────────────────────────────
    // If the per-run tracker shows near-exhaustion, wait for reset instead of
    // making a call that is very likely to 429.
    await waitIfRateLimited(opts.rateLimitTracker?.getState() ?? null, onLog);

    const attemptStart = Date.now();
    try {
      const { provider } = resolveProvider(callOpts);
      const result = await provider.chat(callOpts);

      // Clean response — return immediately
      if (!result.isError) {
        // Record against "unknown" provider (the real provider name is recorded
        // later in loop.ts once generation metadata arrives via fetchGenerationMeta).
        recordProviderSuccess(callOpts.model, "unknown", Date.now() - attemptStart);
        if (state.attempt > 0) {
          // Only annotate when retries actually happened — keeps clean traces clean.
          trace.getActiveSpan()?.setAttributes({
            "retry.total_attempts": state.attempt + 1,
            "retry.final_model": callOpts.model,
          });
        }
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

      const decision = await applyRetryDecision(
        errInfo, errMsg, state, maxRetries,
        opts.model, fallbackModels, _keyPool, currentModel, onLog,
      );
      if (decision.action === "surface") return result;
      // "rotated" or "wait" — loop continues

    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const errInfo = { errorMessage: errMsg };

      recordProviderError(callOpts.model ?? "unknown", "unknown", Date.now() - attemptStart);

      const decision = await applyRetryDecision(
        errInfo, errMsg, state, maxRetries,
        opts.model, fallbackModels, _keyPool, currentModel, onLog,
      );
      if (decision.action === "surface") throw err;
      // "rotated" or "wait" — loop continues
    }
  }
}
