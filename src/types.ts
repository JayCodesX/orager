// ── OpenAI-compatible message types ────────────────────────────────────────

export interface SystemMessage {
  role: "system";
  content: string;
}

export interface UserMessage {
  role: "user";
  content: string;
}

export interface AssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCall[];
}

export interface ToolMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

// ── Tool types ──────────────────────────────────────────────────────────────

export interface ToolParameterProperty {
  type: string;
  description?: string;
  enum?: string[];
}

export interface ToolParameterSchema {
  type: "object";
  properties: Record<string, ToolParameterProperty>;
  required?: string[];
}

export interface ToolDefinition {
  type: "function";
  /**
   * When set, overrides the name-based heuristic for tool result caching.
   * true = results may be cached; false = results are never cached.
   */
  readonly?: boolean;
  function: {
    name: string;
    description: string;
    parameters: ToolParameterSchema;
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface ToolResult {
  toolCallId: string;
  content: string;
  isError: boolean;
}

export interface ToolExecuteOptions {
  /** If set, file-path operations must resolve inside this directory. */
  sandboxRoot?: string;
}

export interface ToolExecutor {
  definition: ToolDefinition;
  /**
   * Execute the tool, or `false` to delegate execution to the caller via
   * `AgentLoopOptions.onToolCall`. Delegated tools surface the call to the
   * caller without running any local logic.
   */
  execute: ((input: Record<string, unknown>, cwd: string, opts?: ToolExecuteOptions) => Promise<ToolResult>) | false;
}

// ── Session types ───────────────────────────────────────────────────────────

export interface SessionData {
  sessionId: string;
  model: string;
  messages: Message[];
  createdAt: string;
  updatedAt: string;
  turnCount: number;
  cwd: string;
  /** When true the session is skipped on resume and excluded from active use. */
  trashed?: boolean;
  /** When true the session messages have been compacted by summarization. */
  summarized?: boolean;
  /** Origin of this session. Informational only — used to diagnose concurrent access. */
  source?: "cli" | "daemon" | "mcp";
}

// ── stream-json emit types (must match what paperclip's parse.ts expects) ───

export interface EmitInitEvent {
  type: "system";
  subtype: "init";
  model: string;
  session_id: string;
}

export interface EmitAssistantTextBlock {
  type: "text";
  text: string;
}

export interface EmitAssistantThinkingBlock {
  /** Reasoning / extended-thinking content from models like DeepSeek R1. */
  type: "thinking";
  thinking: string;
}

export interface EmitAssistantToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface EmitAssistantEvent {
  type: "assistant";
  message: {
    role: "assistant";
    content: Array<
      | EmitAssistantTextBlock
      | EmitAssistantThinkingBlock
      | EmitAssistantToolUseBlock
    >;
  };
}

export interface EmitToolEvent {
  type: "tool";
  content: Array<{
    type: "tool_result";
    tool_use_id: string;
    content: string;
    is_error?: boolean;
  }>;
}

export interface EmitResultEvent {
  type: "result";
  subtype: "success" | "error_max_turns" | "error_max_cost" | "error" | "interrupted";
  result: string;
  session_id: string;
  finish_reason: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_write_tokens?: number;
  };
  total_cost_usd: number;
  /** Number of agent turns completed in this run. */
  turnCount?: number;
}

export type EmitEvent =
  | EmitInitEvent
  | EmitAssistantEvent
  | EmitToolEvent
  | EmitResultEvent;

// ── OpenRouter API types ─────────────────────────────────────────────────────

export interface OpenRouterUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** Populated when prompt caching is active. */
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
}

export interface OpenRouterDelta {
  role?: string;
  content?: string | null;
  /** Extended-thinking text (DeepSeek R1, extended thinking models, etc.). */
  reasoning?: string | null;
  /** Structured reasoning details (some providers). */
  reasoning_details?: Array<{
    type: "summary" | "encrypted" | "text";
    content?: string;
    text?: string;
  }>;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: "function";
    function?: {
      name?: string;
      arguments?: string;
    };
  }>;
}

