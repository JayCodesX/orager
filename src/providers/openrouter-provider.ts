/**
 * OpenRouter provider adapter.
 *
 * Wraps the existing `callOpenRouter`, `callEmbeddings`, and
 * `fetchGenerationMeta` functions behind the ModelProvider interface.
 * No behaviour changes — purely structural.
 */

import {
  callOpenRouter,
  callEmbeddings as _callEmbeddings,
  fetchGenerationMeta as _fetchGenerationMeta,
} from "../openrouter.js";
import type { ModelProvider, ChatCallOptions, ChatCallResult } from "./types.js";
import type { GenerationMeta } from "../types.js";

export class OpenRouterProvider implements ModelProvider {
  readonly name = "openrouter" as const;
  readonly displayName = "OpenRouter";

  /**
   * OpenRouter can handle any model — it's a universal gateway.
   * Returns false only for models that should be routed directly
   * (e.g. anthropic/* when ANTHROPIC_API_KEY is set), but that
   * decision lives in the provider resolver, not here.
   */
  supportsModel(_model: string): boolean {
    return true;
  }

  async chat(opts: ChatCallOptions): Promise<ChatCallResult> {
    return callOpenRouter(opts);
  }

  async fetchGenerationMeta(apiKey: string, generationId: string): Promise<GenerationMeta | null> {
    return _fetchGenerationMeta(apiKey, generationId);
  }

  async callEmbeddings(apiKey: string, model: string, inputs: string[]): Promise<number[][]> {
    return _callEmbeddings(apiKey, model, inputs);
  }
}
