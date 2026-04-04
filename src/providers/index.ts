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
  OllamaProviderConfig,
  ProvidersConfig,
} from "./types.js";

// Provider implementations
export { OpenRouterProvider } from "./openrouter-provider.js";
export { AnthropicDirectProvider } from "./anthropic-provider.js";
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
