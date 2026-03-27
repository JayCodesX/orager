import { stripVariantSuffix } from "./model-capabilities.js";

/**
 * Known deprecated OpenRouter models and their suggested replacements.
 * Used to warn users at loop start when a deprecated model is requested.
 *
 * Update this list when OpenRouter announces deprecations.
 * Keys are the deprecated model IDs (or prefixes matched case-insensitively).
 */
export const DEPRECATED_MODELS: Array<{
  pattern: RegExp;
  deprecated: string;
  replacement: string;
  reason?: string;
}> = [
  {
    pattern: /gpt-3\.5-turbo(?!-instruct)/i,
    deprecated: "gpt-3.5-turbo",
    replacement: "openai/gpt-4o-mini",
    reason: "GPT-3.5 Turbo is deprecated; gpt-4o-mini is faster, cheaper, and more capable",
  },
  {
    pattern: /claude-2\b/i,
    deprecated: "claude-2",
    replacement: "anthropic/claude-3-5-haiku",
    reason: "Claude 2 is deprecated; Claude 3.5 Haiku offers better performance at lower cost",
  },
  {
    pattern: /claude-instant/i,
    deprecated: "claude-instant",
    replacement: "anthropic/claude-3-5-haiku",
    reason: "Claude Instant is deprecated; Claude 3.5 Haiku is the recommended replacement",
  },
  {
    pattern: /text-davinci/i,
    deprecated: "text-davinci",
    replacement: "openai/gpt-4o-mini",
    reason: "Legacy completion models are deprecated; use a chat model instead",
  },
  {
    pattern: /gpt-4-0314|gpt-4-0613/i,
    deprecated: "gpt-4 (legacy snapshots)",
    replacement: "openai/gpt-4-turbo",
    reason: "Legacy GPT-4 snapshots are deprecated; use gpt-4-turbo",
  },
];

/**
 * Check if a model ID matches any known deprecated model.
 * Returns the deprecation entry if found, or null.
 * Strips variant suffixes (e.g. ":nitro", ":free") before matching.
 */
export function checkDeprecatedModel(
  model: string,
): { deprecated: string; replacement: string; reason?: string } | null {
  // Strip variant suffix before checking deprecation
  const { base } = stripVariantSuffix(model);
  for (const entry of DEPRECATED_MODELS) {
    if (entry.pattern.test(base)) {
      return { deprecated: entry.deprecated, replacement: entry.replacement, reason: entry.reason };
    }
  }
  return null;
}
