/**
 * Provider-agnostic model interface — ADR-0010 Provider Adapters.
 *
 * Every model backend (OpenRouter, Anthropic Direct, Ollama, future Azure/Bedrock)
 * implements `ModelProvider`. The agent loop and retry logic operate on this
 * interface, never on provider-specific functions directly.
 *
 * Existing provider-specific code (callOpenRouter, callDirect, callOllama) is
 * preserved and wrapped — this is an abstraction layer, not a rewrite.
 */

import type {
  OpenRouterCallOptions,
  OpenRouterCallResult,
  OpenRouterProviderRouting,
  OpenRouterReasoningConfig,
  OpenRouterResponseFormat,
  Message,
  ToolDefinition,
  GenerationMeta,
} from "../types.js";
import type { RateLimitTracker } from "../rate-limit-tracker.js";

// ── Provider-agnostic type aliases ──────────────────────────────────────────
// These give callers a clean, provider-neutral vocabulary while maintaining
// full backward compatibility with existing OpenRouterCallOptions/Result types.

/** Provider-agnostic chat request options. Alias for OpenRouterCallOptions. */
export type ChatCallOptions = OpenRouterCallOptions;

/** Provider-agnostic chat response. Alias for OpenRouterCallResult. */
export type ChatCallResult = OpenRouterCallResult;

// ── Provider interface ──────────────────────────────────────────────────────

export interface ModelProvider {
  /** Unique provider identifier (e.g. "openrouter", "anthropic", "ollama"). */
  readonly name: string;

  /** Human-readable label for logs and UI (e.g. "OpenRouter", "Anthropic Direct"). */
  readonly displayName: string;

  /**
   * Send a streaming chat completion request.
   * All providers return the same ChatCallResult shape — provider-specific
   * fields (generationId, etc.) may be undefined when not applicable.
   */
  chat(opts: ChatCallOptions): Promise<ChatCallResult>;

  /**
   * Returns true if this provider can handle the given model string.
   * Used by the provider resolver to auto-select the right backend.
   *
   * Examples:
   *   - OpenRouter: always returns true (handles any model)
   *   - Anthropic Direct: returns true for "anthropic/*" when ANTHROPIC_API_KEY is set
   *   - Ollama: returns true when explicitly configured
   */
  supportsModel(model: string): boolean;

  /**
   * Fetch post-generation metadata (cost, provider name, latency).
   * Returns null for providers that don't support this (Ollama, Anthropic Direct).
   */
  fetchGenerationMeta?(apiKey: string, generationId: string): Promise<GenerationMeta | null>;

  /**
   * Call the embeddings endpoint.
   * Returns null/throws for providers that don't offer embeddings.
   */
  callEmbeddings?(apiKey: string, model: string, inputs: string[]): Promise<number[][]>;
}

// ── Provider-specific config types ──────────────────────────────────────────

/**
 * OpenRouter-specific configuration — fields that only make sense when
 * routing through OpenRouter's API.
 */
export interface OpenRouterProviderConfig {
  /** OpenRouter API key (or use OPENROUTER_API_KEY env var). */
  apiKey?: string;
  /** Additional API keys for rotation on rate limits. */
  apiKeys?: string[];
  /** Sent as HTTP-Referer for OpenRouter dashboard attribution. */
  siteUrl?: string;
  /** Sent as X-Title for OpenRouter dashboard display. */
  siteName?: string;
  /** Provider routing preferences (order, ignore, require, etc.). */
  provider?: OpenRouterProviderRouting;
  /** Named server-side config preset slug. */
  preset?: string;
  /** Context transforms (e.g. ["middle-out"]). */
  transforms?: string[];
  /** Data collection preference. */
  dataCollection?: "allow" | "deny";
  /** Zero Data Retention mode. */
  zdr?: boolean;
  /** Sort providers by price, throughput, or latency. */
  sort?: "price" | "throughput" | "latency";
  /** Allowed quantization levels. */
  quantizations?: string[];
  /** Only route to providers that support all specified parameters. */
  require_parameters?: boolean;
}

/**
 * Anthropic Direct API configuration — fields for direct Anthropic calls
 * bypassing OpenRouter.
 */
export interface AnthropicProviderConfig {
  /** Anthropic API key (or use ANTHROPIC_API_KEY env var). */
  apiKey?: string;
}

/**
 * Ollama local inference configuration.
 */
export interface OllamaProviderConfig {
  /** Enable Ollama backend. */
  enabled?: boolean;
  /** Ollama server base URL (or use ORAGER_OLLAMA_BASE_URL env var). */
  baseUrl?: string;
  /** Explicit Ollama model tag (overrides auto-mapping). */
  model?: string;
  /** Verify model is pulled before starting a run. Default: true. */
  checkModel?: boolean;
}

/**
 * OpenAI Direct API configuration.
 */
export interface OpenAIProviderConfig {
  /** OpenAI API key (or use OPENAI_API_KEY env var). */
  apiKey?: string;
  /** OpenAI organization ID (or use OPENAI_ORG_ID env var). */
  orgId?: string;
}

/**
 * DeepSeek Direct API configuration.
 * Note: DeepSeek explicitly permits using outputs to train other models (ToS §4.2).
 * Primary OMLS teacher model source.
 */
export interface DeepSeekProviderConfig {
  /** DeepSeek API key (or use DEEPSEEK_API_KEY env var). */
  apiKey?: string;
}

/**
 * Google Gemini Direct API configuration.
 * Note: Gemini outputs may NOT be used to train competing models (Google ToS).
 * The OMLS training pipeline hard-blocks gemini/* trajectories.
 */
export interface GeminiProviderConfig {
  /** Gemini API key (or use GEMINI_API_KEY / GOOGLE_API_KEY env var). */
  apiKey?: string;
}

/**
 * Top-level provider configuration block for settings.json.
 *
 * Backward compatible: when this block is absent, orager falls back to
 * the existing flat config fields (apiKey, siteUrl, ollama, etc.).
 *
 * Example settings.json:
 * {
 *   "providers": {
 *     "openai":    { "apiKey": "sk-..." },
 *     "deepseek":  { "apiKey": "sk-..." },
 *     "gemini":    { "apiKey": "AIza..." },
 *     "anthropic": { "apiKey": "sk-ant-..." },
 *     "openrouter": { "apiKey": "sk-or-..." }
 *   }
 * }
 *
 * Provider selection: if a direct key is set, direct provider wins over OpenRouter.
 * If no direct key is set, OpenRouter handles it (universal fallback).
 */
export interface ProvidersConfig {
  openrouter?: OpenRouterProviderConfig;
  anthropic?: AnthropicProviderConfig;
  openai?: OpenAIProviderConfig;
  deepseek?: DeepSeekProviderConfig;
  gemini?: GeminiProviderConfig;
  ollama?: OllamaProviderConfig;
}
