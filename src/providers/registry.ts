/**
 * Provider registry — resolves the correct ModelProvider for a given request.
 *
 * Resolution priority (first match wins):
 *   1. Ollama — when opts._ollamaBaseUrl is set (explicit local routing from loop.ts)
 *   2. Anthropic Direct — when model starts with "anthropic/" and ANTHROPIC_API_KEY is set
 *   3. OpenAI Direct — when model starts with "gpt-"/"o1"/"o3"/"o4" and OPENAI_API_KEY is set
 *   4. DeepSeek Direct — when model starts with "deepseek/" and DEEPSEEK_API_KEY is set
 *   5. Gemini Direct — when model starts with "gemini/" and GEMINI_API_KEY/GOOGLE_API_KEY is set
 *   6. OpenRouter — universal fallback (handles any model via cloud routing)
 *
 * Direct providers save 5-15% in OpenRouter markup and remove OpenRouter as a SPOF.
 * OpenRouter remains the default for users who haven't set provider-specific keys.
 * The registry is a singleton populated at import time. Future providers
 * (Azure, Bedrock, Groq) register themselves here.
 */

import type { ModelProvider, ChatCallOptions } from "./types.js";
import { OpenRouterProvider } from "./openrouter-provider.js";
import { AnthropicDirectProvider } from "./anthropic-provider.js";
import { OllamaProvider } from "./ollama-provider.js";
import { OpenAIDirectProvider } from "./openai-provider.js";
import { DeepSeekDirectProvider } from "./deepseek-provider.js";
import { GeminiDirectProvider } from "./gemini-provider.js";

// ── Registry singleton ──────────────────────────────────────────────────────

const _providers = new Map<string, ModelProvider>();

/**
 * Register a provider. Later registrations with the same name overwrite earlier ones.
 */
export function registerProvider(provider: ModelProvider): void {
  _providers.set(provider.name, provider);
}

/**
 * Get a provider by name. Returns undefined if not registered.
 */
export function getProvider(name: string): ModelProvider | undefined {
  return _providers.get(name);
}

/**
 * List all registered provider names.
 */
export function listProviders(): string[] {
  return [..._providers.keys()];
}

// ── Default providers ───────────────────────────────────────────────────────

// Always available
const openRouterProvider = new OpenRouterProvider();
const anthropicDirectProvider = new AnthropicDirectProvider();
const openAIDirectProvider = new OpenAIDirectProvider();
const deepSeekDirectProvider = new DeepSeekDirectProvider();
const geminiDirectProvider = new GeminiDirectProvider();

registerProvider(openRouterProvider);
registerProvider(anthropicDirectProvider);
registerProvider(openAIDirectProvider);
registerProvider(deepSeekDirectProvider);
registerProvider(geminiDirectProvider);

// Ollama is registered dynamically when config is available (via registerOllama)

/**
 * Register an Ollama provider instance with the given config.
 * Called by the loop when opts.ollama is present.
 */
export function registerOllama(config: { enabled?: boolean; baseUrl?: string; model?: string; checkModel?: boolean }): void {
  registerProvider(new OllamaProvider(config));
}

// ── Provider resolver ───────────────────────────────────────────────────────

/**
 * Resolve which provider should handle a given request.
 *
 * This replaces the if/else chain in retry.ts:
 *   if _ollamaBaseUrl → callOllama()
 *   else if shouldUseDirect(model) → callDirect()
 *   else → callOpenRouter()
 *
 * Returns the provider instance + a descriptive reason for logging.
 */
export function resolveProvider(opts: ChatCallOptions): { provider: ModelProvider; reason: string } {
  // Priority 1: Explicit Ollama routing (set by loop.ts when ollama.enabled or OMLS local adapter)
  if (opts._ollamaBaseUrl) {
    const ollama = _providers.get("ollama");
    if (ollama) {
      return { provider: ollama, reason: "ollama (explicit _ollamaBaseUrl)" };
    }
    // Fallback: create an ad-hoc Ollama provider if not registered
    // (backward compat for when _ollamaBaseUrl is set without registerOllama)
    const adhoc = new OllamaProvider({ enabled: true, baseUrl: opts._ollamaBaseUrl });
    return { provider: adhoc, reason: "ollama (ad-hoc from _ollamaBaseUrl)" };
  }

  // Priority 2: Anthropic Direct (model is anthropic/* + ANTHROPIC_API_KEY set)
  if (anthropicDirectProvider.supportsModel(opts.model)) {
    return { provider: anthropicDirectProvider, reason: "anthropic direct (ANTHROPIC_API_KEY set)" };
  }

  // Priority 3: OpenAI Direct (model is gpt-*/o-series + OPENAI_API_KEY set)
  if (openAIDirectProvider.supportsModel(opts.model)) {
    return { provider: openAIDirectProvider, reason: "openai direct (OPENAI_API_KEY set)" };
  }

  // Priority 4: DeepSeek Direct (model is deepseek/* + DEEPSEEK_API_KEY set)
  if (deepSeekDirectProvider.supportsModel(opts.model)) {
    return { provider: deepSeekDirectProvider, reason: "deepseek direct (DEEPSEEK_API_KEY set)" };
  }

  // Priority 5: Gemini Direct (model is gemini/* + GEMINI_API_KEY set)
  if (geminiDirectProvider.supportsModel(opts.model)) {
    return { provider: geminiDirectProvider, reason: "gemini direct (GEMINI_API_KEY set)" };
  }

  // Priority 6: OpenRouter (universal fallback — handles any model including the above when no direct key)
  return { provider: openRouterProvider, reason: "openrouter (default)" };
}

/**
 * Get the OpenRouter provider instance (for embeddings, generation meta, etc.).
 * These capabilities are OpenRouter-specific but needed by multiple callers.
 */
export function getOpenRouterProvider(): OpenRouterProvider {
  return openRouterProvider;
}

/**
 * Reset the registry to defaults. For testing only.
 */
export function _resetRegistryForTesting(): void {
  _providers.clear();
  registerProvider(openRouterProvider);
  registerProvider(anthropicDirectProvider);
  registerProvider(openAIDirectProvider);
  registerProvider(deepSeekDirectProvider);
  registerProvider(geminiDirectProvider);
}
