/**
 * Ollama local inference backend — ADR-0009 Phase 1.
 *
 * Ollama runs a local HTTP server (default: http://localhost:11434) that
 * exposes an OpenAI-compatible API at /v1/chat/completions. orager routes
 * LLM calls to it when opts.ollama.enabled is true, bypassing OpenRouter
 * entirely — no API key required.
 *
 * Model names differ between orager (HuggingFace IDs used by Unsloth) and
 * Ollama (short tag format). OLLAMA_MODEL_MAP handles the translation.
 * Users can override the tag via opts.ollama.model.
 */

import { callOpenRouter } from "./openrouter.js";
import type { OpenRouterCallOptions, OpenRouterCallResult, OllamaConfig } from "./types.js";

// ── Constants ─────────────────────────────────────────────────────────────────

export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";

/**
 * Maps orager model IDs (HuggingFace / OpenRouter) to Ollama tag names.
 *
 * Covers:
 *  - Unsloth HF IDs (used as base model IDs in OMLS training config)
 *  - Common OpenRouter model IDs (used when running against cloud models that
 *    happen to also be available locally via Ollama)
 *
 * If a model ID is not in this map, toOllamaTag() returns it unchanged, which
 * works when the user has already configured opts.ollama.model explicitly or
 * when the model ID happens to be a valid Ollama tag already.
 */
export const OLLAMA_MODEL_MAP: Record<string, string> = {
  // Unsloth / HuggingFace IDs (orager base model registry)
  "unsloth/Meta-Llama-3.1-8B-Instruct":     "llama3.1:8b",
  "unsloth/Qwen2.5-7B-Instruct":            "qwen2.5:7b",
  "unsloth/mistral-7b-instruct-v0.3":       "mistral:7b",
  "unsloth/gemma-3-9b-it":                  "gemma3:9b",
  "unsloth/DeepSeek-R1-Distill-Llama-8B":   "deepseek-r1:8b",

  // OpenRouter IDs → Ollama tags
  "meta-llama/llama-3.1-8b-instruct":       "llama3.1:8b",
  "meta-llama/llama-3.1-70b-instruct":      "llama3.1:70b",
  "meta-llama/llama-3.2-3b-instruct":       "llama3.2:3b",
  "meta-llama/llama-3.3-70b-instruct":      "llama3.3:70b",
  "qwen/qwen2.5-7b-instruct":               "qwen2.5:7b",
  "qwen/qwen2.5-14b-instruct":              "qwen2.5:14b",
  "qwen/qwen3-4b":                          "qwen3:4b",
  "qwen/qwen3-8b":                          "qwen3:8b",
  "qwen/qwen3-14b":                         "qwen3:14b",
  "qwen/qwen3-30b-a3b":                     "qwen3:30b-a3b",
  "qwen/qwen3-32b":                         "qwen3:32b",
  "qwen/qwen3-72b":                         "qwen3:72b",
  "mistralai/mistral-7b-instruct":          "mistral:7b",
  "mistralai/mistral-nemo":                 "mistral-nemo",
  "google/gemma-3-4b-it":                   "gemma3:4b",
  "google/gemma-3-9b-it":                   "gemma3:9b",
  "google/gemma-3-12b-it":                  "gemma3:12b",
  "google/gemma-3-27b-it":                  "gemma3:27b",
  "deepseek/deepseek-r1-distill-llama-8b":  "deepseek-r1:8b",
  "deepseek/deepseek-r1-distill-qwen-14b":  "deepseek-r1:14b",
  "deepseek/deepseek-r1":                   "deepseek-r1",
  "microsoft/phi-4":                        "phi4",
};

// ── Path resolver ─────────────────────────────────────────────────────────────

/**
 * Resolve the Ollama base URL.
 * Priority: ORAGER_OLLAMA_BASE_URL env var → opts.baseUrl → default.
 */
