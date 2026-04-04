/**
 * OpenAI Direct API provider adapter.
 *
 * Calls the OpenAI chat completions API directly (api.openai.com), bypassing
 * OpenRouter. Supports all gpt-* and o-series models.
 *
 * Benefits over OpenRouter for OpenAI models:
 *   - No OpenRouter markup (5-15% cost saving)
 *   - Direct access to latest model versions
 *   - Eliminates OpenRouter as SPOF for OpenAI models
 *
 * Auth: OPENAI_API_KEY env var or providers.openai.apiKey in settings.json
 */

import type { ModelProvider, ChatCallOptions, ChatCallResult } from "./types.js";
import { updateRateLimitState } from "../rate-limit-tracker.js";
import { trace } from "@opentelemetry/api";

const OPENAI_BASE = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
const ENDPOINT = `${OPENAI_BASE}/chat/completions`;

/** Model prefixes/names routed to OpenAI Direct when OPENAI_API_KEY is set. */
const OPENAI_MODEL_PREFIXES = ["gpt-", "o1", "o3", "o4", "chatgpt-"];

function isOpenAIModel(model: string): boolean {
  // Strip provider namespace if present (e.g. "openai/gpt-4o" → "gpt-4o")
  const bare = model.startsWith("openai/") ? model.slice(7) : model;
  return OPENAI_MODEL_PREFIXES.some((p) => bare.startsWith(p));
}

function getApiKey(opts: ChatCallOptions): string | undefined {
  return (
    opts.apiKey ||
    process.env.OPENAI_API_KEY
  );
}

export class OpenAIDirectProvider implements ModelProvider {
  readonly name = "openai" as const;
  readonly displayName = "OpenAI Direct";

  supportsModel(model: string): boolean {
    return isOpenAIModel(model) && !!process.env.OPENAI_API_KEY;
  }

  async chat(opts: ChatCallOptions): Promise<ChatCallResult> {
    return callOpenAIDirect(opts);
  }
}

/**
 * Call the OpenAI chat completions API with streaming.
 * Returns the same ChatCallResult shape as callOpenRouter / callDirect.
 */
export async function callOpenAIDirect(opts: ChatCallOptions): Promise<ChatCallResult> {
  const tracer = trace.getTracer("orager");
  return tracer.startActiveSpan("openai.chat", async (span) => {
    try {
      const result = await _callOpenAI(opts);
      span.setAttribute("model", result.model);
      span.setAttribute("prompt_tokens", result.usage.prompt_tokens);
      span.setAttribute("completion_tokens", result.usage.completion_tokens);
      return result;
    } finally {
      span.end();
    }
  });
}

async function _callOpenAI(opts: ChatCallOptions): Promise<ChatCallResult> {
  const apiKey = getApiKey(opts);
  if (!apiKey) {
    return makeErrorResult("OPENAI_API_KEY is not set");
  }

  // Strip provider namespace from model name (OpenAI API doesn't accept "openai/gpt-4o")
  const model = opts.model.startsWith("openai/") ? opts.model.slice(7) : opts.model;

  const body: Record<string, unknown> = {
    model,
    messages: opts.messages,
    stream: true,
    stream_options: { include_usage: true },
  };

  if (opts.tools && opts.tools.length > 0) body.tools = opts.tools;
  if (opts.tool_choice) body.tool_choice = opts.tool_choice;
  if (opts.max_completion_tokens) body.max_completion_tokens = opts.max_completion_tokens;
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.top_p !== undefined) body.top_p = opts.top_p;
  if (opts.frequency_penalty !== undefined) body.frequency_penalty = opts.frequency_penalty;
  if (opts.presence_penalty !== undefined) body.presence_penalty = opts.presence_penalty;
  if (opts.seed !== undefined) body.seed = opts.seed;
  if (opts.stop) body.stop = opts.stop;
  if (opts.parallel_tool_calls !== undefined) body.parallel_tool_calls = opts.parallel_tool_calls;
  if (opts.response_format) body.response_format = opts.response_format;

  // o-series reasoning models
  if (opts.reasoning?.effort) body.reasoning_effort = opts.reasoning.effort;

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "OpenAI-Organization": process.env.OPENAI_ORG_ID ?? "",
        "User-Agent": "orager/1.0",
      },
      body: JSON.stringify(body),
      signal: opts.signal ?? undefined,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return makeErrorResult(`OpenAI fetch error: ${msg}`);
  }

  if (!res.ok) {
    // Pass response headers so rate-limit-tracker can parse retry-after, x-ratelimit-* etc.
    updateRateLimitState(res.headers);
    const text = await res.text().catch(() => "");
    return makeErrorResult(`OpenAI API error ${res.status}: ${text}`);
  }

  // Parse SSE stream
  return parseOpenAIStream(res, opts, model);
}

