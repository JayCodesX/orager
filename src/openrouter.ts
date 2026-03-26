import type {
  Message,
  ToolDefinition,
  ToolCall,
  OpenRouterUsage,
  OpenRouterStreamChunk,
  OpenRouterCallOptions,
  OpenRouterCallResult,
  AnthropicCacheControl,
} from "./types.js";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const NEWLINE_RE = /\r?\n/;

// ── Anthropic prompt cache helpers ────────────────────────────────────────────
// Anthropic models (anthropic/*) support explicit cache_control breakpoints
// that signal which parts of the prompt should be cached.  OpenRouter passes
// these through transparently; for all other providers this field is a no-op.
//
// Cache breakpoint strategy (3 breakpoints, matching Anthropic's recommendation):
//   1. System prompt — largest stable block; shared across agents with the
//      same base system prompt (OpenRouter serves cache hits to any agent
//      sending identical prefix content, not just the originating session).
//   2. Last tool definition — tool list rarely changes mid-session.
//   3. Last "prior" message — the message just before the new user turn; marks
//      the end of the stable conversation history from the previous turn.
//
// The X-Session-Id header on every request enables sticky routing: OpenRouter
// will attempt to send requests with the same session ID to the same provider
// endpoint, further increasing cache hit rates.

/**
 * Shallow-clone a message and attach cache_control to its content.
 *
 * Anthropic requires cache_control to be nested inside a content block object
 * rather than on the message root.  For system and user messages (which have
 * string content in our types) we wrap the string in a single-element content
 * block array.  For assistant messages with string content we do the same.
 * All other messages (tool, null-content assistant) get cache_control at the
 * top level — these are edge cases that Anthropic silently ignores.
 */
function withCacheControl(
  msg: Message,
  cc: AnthropicCacheControl,
): Message {
  if (msg.role === "system") {
    // Wrap system prompt string in a content block so cache_control is valid
    return {
      ...msg,
      content: [{ type: "text", text: msg.content, cache_control: cc }],
    } as unknown as Message;
  }
  if (msg.role === "user") {
    return {
      ...msg,
      content: [{ type: "text", text: msg.content, cache_control: cc }],
    } as unknown as Message;
  }
  if (msg.role === "assistant" && typeof msg.content === "string") {
    return {
      ...msg,
      content: [{ type: "text", text: msg.content, cache_control: cc }],
    } as unknown as Message;
  }
  // Fallback: attach at top level (tool messages, null-content assistant messages)
  return { ...msg, cache_control: cc } as unknown as Message;
}

/**
 * For Anthropic models, inject cache_control at up to 3 strategic breakpoints:
 * system prompt, last tool definition, and last prior-turn message.
 * For non-Anthropic models returns messages and tools unchanged.
 */
function applyAnthropicCacheControl(
  model: string,
  messages: Message[],
  tools: ToolDefinition[] | undefined,
): { messages: Message[]; tools: ToolDefinition[] | undefined } {
  if (!model.startsWith("anthropic/")) {
    return { messages, tools };
  }

  const cc: AnthropicCacheControl = { type: "ephemeral" };
  let outMessages = [...messages];
  let outTools = tools ? [...tools] : undefined;

  // Breakpoint 1: system prompt
  // The system message is the stable base shared across all agents using the
  // same instructions.  Caching it here means any subsequent agent sending the
  // same system prompt prefix will get a cache hit from OpenRouter.
  if (outMessages.length > 0 && outMessages[0].role === "system") {
    outMessages[0] = withCacheControl(outMessages[0], cc) as typeof outMessages[0];
  }

  // Breakpoint 2: last tool definition
  if (outTools && outTools.length > 0) {
    const lastTool = outTools[outTools.length - 1];
    outTools = [
      ...outTools.slice(0, -1),
      { ...lastTool, cache_control: cc } as ToolDefinition & { cache_control: AnthropicCacheControl },
    ];
  }

  // Breakpoint 3: last prior-turn message (message just before the new user turn)
  // The new user turn is the last message in the array.  The message before it
  // is the end of the stable history from the previous turn.
  if (outMessages.length >= 2) {
    const priorIdx = outMessages.length - 2;
    outMessages[priorIdx] = withCacheControl(outMessages[priorIdx], cc) as typeof outMessages[0];
  }

  return { messages: outMessages, tools: outTools };
}

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
  const { apiKey, model, signal, onChunk } = opts;
  const maxTokens = opts.max_tokens;

  // Apply Anthropic-specific prompt cache breakpoints when the model is
  // anthropic/*.  For all other models messages and tools are passed as-is
  // (OpenRouter handles caching automatically for non-Anthropic providers).
  const { messages, tools } = applyAnthropicCacheControl(
    model,
    opts.messages,
    opts.tools,
  );

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
  // OpenRouter preset (named server-side config)
  if (opts.preset !== undefined && opts.preset.length > 0) body.preset = opts.preset;
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
  // X-Session-Id enables sticky routing: OpenRouter sends all requests with the
  // same session ID to the same provider endpoint, maximising prompt cache hits
  // across turns within a single agent session.
  if (opts.sessionId) headers["X-Session-Id"] = opts.sessionId;

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