export interface OpenRouterStreamChunk {
  id: string;
  model?: string;
  choices: Array<{
    index: number;
    delta: OpenRouterDelta;
    finish_reason: string | null;
  }>;
  usage?: OpenRouterUsage;
  /** Top-level error object for mid-stream errors (still arrives as HTTP 200). */
  error?: {
    code?: number | string;
    message?: string;
  };
}

// ── Provider routing ─────────────────────────────────────────────────────────

export interface OpenRouterProviderRouting {
  /** Preferred provider slug order, e.g. ["DeepSeek", "Together"]. */
  order?: string[];
  /** Allow fallback to other providers if preferred unavailable (default true). */
  allow_fallbacks?: boolean;
  /** Only route to providers that support every requested parameter. */
  require_parameters?: boolean;
  /** Filter providers by data retention policy. */
  data_collection?: "allow" | "deny";
  /** Restrict to Zero Data Retention providers only. */
  zdr?: boolean;
  /** Allowlist of provider slugs for this request. */
  only?: string[];
  /** Blocklist of provider slugs for this request. */
  ignore?: string[];
  /** Filter by quantization level: int4, int8, fp4, fp6, fp8, fp16, bf16, fp32. */
  quantizations?: string[];
  /** Sort strategy: "price" (cheapest), "throughput" (fastest tokens/s), "latency" (lowest TTFT). */
  sort?: "price" | "throughput" | "latency";
  /** Minimum tokens/second threshold. */
  preferred_min_throughput?: number;
  /** Maximum time-to-first-token in seconds. */
  preferred_max_latency?: number;
  /** Price ceiling per million tokens. */
  max_price?: { prompt?: number; completion?: number };
}

// ── Reasoning config ─────────────────────────────────────────────────────────

export interface OpenRouterReasoningConfig {
  /** Reasoning intensity: "xhigh"≈95%, "high"≈80%, "medium"≈50%, "low"≈20%, "minimal"≈10% of max_tokens. */
  effort?: "xhigh" | "high" | "medium" | "low" | "minimal" | "none";
  /** Exact token budget for reasoning (Anthropic, Gemini, Alibaba). */
  max_tokens?: number;
  /** Run reasoning internally but omit from response. */
  exclude?: boolean;
  /** Enable reasoning with default parameters (medium effort). */
  enabled?: boolean;
}

// ── Response format ──────────────────────────────────────────────────────────

export interface OpenRouterResponseFormat {
  type: "json_object" | "json_schema" | "text";
  json_schema?: Record<string, unknown>;
}

// ── Anthropic prompt cache control ──────────────────────────────────────────

/**
 * Anthropic cache_control block attached to message content or tool definitions
 * to mark cache breakpoints. OpenRouter passes this through to Anthropic when
 * the model is anthropic/*.  Other providers silently ignore it.
 */
export interface AnthropicCacheControl {
  type: "ephemeral";
}

// ── OpenRouter call options (all supported parameters) ───────────────────────

export interface OpenRouterCallOptions {
  // Auth & routing
  apiKey: string;
  model: string;
  /** Sent as HTTP-Referer to identify your app to OpenRouter (shown in dashboards). */
  siteUrl?: string;
  /** Sent as X-Title to display your app name in OpenRouter dashboards. */
  siteName?: string;
  /**
   * Session ID used for X-Session-Id header — enables sticky routing on
   * OpenRouter so requests in the same session land on the same provider
   * endpoint, maximising prompt cache hit rates.
   */
  sessionId?: string;
  /** Ordered fallback model list; tried in sequence if primary fails. */
  models?: string[];
  messages: Message[];
  tools?: ToolDefinition[];

  // Sampling
  temperature?: number;
  top_p?: number;
  top_k?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  /** OpenRouter-specific: penalise all repetition (0–2, default 1). */
  repetition_penalty?: number;
  /** OpenRouter-specific: minimum token probability relative to top token. */
  min_p?: number;
  /** OpenRouter-specific: dynamic token filtering. */
  top_a?: number;
  seed?: number;
  max_tokens?: number;
  stop?: string[];
  logit_bias?: Record<string, number>;
  logprobs?: boolean;
  top_logprobs?: number;

