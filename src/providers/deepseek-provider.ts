/**
 * DeepSeek Direct API provider adapter.
 *
 * Calls the DeepSeek API directly (api.deepseek.com), which is OpenAI-compatible.
 * Supports deepseek-chat (DeepSeek-V3) and deepseek-reasoner (DeepSeek-R1).
 *
 * Why DeepSeek Direct matters:
 *   - ~27x cheaper than comparable closed models
 *   - Explicitly permits output use for training/distillation (ToS Section 4.2)
 *   - MIT-licensed open weights — primary OMLS teacher model
 *   - No OpenRouter markup
 *
 * Auth: DEEPSEEK_API_KEY env var or providers.deepseek.apiKey in settings.json
 */

import type { ModelProvider, ChatCallOptions, ChatCallResult } from "./types.js";
import { updateRateLimitState } from "../rate-limit-tracker.js";
import { trace } from "@opentelemetry/api";

const DEEPSEEK_BASE = (process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1").replace(/\/$/, "");
const ENDPOINT = `${DEEPSEEK_BASE}/chat/completions`;

/** Model names/prefixes routed to DeepSeek Direct when DEEPSEEK_API_KEY is set. */
const DEEPSEEK_MODEL_PREFIXES = ["deepseek/", "deepseek-"];

function isDeepSeekModel(model: string): boolean {
  return DEEPSEEK_MODEL_PREFIXES.some((p) => model.startsWith(p));
}

/** Strip "deepseek/" namespace prefix — DeepSeek API uses bare model names. */
function stripNamespace(model: string): string {
  return model.startsWith("deepseek/") ? model.slice(9) : model;
}

function getApiKey(opts: ChatCallOptions): string | undefined {
  return opts.apiKey || process.env.DEEPSEEK_API_KEY;
}

export class DeepSeekDirectProvider implements ModelProvider {
  readonly name = "deepseek" as const;
  readonly displayName = "DeepSeek Direct";

  supportsModel(model: string): boolean {
    return isDeepSeekModel(model) && !!process.env.DEEPSEEK_API_KEY;
  }

  async chat(opts: ChatCallOptions): Promise<ChatCallResult> {
    return callDeepSeekDirect(opts);
  }
}

/**
 * Call the DeepSeek chat completions API with streaming.
 * DeepSeek is OpenAI API-compatible so the wire format is identical.
 */
export async function callDeepSeekDirect(opts: ChatCallOptions): Promise<ChatCallResult> {
  const tracer = trace.getTracer("orager");
  return tracer.startActiveSpan("deepseek.chat", async (span) => {
    try {
      const result = await _callDeepSeek(opts);
      span.setAttribute("model", result.model);
      span.setAttribute("prompt_tokens", result.usage.prompt_tokens);
      span.setAttribute("completion_tokens", result.usage.completion_tokens);
      return result;
    } finally {
      span.end();
    }
  });
}

async function _callDeepSeek(opts: ChatCallOptions): Promise<ChatCallResult> {
  const apiKey = getApiKey(opts);
  if (!apiKey) {
    return makeErrorResult("DEEPSEEK_API_KEY is not set");
  }

  const model = stripNamespace(opts.model);

  const body: Record<string, unknown> = {
    model,
    messages: opts.messages,
    stream: true,
    stream_options: { include_usage: true },
  };

  if (opts.tools && opts.tools.length > 0) body.tools = opts.tools;
  if (opts.tool_choice) body.tool_choice = opts.tool_choice;
  if (opts.max_completion_tokens) body.max_tokens = opts.max_completion_tokens;
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.top_p !== undefined) body.top_p = opts.top_p;
  if (opts.frequency_penalty !== undefined) body.frequency_penalty = opts.frequency_penalty;
  if (opts.presence_penalty !== undefined) body.presence_penalty = opts.presence_penalty;
  if (opts.stop) body.stop = opts.stop;

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "User-Agent": "orager/1.0",
      },
      body: JSON.stringify(body),
      signal: opts.signal ?? undefined,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return makeErrorResult(`DeepSeek fetch error: ${msg}`);
  }

  if (!res.ok) {
    updateRateLimitState(res.headers);
    const text = await res.text().catch(() => "");
    return makeErrorResult(`DeepSeek API error ${res.status}: ${text}`);
  }

  return parseDeepSeekStream(res, opts, model);
}

interface ToolCallAcc {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

async function parseDeepSeekStream(
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
  let responseModel = `deepseek/${resolvedModel}`;

  const reader = res.body?.getReader();
  if (!reader) return makeErrorResult("DeepSeek: no response body");

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

        if (chunk.model) responseModel = `deepseek/${chunk.model as string}`;

        if (chunk.usage) {
          const u = chunk.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
          usage = {
            prompt_tokens: u.prompt_tokens ?? 0,
            completion_tokens: u.completion_tokens ?? 0,
            total_tokens: u.total_tokens ?? 0,
          };
        }

        for (const choice of ((chunk.choices as unknown[]) ?? [])) {
          const c = choice as Record<string, unknown>;
          if (c.finish_reason) finishReason = c.finish_reason as string;

          const delta = (c.delta ?? {}) as Record<string, unknown>;

          if (typeof delta.content === "string" && delta.content) {
            contentParts.push(delta.content);
            opts.onChunk?.({
              choices: [{ delta: { content: delta.content }, finish_reason: null, index: 0 }],
              id: "",
              model: responseModel,
              usage: undefined as unknown as typeof usage,
            });
          }

          // DeepSeek-R1 chain-of-thought reasoning tokens
          if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
            reasoningParts.push(delta.reasoning_content);
          }

          for (const tc of ((delta.tool_calls as unknown[]) ?? [])) {
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

  if (streamError) return makeErrorResult(streamError);

  const toolCalls = [...toolCallMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, acc]) => acc);

  return {
    content: contentParts.join(""),
    reasoning: reasoningParts.join(""),
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
    model: "deepseek/unknown",
    finishReason: "stop",
    isError: true,
  };
}
