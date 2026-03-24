import type {
  Message,
  ToolDefinition,
  ToolCall,
  OpenRouterUsage,
  OpenRouterStreamChunk,
  OpenRouterCallOptions,
  OpenRouterCallResult,
} from "./types.js";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const NEWLINE_RE = /\r?\n/;

interface ToolCallAccumulator {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

// ── Shared streaming state ────────────────────────────────────────────────────

interface ParseState {
  contentParts: string[];
  reasoningParts: string[];
  toolCallMap: Map<number, ToolCallAccumulator>;
  usage: OpenRouterUsage;
  cachedTokens: number;
  responseModel: string;
  finishReason: string | null;
  streamError: string | null;
  onChunk?: (chunk: OpenRouterStreamChunk) => void;
}

/**
 * Process a single SSE line ("data: {...}") into the shared parse state.
 * Silently ignores blank lines, non-data lines, `[DONE]`, and malformed JSON.
 */
function processLine(line: string, state: ParseState): void {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return;

  const data = trimmed.slice(5).trim();
  if (data === "[DONE]") return;

  let chunk: OpenRouterStreamChunk;
  try {
    chunk = JSON.parse(data) as OpenRouterStreamChunk;
  } catch {
    return;
  }

  state.onChunk?.(chunk);

  // Mid-stream error: OpenRouter sends finish_reason:"error" + top-level error object
  if (chunk.error) {
    state.streamError =
      typeof chunk.error.message === "string"
        ? chunk.error.message
        : JSON.stringify(chunk.error);
  }

  if (chunk.usage) {
    state.usage = chunk.usage;
    state.cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
  }

  if (chunk.model) {
    state.responseModel = chunk.model;
  }

  for (const choice of chunk.choices) {
    if (choice.finish_reason) {
      state.finishReason = choice.finish_reason;
    }

    if (choice.finish_reason === "error" && !state.streamError) {
      state.streamError = "Stream finished with error";
    }

    const delta = choice.delta;

    if (delta.content != null) {
      state.contentParts.push(delta.content);
    }

    if (delta.reasoning != null) {
      state.reasoningParts.push(delta.reasoning);
    }
    if (delta.reasoning_details) {
      for (const rd of delta.reasoning_details) {
        const text = rd.text ?? rd.content ?? "";
        if (text) state.reasoningParts.push(text);
      }
    }

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index;

        if (!state.toolCallMap.has(idx)) {
          state.toolCallMap.set(idx, {
            id: tc.id ?? "",
            type: "function",
            function: { name: "", arguments: "" },
          });
        }

        const acc = state.toolCallMap.get(idx)!;

        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.function.name += tc.function.name;
        if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
      }
    }
  }
}

// ── Main API call ─────────────────────────────────────────────────────────────

export async function callOpenRouter(
  opts: OpenRouterCallOptions
): Promise<OpenRouterCallResult> {
  const { apiKey, model, messages, tools, signal, onChunk } = opts;
  const maxTokens = opts.max_tokens;

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };

  if (tools && tools.length > 0) {
    body.tools = tools;
  }

  if (maxTokens !== undefined) {
    body.max_tokens = maxTokens;
  }

  // Sampling — only include if explicitly set
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.top_p !== undefined) body.top_p = opts.top_p;
  if (opts.top_k !== undefined) body.top_k = opts.top_k;
  if (opts.frequency_penalty !== undefined) body.frequency_penalty = opts.frequency_penalty;
  if (opts.presence_penalty !== undefined) body.presence_penalty = opts.presence_penalty;
  if (opts.repetition_penalty !== undefined) body.repetition_penalty = opts.repetition_penalty;
  if (opts.min_p !== undefined) body.min_p = opts.min_p;
  if (opts.top_a !== undefined) body.top_a = opts.top_a;
  if (opts.seed !== undefined) body.seed = opts.seed;
  if (opts.stop !== undefined && opts.stop.length > 0) body.stop = opts.stop;
  if (opts.logit_bias !== undefined) body.logit_bias = opts.logit_bias;
  if (opts.logprobs !== undefined) body.logprobs = opts.logprobs;
  if (opts.top_logprobs !== undefined) body.top_logprobs = opts.top_logprobs;
  // Tool control
  if (opts.tool_choice !== undefined) body.tool_choice = opts.tool_choice;
  if (opts.parallel_tool_calls !== undefined) body.parallel_tool_calls = opts.parallel_tool_calls;
  // Reasoning
  if (opts.reasoning !== undefined) body.reasoning = opts.reasoning;
  // Output format
  if (opts.response_format !== undefined) body.response_format = opts.response_format;
  if (opts.structured_outputs !== undefined) body.structured_outputs = opts.structured_outputs;
  // Provider routing
  if (opts.provider !== undefined) body.provider = opts.provider;
  // Context transforms
  if (opts.transforms !== undefined && opts.transforms.length > 0) body.transforms = opts.transforms;
  // Fallback models
  if (opts.models !== undefined && opts.models.length > 0) body.models = opts.models;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  if (opts.siteUrl) headers["HTTP-Referer"] = opts.siteUrl;
  if (opts.siteName) headers["X-Title"] = opts.siteName;

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "(unreadable)");
    throw new Error(
      `OpenRouter error ${response.status} ${response.statusText}: ${errorBody.slice(0, 500)}`
    );
  }

  if (!response.body) {
    throw new Error("OpenRouter response has no body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  const state: ParseState = {
    contentParts: [],
    reasoningParts: [],
    toolCallMap: new Map(),
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    cachedTokens: 0,
    responseModel: model,
    finishReason: null,
    streamError: null,
    onChunk,
  };

  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split(NEWLINE_RE);
    // Keep the last (potentially incomplete) line in the buffer
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      processLine(line, state);
    }
  }

  // Drain any remaining buffer content — may contain multiple unparsed lines
  for (const line of buffer.split(NEWLINE_RE)) {
    processLine(line, state);
  }

  // Filter out incomplete tool calls (missing id or name — stream may have been truncated)
  const toolCalls: ToolCall[] = Array.from(state.toolCallMap.entries())
    .sort(([a], [b]) => a - b)
    .map(([, acc]) => acc)
    .filter((tc) => tc.id !== "" && tc.function.name !== "");

  return {
    content: state.contentParts.join(""),
    reasoning: state.reasoningParts.join(""),
    toolCalls,
    usage: state.usage,
    cachedTokens: state.cachedTokens,
    model: state.responseModel,
    finishReason: state.finishReason,
    isError: state.streamError !== null,
    errorMessage: state.streamError ?? undefined,
  };
}
