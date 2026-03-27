/**
 * OpenRouter API key validation and credit check.
 *
 * Calls GET /api/v1/auth/key to retrieve key metadata including remaining
 * credits, rate limits, and whether the key is disabled.
 *
 * Used at daemon startup and optionally before long runs to surface
 * insufficient-credit errors early rather than mid-task.
 */

export interface ApiKeyInfo {
  label: string;
  disabled: boolean;
  /** Total credit limit in USD (0 = unlimited) */
  limit: number | null;
  /** Credits used so far in USD */
  usage: number;
  /** Remaining credits in USD (null if unlimited) */
  remaining: number | null;
  /** Whether the key has unlimited credits */
  isUnlimited: boolean;
  rateLimitRequests: number | null;
  rateLimitTokens: number | null;
}

/**
 * Fetch API key metadata from OpenRouter.
 * Returns null on any error (network, auth failure, etc.).
 */
export async function fetchApiKeyInfo(apiKey: string): Promise<ApiKeyInfo | null> {
  try {
    const openrouterBase = (process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
    const res = await fetch(`${openrouterBase}/auth/key`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://paperclip.ai",
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const json = await res.json() as {
      data?: {
        label?: string;
        disabled?: boolean;
        limit?: number | null;
        usage?: number;
        rate_limit?: {
          requests?: number;
          tokens?: number;
        };
      };
    };
    const d = json.data;
    if (!d) return null;

    const limit = d.limit ?? null;
    const usage = d.usage ?? 0;
    const remaining = limit !== null ? Math.max(0, limit - usage) : null;

    return {
      label:              d.label ?? "(unnamed key)",
      disabled:           d.disabled ?? false,
      limit,
      usage,
      remaining,
      isUnlimited:        limit === null,
      rateLimitRequests:  d.rate_limit?.requests ?? null,
      rateLimitTokens:    d.rate_limit?.tokens ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Threshold below which a low-credit warning is emitted (USD).
 * Configurable via ORAGER_CREDIT_WARN_THRESHOLD env var.
 */
export function getCreditWarnThreshold(): number {
  const env = process.env["ORAGER_CREDIT_WARN_THRESHOLD"];
  const parsed = parseFloat(env ?? "");
  return isNaN(parsed) ? 1.0 : parsed; // default: warn at $1.00 remaining
}

/**
 * Check key health and log warnings.
 * Returns the key info (or null if unreachable).
 * Logs warnings to the provided logger function.
 */
export async function checkAndLogApiKeyHealth(
  apiKey: string,
  log: (msg: string) => void,
): Promise<ApiKeyInfo | null> {
  const info = await fetchApiKeyInfo(apiKey);
  if (!info) {
    log("[orager] could not verify OpenRouter API key (network error or invalid key)\n");
    return null;
  }
  if (info.disabled) {
    log(`[orager] WARNING: OpenRouter API key '${info.label}' is DISABLED — runs will fail\n`);
    return info;
  }
  if (!info.isUnlimited && info.remaining !== null) {
    const threshold = getCreditWarnThreshold();
    if (info.remaining <= 0) {
      log(`[orager] ERROR: OpenRouter API key '${info.label}' has NO remaining credits ($${info.usage.toFixed(4)} used) — runs will fail with 402\n`);
    } else if (info.remaining < threshold) {
      log(`[orager] WARNING: OpenRouter API key '${info.label}' has only $${info.remaining.toFixed(4)} remaining (threshold: $${threshold.toFixed(2)})\n`);
    } else {
      log(`[orager] API key '${info.label}': $${info.remaining.toFixed(4)} remaining ($${info.usage.toFixed(4)} used)\n`);
    }
  } else {
    log(`[orager] API key '${info.label}': unlimited credits\n`);
  }
  return info;
}
