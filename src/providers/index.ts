/**
 * Provider adapters — barrel export.
 *
 * Usage:
 *   import { resolveProvider, registerProvider, type ModelProvider } from "./providers/index.js";
 */

// Types
export type {
  ModelProvider,
  ChatCallOptions,
  ChatCallResult,
  OpenRouterProviderConfig,
  AnthropicProviderConfig,
  OpenAIProviderConfig,
  DeepSeekProviderConfig,
  GeminiProviderConfig,
  OllamaProviderConfig,
  ProvidersConfig,
} from "./types.js";

// Provider implementations
export { OpenRouterProvider } from "./openrouter-provider.js";
export { AnthropicDirectProvider } from "./anthropic-provider.js";
export { OpenAIDirectProvider, callOpenAIDirect } from "./openai-provider.js";
export { DeepSeekDirectProvider, callDeepSeekDirect } from "./deepseek-provider.js";
export { GeminiDirectProvider, callGeminiDirect } from "./gemini-provider.js";
export { OllamaProvider } from "./ollama-provider.js";

// Registry
export {
  registerProvider,
  getProvider,
  listProviders,
  registerOllama,
  resolveProvider,
  getOpenRouterProvider,
  _resetRegistryForTesting,
} from "./registry.js";
