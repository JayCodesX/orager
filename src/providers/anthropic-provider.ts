/**
 * Anthropic Direct API provider adapter.
 *
 * Wraps the existing `callDirect` function behind the ModelProvider interface.
 * Used when ANTHROPIC_API_KEY is set and the model is anthropic/*.
 *
 * Benefits over OpenRouter for Anthropic models:
 *   - ~50-150ms latency reduction (no OpenRouter hop)
 *   - No OpenRouter markup (5-15% cost saving)
 *   - Eliminates OpenRouter as SPOF for Anthropic models
 */

import { callDirect, shouldUseDirect } from "../openrouter.js";
import type { ModelProvider, ChatCallOptions, ChatCallResult } from "./types.js";

export class AnthropicDirectProvider implements ModelProvider {
  readonly name = "anthropic" as const;
  readonly displayName = "Anthropic Direct";

  /**
   * Returns true if the model starts with "anthropic/" AND the
   * ANTHROPIC_API_KEY environment variable is set.
   */
  supportsModel(model: string): boolean {
    return shouldUseDirect(model);
  }

  async chat(opts: ChatCallOptions): Promise<ChatCallResult> {
    return callDirect(opts);
  }

  // Anthropic Direct doesn't support fetchGenerationMeta — cost is derived from token counts.
  // Anthropic doesn't offer a standalone embeddings endpoint via this path.
}