export function resolveOllamaBaseUrl(cfg?: OllamaConfig): string {
  return (
    process.env["ORAGER_OLLAMA_BASE_URL"] ??
    cfg?.baseUrl ??
    DEFAULT_OLLAMA_BASE_URL
  ).replace(/\/$/, "");
}

// ── Model name resolution ─────────────────────────────────────────────────────

/**
 * Map an orager model ID to an Ollama tag.
 * Returns the input unchanged if no mapping exists (passthrough for custom tags).
 */
export function toOllamaTag(oragerModelId: string, cfg?: OllamaConfig): string {
  // Explicit override in config always wins
  if (cfg?.model) return cfg.model;
  return OLLAMA_MODEL_MAP[oragerModelId] ?? oragerModelId;
}

// ── Health checks ─────────────────────────────────────────────────────────────

/**
 * Returns true if the Ollama server is reachable at the given base URL.
 * Times out after 2 seconds — fast enough to not block a run startup.
 */
export async function isOllamaRunning(baseUrl = DEFAULT_OLLAMA_BASE_URL): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/`, {
      signal: AbortSignal.timeout(2_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * List the model tags currently pulled in the local Ollama server.
 * Returns [] when Ollama is unreachable or the request fails.
 */
export async function listOllamaModels(baseUrl = DEFAULT_OLLAMA_BASE_URL): Promise<string[]> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return [];
    const json = await res.json() as { models?: Array<{ name: string }> };
    return json.models?.map((m) => m.name) ?? [];
  } catch {
    return [];
  }
}

/**
 * Returns true if the given Ollama tag is pulled and ready to use.
 * Matching is prefix-tolerant: "llama3.1:8b" matches "llama3.1:8b-instruct-q4_K_M".
 */
export async function isModelPulled(tag: string, baseUrl = DEFAULT_OLLAMA_BASE_URL): Promise<boolean> {
  const models = await listOllamaModels(baseUrl);
  const base = tag.split(":")[0]!;
  return models.some((m) => m === tag || m.startsWith(`${base}:`));
}

// ── Routing decision ──────────────────────────────────────────────────────────

/**
 * Returns true when the Ollama backend should be used for this call.
 * Only checks config — does NOT check if Ollama is actually running.
 * (Runtime health check is done in loop.ts before the run starts.)
 */
export function shouldUseOllama(cfg?: OllamaConfig): boolean {
  return cfg?.enabled === true;
}

// ── Call ──────────────────────────────────────────────────────────────────────

/**
 * Call the local Ollama server using its OpenAI-compatible endpoint.
 *
 * Translates the model name and strips OpenRouter-specific request fields
 * (provider routing, plugins, presets, context transforms) that Ollama
 * does not understand. The streaming SSE format is identical, so the
 * existing callOpenRouter machinery is reused via the _backend param.
 *
 * Token usage, tool calls, and streaming deltas all work normally.
 * Rate-limit tracking and generation-ID metadata are skipped (not applicable
 * for local inference).
 */
export async function callOllama(
  opts: OpenRouterCallOptions,
  cfg?: OllamaConfig,
): Promise<OpenRouterCallResult> {
  const baseUrl = resolveOllamaBaseUrl(cfg);
  const ollamaModel = toOllamaTag(opts.model, cfg);

  const ollamaOpts: OpenRouterCallOptions = {
    ...opts,
    model: ollamaModel,
    // Strip OpenRouter-specific fields Ollama doesn't understand
    provider:    undefined,
    preset:      undefined,
    transforms:  undefined,
    plugins:     undefined,
    // Disable OR context compression (not available locally)
    disableContextCompression: false,
    // No per-user attribution (Ollama is local)
    user:        undefined,
    // Don't strip apiKey — Ollama ignores auth headers, but callOpenRouter
    // requires a non-empty string to build the Authorization header. A dummy
    // value keeps the function signature clean. Ollama silently ignores it.
  };

  return callOpenRouter(ollamaOpts, { baseUrl: `${baseUrl}/v1` });
}
