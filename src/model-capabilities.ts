/**
 * Model capability registry.
 *
 * Used to warn at loop start when a selected model lacks features needed for
 * the task, and to enable model-capability-based routing decisions.
 */

export interface ModelCapabilities {
  /** Accepts image inputs (vision) */
  vision: boolean;
  /** Supports extended reasoning / thinking tokens */
  extendedThinking: boolean;
  /** Supports function / tool calling */
  toolUse: boolean;
  /** Supports JSON mode output */
  jsonMode: boolean;
  /** Context window tier */
  contextTier: "small" | "medium" | "large" | "xlarge"; // <32k | 32-128k | 128-200k | 200k+
}

const CAPABILITY_TABLE: Array<[RegExp, Partial<ModelCapabilities>]> = [
  // GPT-4o family — vision, tools, json, large context
  [/gpt-4o/i, { vision: true, toolUse: true, jsonMode: true, contextTier: "large" }],
  // GPT-4 Turbo — vision, tools, json, large context
  [/gpt-4-turbo/i, { vision: true, toolUse: true, jsonMode: true, contextTier: "large" }],
  // GPT-4 base — tools, json, medium context (no vision)
  [/gpt-4/i, { vision: false, toolUse: true, jsonMode: true, contextTier: "medium" }],
  // o1 / o3 reasoning models — extended thinking, tools (limited), large context
  [/\bo[13](?:-mini|-preview)?(?:-\d{4}-\d{2}-\d{2})?$/i, { extendedThinking: true, toolUse: true, contextTier: "large" }],
  // Claude 3.5 / 3.7 — vision, tools, extended thinking (sonnet/opus), xlarge context
  [/claude-3[.-][57]/i, { vision: true, toolUse: true, jsonMode: true, extendedThinking: true, contextTier: "xlarge" }],
  // Claude 3 (non-3.5) — vision, tools, xlarge context
  [/claude-3/i, { vision: true, toolUse: true, jsonMode: true, contextTier: "xlarge" }],
  // Claude 2 / Instant — tools, medium context
  [/claude-[12]|claude-instant/i, { toolUse: true, contextTier: "medium" }],
  // Anthropic via provider prefix — default to latest Claude capabilities
  [/^anthropic\//i, { vision: true, toolUse: true, jsonMode: true, extendedThinking: true, contextTier: "xlarge" }],
  // Gemini 2.x — vision, tools, xlarge context
  [/gemini-2/i, { vision: true, toolUse: true, jsonMode: true, contextTier: "xlarge" }],
  // Gemini 1.5 — vision, tools, xlarge context
  [/gemini-1\.5/i, { vision: true, toolUse: true, jsonMode: true, contextTier: "xlarge" }],
  // Gemini 1.0 — vision, tools, medium context
  [/gemini/i, { vision: true, toolUse: true, contextTier: "medium" }],
  // DeepSeek R1 — extended thinking, tools, large context
  [/deepseek.*r1/i, { extendedThinking: true, toolUse: true, contextTier: "large" }],
  // DeepSeek V3 / chat — tools, large context
  [/deepseek/i, { toolUse: true, contextTier: "large" }],
  // Llama 3 — tools (via OpenRouter), large context
  [/llama-?3/i, { toolUse: true, contextTier: "large" }],
  // Llama 2 — no reliable tool use
  [/llama-?2/i, { toolUse: false, contextTier: "small" }],
  // Qwen 2 — tools, large context
  [/qwen2/i, { toolUse: true, contextTier: "large" }],
  // Mistral Large / Mixtral — tools, medium context
  [/mistral-large|mixtral/i, { toolUse: true, contextTier: "medium" }],
  // Mistral 7B — no reliable tool use, small context
  [/mistral/i, { toolUse: false, contextTier: "small" }],
];

const DEFAULTS: ModelCapabilities = {
  vision: false,
  extendedThinking: false,
  toolUse: true,
  jsonMode: false,
  contextTier: "medium",
};

/**
 * Strip OpenRouter model variant suffixes (e.g. ":nitro", ":thinking", ":online")
 * for capability table matching, then apply suffix-implied capabilities.
 */
export function stripVariantSuffix(model: string): { base: string; suffix: string | null } {
  const colonIdx = model.lastIndexOf(":");
  if (colonIdx === -1) return { base: model, suffix: null };
  const suffix = model.slice(colonIdx + 1).toLowerCase();
  const knownSuffixes = ["nitro", "extended", "thinking", "online", "free", "preview", "floor"];
  if (knownSuffixes.includes(suffix)) {
    return { base: model.slice(0, colonIdx), suffix };
  }
  return { base: model, suffix: null };
}

/**
 * Look up the capability profile for a model.
 * Returns best-match from the table, filling in defaults for unknown fields.
 * Strips variant suffixes (e.g. ":nitro", ":thinking") before table lookup,
 * then applies suffix-implied capability overrides.
 */
export function getModelCapabilities(model: string): ModelCapabilities {
  const { base, suffix } = stripVariantSuffix(model);

  // Look up against the base model ID
  let caps: ModelCapabilities = { ...DEFAULTS };
  for (const [pattern, overrides] of CAPABILITY_TABLE) {
    if (pattern.test(base)) {
      caps = { ...DEFAULTS, ...overrides };
      break;
    }
  }

  // Apply suffix-implied capability overrides
  if (suffix === "thinking") {
    caps = { ...caps, extendedThinking: true };
  }
  if (suffix === "online") {
    // :online variant has built-in web search — treat as having it in tool form
    // (no new ModelCapabilities field needed — just note it in context tier)
  }
  if (suffix === "extended") {
    // :extended means larger context window — bump to xlarge
    caps = { ...caps, contextTier: "xlarge" };
  }

  return caps;
}

/**
 * Check whether a model supports tool/function calling.
 * Used to warn before starting a tool-heavy agent run.
 */
export function modelSupportsTools(model: string): boolean {
  return getModelCapabilities(model).toolUse;
}

/**
 * Check whether a model supports vision (image inputs).
 */
export function modelSupportsVision(model: string): boolean {
  return getModelCapabilities(model).vision;
}
