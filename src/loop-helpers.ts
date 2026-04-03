/**
 * loop-helpers.ts — Pure utility functions used by the agent loop.
 *
 * After Sprint 9 decomposition this file retains:
 *  - Memory section header constants
 *  - Tool result cache (CacheEntry, isReadOnlyTool)
 *  - Concurrency helper (runConcurrent)
 *  - Per-turn model routing (evaluateTurnModelRules)
 *
 * The following sections were extracted to dedicated modules:
 *  - Token estimation  → src/token-estimator.ts
 *  - Context window / model cache → src/model-cache.ts
 *  - Discord webhook formatting → src/webhook.ts
 *  - Session summarization + distillation → src/session-summarizer.ts
 *
 * Re-exports below keep all existing import paths working without change.
 */

import type { TurnModelRule, TurnContext } from "./types.js";

// ── Memory section header constants ──────────────────────────────────────────
// Canonical headers used when injecting memory blocks into the system prompt.
// Keeping them as named constants prevents accidental divergence across call sites
// and ensures the frozen/dynamic boundary split is deterministic.
export const MEMORY_HEADER_MASTER        = "## Persistent Product Context";
export const MEMORY_HEADER_RETRIEVED     = "## Your persistent memory";
export const MEMORY_HEADER_AUTO          = "# Persistent memory";
export const MEMORY_HEADER_PRIOR_SESSION = "## Prior session context";
/** Header that marks the SkillBank injection section (ADR-0006). */
export const SKILL_HEADER                = "## Learned Skills";

/**
 * Maximum share of the context window (in tokens) that the dynamic memory
 * section (master context + retrieved memory + auto-memory + prior session)
 * is allowed to occupy. At 20% a 200k-token model allows ~40k tokens of
 * injected memory; a 32k model caps at ~6.4k tokens.
 * Override via ORAGER_MEMORY_BUDGET_FRACTION env var (0 < value ≤ 1).
 */
export const MEMORY_DYNAMIC_BUDGET_FRACTION = parseFloat(
  process.env["ORAGER_MEMORY_BUDGET_FRACTION"] ?? "0.20",
);

// ── Tool result cache ─────────────────────────────────────────────────────────

export interface CacheEntry {
  result: string;
  timestamp: number;
}

export const CACHE_TTL_MS = 30_000; // 30 seconds

/** Determines if a tool name looks read-only (get/list/read/fetch, not write). */
export function isReadOnlyTool(toolName: string): boolean {
  const lower = toolName.toLowerCase();
  const hasWriteKeyword =
    lower.includes("post") ||
    lower.includes("update") ||
    lower.includes("delete") ||
    lower.includes("create") ||
    lower.includes("patch");
  if (hasWriteKeyword) return false;
  return (
    lower.includes("get") ||
    lower.includes("list") ||
    lower.includes("read") ||
    lower.includes("fetch")
  );
}

// ── Concurrency helper ────────────────────────────────────────────────────────

/**
 * Run `fn` over every item with at most `limit` concurrent executions.
 * Results are returned in the same order as the input array.
 *
 * M-08: When any worker throws, remaining workers stop picking up new items.
 * In-flight items complete naturally but no new work is started.
 */
export async function runConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (!Number.isFinite(limit) || limit < 1) {
    throw new Error(`runConcurrent: limit must be a positive integer, got ${limit}`);
  }
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  let failed = false; // M-08: signal workers to stop on first error

  async function worker(): Promise<void> {
    while (!failed && nextIndex < items.length) {
      const i = nextIndex++;
      try {
        results[i] = await fn(items[i]);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    worker,
  );
  // Use allSettled to let in-flight items finish, then rethrow the first error
  const settled = await Promise.allSettled(workers);
  const firstError = settled.find((r) => r.status === "rejected");
  if (firstError && firstError.status === "rejected") {
    throw firstError.reason;
  }
  return results;
}

export const MAX_PARALLEL_TOOLS = 10;

// ── Per-turn model routing ────────────────────────────────────────────────────

/**
 * Evaluate turn model rules in order; return the model from the first matching rule,
 * or undefined if no rule matches.
 * `firedOnce` tracks which once-rules have already fired (modified in place).
 */
export function evaluateTurnModelRules(
  rules: TurnModelRule[] | undefined,
  ctx: TurnContext,
  firedOnce: Set<number>,
): string | undefined {
  if (!rules || rules.length === 0) return undefined;
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    if (rule.once && firedOnce.has(i)) continue;
    const turnMatch = rule.afterTurn === undefined || ctx.turn >= rule.afterTurn;
    const costMatch = rule.costAbove === undefined || ctx.cumulativeCostUsd > rule.costAbove;
    const tokenMatch = rule.tokensAbove === undefined || ctx.cumulativeTokens.prompt > rule.tokensAbove;
    if (turnMatch && costMatch && tokenMatch) {
      if (rule.once) firedOnce.add(i);
      return rule.model;
    }
  }
  return undefined;
}

// ── Re-exports for backward compatibility ────────────────────────────────────
// Callers that import from loop-helpers.js continue to work unchanged.

export {
  loadCl100k,
  loadO200k,
  bpeEncoderFamily,
  getCharsPerToken,
  estimateTokens,
} from "./token-estimator.js";

export {
  fetchModelContextLengths,
  isModelContextCacheWarm,
  _resetModelCacheForTesting,
  getContextWindowFromFallback,
  getContextWindow,
  defaultTimeoutForModel,
} from "./model-cache.js";

export {
  formatDiscordPayload,
  postWebhook,
} from "./webhook.js";

export {
  MAX_SESSION_MESSAGES,
  SUMMARIZE_PROMPT,
  validateSummary,
  type MemoryUpdatePayload,
  MEMORY_UPDATE_MAX_CHARS,
  MEMORY_UPDATE_INSTRUCTION,
  parseMemoryUpdates,
  summarizeSession,
  DISTILL_ENTRY_THRESHOLD,
  DISTILL_BATCH_SIZE,
  distillMemoryEntries,
} from "./session-summarizer.js";
