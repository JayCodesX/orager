/**
 * Model comparison — fan out a single prompt to N models in parallel and
 * stream per-model deltas as they arrive.
 *
 * Used by:
 *   - subprocess transport:  `compare/run` JSON-RPC 2.0 method
 *   - future UI server route: POST /api/compare/run
 *
 * Design notes:
 *   - Each model runs in its own Promise; all fire concurrently via Promise.all.
 *   - `onChunk` is called from multiple concurrent microtasks — callers must be
 *     prepared for interleaved chunks from different models.
 *   - Direct providers (Anthropic, OpenAI, DeepSeek, Gemini) are preferred when
 *     the matching env var is set; OpenRouter is the universal fallback.
 *   - `apiKey` is passed for OpenRouter calls; direct providers read their own
 *     env vars internally and ignore this field.
 */

import { resolveProvider } from "./providers/index.js";
import type { ChatCallOptions, ChatCallResult } from "./providers/index.js";
import type { OpenRouterStreamChunk } from "./types.js";

// ── Public types ─────────────────────────────────────────────────────────────

export interface CompareParams {
  /** The user prompt to send to every model. */
  prompt: string;
  /** Array of model strings, e.g. ["anthropic/claude-3-haiku", "openai/gpt-4o-mini"]. */
  models: string[];
  /** Optional system prompt prepended to every request. */
  systemPrompt?: string;
  /** Session ID forwarded as a header for sticky OpenRouter routing. */
  sessionId?: string | null;
  /** Sampling temperature (0–2). Defaults to provider default if omitted. */
  temperature?: number;
  /** Max completion tokens. Defaults to provider default if omitted. */
  maxTokens?: number;
}

/**
 * Streaming notification emitted for each model as text arrives.
 * Callers receive one notification per SSE delta plus a final notification
 * with `done: true` that carries latency and token counts.
 */
export interface CompareChunk {
  /** Model that produced this chunk. */
  model: string;
  /** Text delta (may be empty string on the final done notification). */
  chunk: string;
  /** True only on the last notification for this model. */
  done: boolean;
  /** USD cost — set when done=true (null if unavailable). */
  cost?: number | null;
  /** Wall-clock latency from request start to last token (ms) — set when done=true. */
  latencyMs?: number;
  /** Prompt + completion token counts — set when done=true. */
  tokens?: { prompt: number; completion: number };
  /** Error message if the model call failed — set when done=true and the call failed. */
  error?: string;
}

/** Final per-model result, aggregated after all models finish. */
export interface CompareModelResult {
  model: string;
  /** Full assistant text response. Empty string on error. */
  content: string;
  /** Chain-of-thought / reasoning text (DeepSeek R1, o-series). Empty string if none. */
  reasoning: string;
  /** Estimated USD cost (null when provider doesn't report it). */
  cost: number | null;
  /** Wall-clock latency from request start to last token (ms). */
  latencyMs: number;
  /** Prompt + completion token counts. */
  tokens: { prompt: number; completion: number };
  /** Set only when the model call failed. */
  error?: string;
}

export interface CompareResult {
  results: CompareModelResult[];
}

// ── Core implementation ───────────────────────────────────────────────────────

/**
 * Fan out `params.prompt` to all `params.models` in parallel.
 *
 * `onChunk` is called synchronously from within each model's response handler
 * (interleaved across models) to deliver streaming deltas to the caller.
 *
 * Resolves with the full result summary after all models finish (or fail).
 * Never rejects — individual model failures are captured in `result.error`.
 */
export async function runCompare(
  params: CompareParams,
  onChunk: (chunk: CompareChunk) => void,
): Promise<CompareResult> {
  // OpenRouter requires the key as a field; direct providers read env vars
  // internally but still need a non-empty string to pass TypeScript.
  const apiKey =
    process.env["OPENROUTER_API_KEY"] ??
    process.env["PROTOCOL_API_KEY"] ??
    "";

  const results = await Promise.all(
    params.models.map((model) => runSingleModel(model, params, apiKey, onChunk)),
  );

  return { results };
}

// ── Per-model runner ──────────────────────────────────────────────────────────

async function runSingleModel(
  model: string,
  params: CompareParams,
  apiKey: string,
  onChunk: (chunk: CompareChunk) => void,
): Promise<CompareModelResult> {
  const startMs = Date.now();

  // Build messages
  const messages: ChatCallOptions["messages"] = [];
  if (params.systemPrompt) {
    messages.push({ role: "system", content: params.systemPrompt });
  }
  messages.push({ role: "user", content: params.prompt });

  const callOpts: ChatCallOptions = {
    apiKey,
    model,
    messages,
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
    ...(params.maxTokens !== undefined ? { max_completion_tokens: params.maxTokens } : {}),
    // Emit streaming deltas as compare/chunk notifications
    onChunk: (rawChunk: OpenRouterStreamChunk) => {
      const delta = rawChunk.choices?.[0]?.delta;
      const text = delta?.content ?? "";
      if (text) {
        onChunk({ model, chunk: text, done: false });
      }
    },
  };

  let result: ChatCallResult;
  try {
    const { provider } = resolveProvider(callOpts);
    result = await provider.chat(callOpts);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const latencyMs = Date.now() - startMs;

    // Emit final done notification with error
    onChunk({ model, chunk: "", done: true, latencyMs, error: errorMsg });

    return {
      model,
      content: "",
      reasoning: "",
      cost: null,
      latencyMs,
      tokens: { prompt: 0, completion: 0 },
      error: errorMsg,
    };
  }

  const latencyMs = Date.now() - startMs;

  // Emit final done notification with stats (no extra cost field available synchronously)
  onChunk({
    model,
    chunk: "",
    done: true,
    latencyMs,
    tokens: {
      prompt: result.usage?.prompt_tokens ?? 0,
      completion: result.usage?.completion_tokens ?? 0,
    },
    cost: null, // cost is fetched async via generation meta; not included here
    ...(result.isError ? { error: result.errorMessage ?? "Unknown error" } : {}),
  });

  return {
    model,
    content: result.content,
    reasoning: result.reasoning,
    cost: null,
    latencyMs,
    tokens: {
      prompt: result.usage?.prompt_tokens ?? 0,
      completion: result.usage?.completion_tokens ?? 0,
    },
    ...(result.isError ? { error: result.errorMessage ?? "Unknown error" } : {}),
  };
}
