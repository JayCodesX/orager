/**
 * token-estimator.ts — BPE-based token estimation for agent loop budget tracking.
 *
 * Extracted from loop-helpers.ts (Sprint 9).
 *
 * Provides accurate token counts (via tiktoken) for GPT-4, Claude, and o-series
 * models, with a conservative char/token ratio fallback for other model families
 * (Gemini, Qwen, Llama, Mistral, etc.).
 */

import type { Message } from "./types.js";

// ── Lazy BPE encoder singletons ───────────────────────────────────────────────

// Module-level cache so the token tables are loaded at most once per process.
// Uses tiktoken (WASM-backed) for accuracy parity with the OpenAI API.
let _cl100kEncode: ((text: string) => { length: number }) | null | undefined;
let _o200kEncode: ((text: string) => { length: number }) | null | undefined;

export async function loadCl100k(): Promise<((text: string) => { length: number }) | null> {
  if (_cl100kEncode !== undefined) return _cl100kEncode;
  try {
    const { get_encoding } = await import("tiktoken");
    const enc = get_encoding("cl100k_base");
    _cl100kEncode = (text: string) => enc.encode(text);
  } catch {
    _cl100kEncode = null;
  }
  return _cl100kEncode;
}

export async function loadO200k(): Promise<((text: string) => { length: number }) | null> {
  if (_o200kEncode !== undefined) return _o200kEncode;
  try {
    const { get_encoding } = await import("tiktoken");
    const enc = get_encoding("o200k_base");
    _o200kEncode = (text: string) => enc.encode(text);
  } catch {
    _o200kEncode = null;
  }
  return _o200kEncode;
}

/**
 * Detect which BPE encoder family (if any) is compatible with the given model.
 * Returns "o200k" for GPT-4o family, "cl100k" for GPT-4/Claude/o1/o3,
 * and null for models with incompatible tokenisers (Gemini, Qwen, Llama, etc).
 */
export function bpeEncoderFamily(model: string): "cl100k" | "o200k" | null {
  if (/gpt-4o/i.test(model)) return "o200k";
  if (/gpt-4/i.test(model)) return "cl100k";
  if (/^anthropic\/|^claude-/i.test(model)) return "cl100k";
  if (/\bo[13](?:-|$)/i.test(model)) return "cl100k";
  return null;
}

/**
 * Returns the approximate number of characters per token for a given model.
 * Used as fallback when no BPE tokeniser is available.
 */
export function getCharsPerToken(model: string): number {
  if (/gemini/i.test(model)) return 3.5;
  if (/qwen/i.test(model)) return 3.2;
  if (/deepseek/i.test(model)) return 3.5;
  if (/llama/i.test(model)) return 3.8;
  if (/mistral|mixtral/i.test(model)) return 3.8;
  if (/^anthropic\/|^claude-/i.test(model)) return 4.0;
  if (/gpt-4/i.test(model)) return 4.0;
  if (/\bo[13](?:-|$)/i.test(model)) return 4.0;
  return 4.0;
}

/**
 * Estimate token count for a message array.
 *
 * For GPT-4, Claude, and o-series models, uses the real BPE tokeniser
 * (gpt-tokenizer) for accurate counts. Falls back to a conservative
 * char/token ratio for other model families (Gemini, Qwen, Llama, etc).
 */
export async function estimateTokens(messages: Message[], model = ""): Promise<number> {
  const family = bpeEncoderFamily(model);
  if (family !== null) {
    const encode = family === "o200k" ? await loadO200k() : await loadCl100k();
    if (encode) {
      let tokens = 0;
      for (const msg of messages) {
        if (msg.role === "system") {
          tokens += encode(msg.content).length;
        } else if (msg.role === "tool") {
          tokens += Math.ceil(encode(msg.content).length * 1.1);
        } else if (msg.role === "user") {
          if (typeof msg.content === "string") {
            tokens += encode(msg.content).length;
          } else {
            for (const block of msg.content) {
              if (block.type === "text") tokens += encode(block.text).length;
              else tokens += 1000; // image URL: ~1000 tokens upper bound
            }
          }
        } else if (msg.role === "assistant") {
          if (typeof msg.content === "string" && msg.content) {
            tokens += encode(msg.content).length;
          }
          if (msg.tool_calls) {
            for (const tc of msg.tool_calls) {
              tokens += encode(tc.function.name).length;
              tokens += Math.ceil(encode(tc.function.arguments).length * 1.25);
            }
          }
        }
      }
      return tokens;
    }
  }

  // Fallback: conservative char/token ratio estimate
  const charsPerToken = getCharsPerToken(model);
  let chars = 0;
  for (const msg of messages) {
    if (msg.role === "system") {
      chars += msg.content.length;
    } else if (msg.role === "tool") {
      chars += msg.content.length * 1.1;
    } else if (msg.role === "user") {
      if (typeof msg.content === "string") {
        chars += msg.content.length;
      } else {
        for (const block of msg.content) {
          if (block.type === "text") chars += block.text.length;
          else chars += 1000 * charsPerToken;
        }
      }
    } else if (msg.role === "assistant") {
      if (typeof msg.content === "string" && msg.content) {
        chars += msg.content.length;
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          chars += tc.function.name.length + tc.function.arguments.length * 1.25;
        }
      }
    }
  }
  return Math.ceil(chars / charsPerToken);
}
