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

function isFatal(message: string): boolean {
  return FATAL_PATTERNS.some((p) => p.test(message));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calls OpenRouter with exponential-backoff retry on transient errors.
 * Fatal errors (auth, bad request) are returned/thrown immediately without retrying.
 * @param maxRetries Number of retries after the first attempt (0 = no retries).
 */
export async function callWithRetry(
  opts: OpenRouterCallOptions,
  maxRetries: number,
  onLog?: (msg: string) => void,
): Promise<OpenRouterCallResult> {
  let attempt = 0;

  while (true) {
    try {
      const result = await callOpenRouter(opts);

      // Clean response — return immediately
      if (!result.isError) return result;

      const errMsg = result.errorMessage ?? "stream error";

      // Fatal or out of retries — surface the error result to the caller
      if (isFatal(errMsg) || attempt >= maxRetries) return result;

      const backoffMs = 1000 * 2 ** attempt;
      onLog?.(
        `[orager] retryable stream error (attempt ${attempt + 1}/${maxRetries + 1}): ${errMsg} — retrying in ${backoffMs}ms\n`,
      );
      await sleep(backoffMs);
      attempt++;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);

      // Fatal or out of retries — rethrow
      if (isFatal(errMsg) || attempt >= maxRetries) throw err;

      const backoffMs = 1000 * 2 ** attempt;
      onLog?.(
        `[orager] retryable error (attempt ${attempt + 1}/${maxRetries + 1}): ${errMsg} — retrying in ${backoffMs}ms\n`,
      );
      await sleep(backoffMs);
      attempt++;
    }
  }
}