  // Tool control
  tool_choice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  parallel_tool_calls?: boolean;

  // Reasoning (DeepSeek R1, extended thinking models, OpenAI o-series, etc.)
  reasoning?: OpenRouterReasoningConfig;

  // Output format
  response_format?: OpenRouterResponseFormat;
  structured_outputs?: boolean;

  // Provider routing
  provider?: OpenRouterProviderRouting;

  // OpenRouter preset slug (named server-side config for routing/model settings)
  preset?: string;

  // Context management
  /** ["middle-out"] compresses long conversations to fit context window. */
  transforms?: string[];

  // Plugins (e.g. response-healing)
  plugins?: Array<{ id: string; enabled?: boolean }>;

  // Infrastructure
  signal?: AbortSignal;
  onChunk?: (chunk: OpenRouterStreamChunk) => void;
}

// ── OpenRouter call result ───────────────────────────────────────────────────

export interface OpenRouterCallResult {
  content: string;
  /** Reasoning / thinking text (empty string if model did not reason). */
  reasoning: string;
  toolCalls: ToolCall[];
  usage: OpenRouterUsage;
  /** Tokens served from prompt cache (0 if no cache hit). */
  cachedTokens: number;
  /** Tokens written to the prompt cache this request (0 when no new cache entry was created). */
  cacheWriteTokens: number;
  model: string;
  finishReason: string | null;
  /** True when OpenRouter returned a mid-stream error chunk. */
  isError: boolean;
  errorMessage?: string;
}

// ── Dynamic turn context ─────────────────────────────────────────────────────

/** Snapshot of loop state passed to `AgentLoopOptions.onTurnStart` each turn. */
export interface TurnContext {
  /** Zero-indexed turn number within this run. */
  turn: number;
  /** The model name used for the loop (may differ from response model). */
  model: string;
  /** Cumulative token counts across all completed turns. */
  cumulativeTokens: { prompt: number; completion: number; total: number };
  /** Cumulative cost so far in USD (0 when no pricing is configured). */
  cumulativeCostUsd: number;
  /** Current message history (read-only snapshot). */
  messages: Message[];
}

/** Per-turn overrides that `onTurnStart` may return to adjust the API call. */
export interface TurnCallOverrides {
  model?: string;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  reasoning?: OpenRouterReasoningConfig;
}

// ── CLI options ──────────────────────────────────────────────────────────────

export interface CliOptions {
  model: string;
  /** Ordered fallback models (--model-fallback, repeatable). */
  models: string[];
  sessionId: string | null;
  addDirs: string[];
  maxTurns: number;
  maxRetries: number;
  forceResume: boolean;
  dangerouslySkipPermissions: boolean;
  verbose: boolean;
  outputFormat: "stream-json" | "text";
  /** Restrict file-path tools to this directory subtree. */
  sandboxRoot?: string;
  /** Paths to JSON tool-spec files to load as extra tools. */
  toolsFiles: string[];
  /** Require human approval before running any tool ("all") or specific tools. */
  requireApproval?: string[] | "all";
  /** Include the built-in finish tool so the model can explicitly signal completion. */
  useFinishTool?: boolean;
  /** Stop the loop when cumulative cost exceeds this amount (USD). */
  maxCostUsd?: number;
  /** Cost per input token in USD (used to track total_cost_usd). */
  costPerInputToken?: number;
  /** Cost per output token in USD (used to track total_cost_usd). */
  costPerOutputToken?: number;
  /** Sent as HTTP-Referer to identify your app to OpenRouter. */
  siteUrl?: string;
  /** Sent as X-Title to display your app name in OpenRouter dashboards. */
  siteName?: string;

  // Sampling
  temperature?: number;
  top_p?: number;
  top_k?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  repetition_penalty?: number;
  min_p?: number;
  seed?: number;
  stop?: string[];

  // Tool control
  tool_choice?: "auto" | "none" | "required";
  parallel_tool_calls?: boolean;