interface ToolCallAcc {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

async function parseOpenAIStream(
  res: Response,
  opts: ChatCallOptions,
  resolvedModel: string,
): Promise<ChatCallResult> {
  const contentParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCallMap = new Map<number, ToolCallAcc>();
  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let finishReason: string | null = null;
  let streamError: string | null = null;
  let responseModel = resolvedModel;

  const reader = res.body?.getReader();
  if (!reader) return makeErrorResult("OpenAI: no response body");

  const decoder = new TextDecoder();
  let buf = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") continue;

        let chunk: Record<string, unknown>;
        try {
          chunk = JSON.parse(data) as Record<string, unknown>;
        } catch {
          continue;
        }

        if (chunk.model) responseModel = chunk.model as string;

        // Usage (comes in final chunk with stream_options: { include_usage: true })
        if (chunk.usage) {
          const u = chunk.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
          usage = {
            prompt_tokens: u.prompt_tokens ?? 0,
            completion_tokens: u.completion_tokens ?? 0,
            total_tokens: u.total_tokens ?? 0,
          };
        }

        const choices = (chunk.choices as unknown[]) ?? [];
        for (const choice of choices) {
          const c = choice as Record<string, unknown>;
          if (c.finish_reason) finishReason = c.finish_reason as string;

          const delta = (c.delta ?? {}) as Record<string, unknown>;

          if (typeof delta.content === "string") {
            contentParts.push(delta.content);
            opts.onChunk?.({ choices: [{ delta: { content: delta.content }, finish_reason: null, index: 0 }], id: "", model: responseModel, usage: undefined as unknown as typeof usage });
          }

          // Reasoning tokens (o-series)
          if (typeof (delta as Record<string, unknown>).reasoning === "string") {
            reasoningParts.push((delta as Record<string, unknown>).reasoning as string);
          }

          const toolCalls = (delta.tool_calls as unknown[]) ?? [];
          for (const tc of toolCalls) {
            const t = tc as Record<string, unknown>;
            const idx = t.index as number;
            if (!toolCallMap.has(idx)) {
              toolCallMap.set(idx, { id: "", type: "function", function: { name: "", arguments: "" } });
            }
            const acc = toolCallMap.get(idx)!;
            if (t.id) acc.id = t.id as string;
            const fn = (t.function ?? {}) as Record<string, unknown>;
            if (fn.name) acc.function.name += fn.name as string;
            if (fn.arguments) acc.function.arguments += fn.arguments as string;
          }
        }
      }
    }
  } catch (err) {
    if ((err as Error).name !== "AbortError") {
      streamError = err instanceof Error ? err.message : String(err);
    }
  } finally {
    reader.releaseLock();
  }

  const toolCalls = [...toolCallMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, acc]) => acc);

  const content = contentParts.join("");
  const reasoning = reasoningParts.join("");

  if (streamError) {
    return makeErrorResult(streamError);
  }

  return {
    content,
    reasoning,
    toolCalls,
    usage,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    model: responseModel,
    finishReason: finishReason ?? "stop",
    isError: false,
  };
}

function makeErrorResult(message: string): ChatCallResult {
  return {
    content: message,
    reasoning: "",
    toolCalls: [],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    cachedTokens: 0,
    cacheWriteTokens: 0,
    model: "openai/unknown",
    finishReason: "stop",
    isError: true,
  };
}
