/**
 * Ollama local inference provider adapter.
 *
 * Wraps the existing `callOllama` and health-check functions behind the
 * ModelProvider interface. Routes LLM calls to a local Ollama server,
 * bypassing OpenRouter entirely — no API key required.
 */

import { callOllama } from "../ollama.js";
import type { OllamaConfig } from "../types.js";
import type { ModelProvider, ChatCallOptions, ChatCallResult } from "./types.js";

export class OllamaProvider implements ModelProvider {
  readonly name = "ollama" as const;
  readonly displayName = "Ollama (Local)";

  private readonly config: OllamaConfig;

  constructor(config: OllamaConfig) {
    this.config = config;
  }

  /**
   * Returns true when Ollama is explicitly enabled in config.
   * Model name doesn't matter — Ollama handles any model via tag mapping.
   */
  supportsModel(_model: string): boolean {
    return this.config.enabled === true;
  }

  async chat(opts: ChatCallOptions): Promise<ChatCallResult> {
    return callOllama(opts, this.config);
  }

  // Ollama doesn't support fetchGenerationMeta — local inference has no cost metadata.
  // Ollama doesn't offer an embeddings endpoint through this adapter (yet).
}