  // Reasoning
  reasoningEffort?: "xhigh" | "high" | "medium" | "low" | "minimal" | "none";
  reasoningMaxTokens?: number;
  reasoningExclude?: boolean;

  // Provider routing
  providerOrder?: string[];
  providerIgnore?: string[];
  providerOnly?: string[];
  dataCollection?: "allow" | "deny";
  zdr?: boolean;
  sort?: "price" | "throughput" | "latency";
  quantizations?: string[];
  require_parameters?: boolean;

  // OpenRouter preset slug (named server-side config for routing/model settings)
  preset?: string;

  // Context
  transforms?: string[];

  /** Path to a file whose contents are appended to the system prompt. */
  systemPromptFile?: string;

  /** Fraction of context window at which to trigger summarization (0–1). */
  summarizeAt?: number;
  /** Model to use for summarization. */
  summarizeModel?: string;
}

// ── Agent loop options ───────────────────────────────────────────────────────

export interface AgentLoopOptions {
  prompt: string;
  model: string;
  models?: string[];
  apiKey: string;
  sessionId: string | null;
  addDirs: string[];
  /** Maximum agent turns. Set to 0 for unlimited. */
  maxTurns: number;
  /** How many times to retry a failed OpenRouter call before giving up (default 3). */
  maxRetries?: number;
  /** Resume the session even if its stored cwd doesn't match the current cwd. */
  forceResume?: boolean;
  cwd: string;
  dangerouslySkipPermissions: boolean;
  verbose: boolean;
  onEmit: (event: EmitEvent) => void;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => void;
  /** Restrict file-path tools to this directory subtree. */
  sandboxRoot?: string;
  /** Additional tool executors beyond the built-in set. */
  extraTools?: ToolExecutor[];
  /** Require approval before executing a tool.  "all" covers every tool; an array limits to named tools. */
  requireApproval?: string[] | "all";
  /** Override the approval prompt (injectable for tests; defaults to /dev/tty prompt). */
  onApprovalRequest?: (toolName: string, input: Record<string, unknown>) => Promise<boolean>;
  /** Called when a delegated tool (execute: false) is invoked. Return the result string, or null to signal failure. */
  onToolCall?: (toolName: string, input: Record<string, unknown>) => Promise<string | null>;
  /** Called before each API turn; return overrides to dynamically adjust model/sampling params. */
  onTurnStart?: (ctx: TurnContext) => TurnCallOverrides | void;
  /** Include the built-in finish tool so the model can explicitly signal completion. */
  useFinishTool?: boolean;
  /** Stop the loop when cumulative cost exceeds this amount (USD). */
  maxCostUsd?: number;
  /** Cost per input token in USD (used to track total_cost_usd). */
  costPerInputToken?: number;
  /** Cost per output token in USD (used to track total_cost_usd). */
  costPerOutputToken?: number;
  /** Sent as HTTP-Referer to identify your app to OpenRouter. */
  siteUrl?: string;
  /** Sent as X-Title to display your app name in OpenRouter dashboards. */
  siteName?: string;

  // Sampling
  temperature?: number;
  top_p?: number;
  top_k?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  repetition_penalty?: number;
  min_p?: number;
  seed?: number;
  stop?: string[];

  // Tool control
  tool_choice?: "auto" | "none" | "required";
  parallel_tool_calls?: boolean;

  // Reasoning
  reasoning?: OpenRouterReasoningConfig;

  // Provider routing
  provider?: OpenRouterProviderRouting;

  // OpenRouter preset slug (named server-side config for routing/model settings)
  preset?: string;

  // Context
  transforms?: string[];

  /** Extra text appended to the system prompt (e.g. agent instructions). */
  appendSystemPrompt?: string;

  /** Fraction of context window at which to trigger summarization (default 0.8) */
  summarizeAt?: number;
  /** Model to use for summarization (defaults to opts.model) */
  summarizeModel?: string;
}

// ── Permission types ─────────────────────────────────────────────────────────

export type PermissionLevel = "allow" | "deny" | "ask";

export interface PermissionRequest {
  toolName: string;
  description: string;
  details: string;
}
