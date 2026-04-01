// ── OpenAI-compatible message types ────────────────────────────────────────

export interface SystemMessage {
  role: "system";
  content: string;
}

export interface UserMessageContentText {
  type: "text";
  text: string;
}

export interface UserMessageContentImageUrl {
  type: "image_url";
  image_url: { url: string; detail?: "auto" | "low" | "high" };
}

export type UserMessageContentBlock = UserMessageContentText | UserMessageContentImageUrl;

export interface UserMessage {
  role: "user";
  content: string | UserMessageContentBlock[];
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
  /** For array types: schema of each item. */
  items?: ToolParameterProperty | { type: string; properties?: Record<string, ToolParameterProperty>; required?: string[] };
  /** For object types: nested property definitions. */
  properties?: Record<string, ToolParameterProperty>;
  required?: string[];
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
  /** Optional image URL to include alongside the text result. */
  imageUrl?: string;
}

export interface ToolExecuteOptions {
  /** If set, file-path operations must resolve inside this directory. */
  sandboxRoot?: string;
  bashPolicy?: BashPolicy;
  /**
   * Current agent session ID. Passed to stateful tools (e.g., browser) so
   * multiple concurrent daemon runs maintain independent state.
   */
  sessionId?: string;
  /**
   * Per-run environment variables to inject into bash subprocesses.
   * Merged on top of process.env (or the bash-policy-filtered env).
   * Used by the daemon path to forward Paperclip context vars
   * (PAPERCLIP_API_KEY, PAPERCLIP_API_URL, etc.) that were set in the
   * adapter's spawn-path env but are not present in the daemon process env.
   */
  additionalEnv?: Record<string, string>;
  [key: string]: unknown;
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

export interface SessionSummary {
  sessionId: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
  cwd: string;
  trashed: boolean;
}

export interface PruneResult {
  deleted: number;
  kept: number;
  errors: number;
}

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
  /**
   * ISO timestamp of when this session was last compacted (in-place).
   * Only present when summarized === true.
   */
  compactedAt?: string;
  /**
   * Full audit trail of all in-place compactions for this session.
   * Each entry records when compaction occurred and the turn count at that time.
   * Appended to on every compaction, so the full history is preserved.
   */
  compactionHistory?: Array<{ compactedAt: string; previousTurnCount: number }>;
  /**
   * Set when this session was created by forking and compacting another session.
   * Stores the source session ID for audit lineage.
   * Not set for in-place compaction (where the session ID doesn't change).
   */
  compactedFrom?: string;
  /** Origin of this session. Informational only — used to diagnose concurrent access. */
  source?: "cli" | "daemon" | "mcp";
  /** Schema version for forward-compatible migrations. Always written as CURRENT_SESSION_SCHEMA_VERSION. */
  schemaVersion?: number;
  /**
   * Cumulative API cost (USD) across all runs for this session.
   * Incremented at loop teardown so that maxCostUsd is enforced against the
   * full session total rather than resetting to $0 on every resume.
   * Missing in older sessions — defaults to 0 for backward compatibility.
   */
  cumulativeCostUsd?: number;
  /**
   * Set when the run ended early to ask for approval.
   * Cleared when the session is resumed and the approval is resolved.
   */
  pendingApproval?: {
    toolCallId: string;
    toolName: string;
    input: Record<string, unknown>;
    /** The full assistant message from the turn that triggered approval. Needed to re-inject on resume. */
    assistantMessage: AssistantMessage;
    /** All tool calls from that assistant turn. */
    toolCalls: ToolCall[];
    /** ISO timestamp when the approval question was posed — used to log elapsed wait time on resume. */
    questionedAt?: string;
  } | null;
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
  /**
   * True when text/thinking content was already emitted as text_delta /
   * thinking_delta events. Consumers should skip re-rendering text blocks
   * to avoid duplicating streamed content in the UI.
   */
  streamed?: boolean;
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
    image_url?: string;
  }>;
}

/** Per-tool execution metrics for a single run. */
export interface ToolMetric {
  /** Total number of times this tool was invoked. */
  calls: number;
  /** Number of invocations that returned isError: true. */
  errors: number;
  /** Total wall-clock milliseconds spent executing this tool. */
  totalMs: number;
}

export interface EmitResultEvent {
  type: "result";
  subtype: "success" | "error_max_turns" | "error_max_cost" | "error" | "error_circuit_open" | "interrupted" | "error_cancelled" | "error_tool_budget" | "error_loop_abort";
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
  /**
   * Per-category cost breakdown (USD). Only populated when per-token pricing
   * is available (live model metadata or caller-supplied costPerInputToken /
   * costPerOutputToken). Absent when no pricing data is configured.
   */
  cost_breakdown?: {
    /** Cost attributable to input (prompt) tokens. */
    input_usd: number;
    /** Cost attributable to output (completion) tokens. */
    output_usd: number;
  };
  /** Number of agent turns completed in this run. */
  turnCount?: number;
  /** Per-tool call counts, error counts, and total execution time for this run. */
  toolMetrics?: Record<string, ToolMetric>;
  filesChanged?: string[];
}

export interface EmitQuestionEvent {
  type: "question";
  /** Human-readable description of what needs approval. */
  prompt: string;
  /** The choices the user can pick from. */
  choices: Array<{ key: string; label: string; description?: string }>;
  /** ID of the tool call that triggered this question. */
  toolCallId: string;
  /** Name of the tool that needs approval. */
  toolName: string;
}

/**
 * Streaming text delta — emitted as each token arrives from the LLM.
 * Consumers can render these incrementally without waiting for the full
 * assistant turn to complete.
 */
export interface EmitTextDeltaEvent {
  type: "text_delta";
  delta: string;
}

/**
 * Streaming thinking/reasoning delta — emitted per chunk for models that
 * expose internal reasoning (DeepSeek R1, o1/o3 extended thinking, etc.).
 */
export interface EmitThinkingDeltaEvent {
  type: "thinking_delta";
  delta: string;
}

/**
 * Warning event emitted for non-fatal conditions during a run.
 *
 * subtypes:
 *   "dropped_opts"  — daemon-only: caller passed opts outside the allowlist
 *   "session_lost"  — session ID not found; the run continues with a fresh session
 */
export interface EmitWarnEvent {
  type: "warn";
  /** Discriminator for the warning condition. */
  subtype?: "dropped_opts" | "session_lost";
  message: string;
  /** Present when subtype is "dropped_opts". */
  dropped_opts?: string[];
  /** Present when subtype is "session_lost". */
  session_id?: string;
}

export type EmitEvent =
  | EmitInitEvent
  | EmitAssistantEvent
  | EmitToolEvent
  | EmitResultEvent
  | EmitQuestionEvent
  | EmitTextDeltaEvent
  | EmitThinkingDeltaEvent
  | EmitWarnEvent;

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
  /**
   * Allowlist of provider slugs for this request.
   * @deprecated The OpenRouter API may use `allow` instead of `only` — check current docs.
   * Use `allow` for forward compatibility.
   */
  only?: string[];
  /** Allowlist of provider slugs for this request (preferred over `only`). */
  allow?: string[];
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
  max_completion_tokens?: number;
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

  /** When true, explicitly disables OpenRouter's server-side context compression plugin.
   * Should be set when the caller handles summarization itself. */
  disableContextCompression?: boolean;

  // Infrastructure
  signal?: AbortSignal;
  onChunk?: (chunk: OpenRouterStreamChunk) => void;

  /**
   * Additional API keys to rotate through on rate-limit (429/503) errors.
   * Combined with `apiKey` to form a pool; `callWithRetry` tries the next key
   * before falling back to model rotation.
   */
  apiKeys?: string[];

  /**
   * Per-agent rate-limit tracker instance. When provided, callOpenRouter /
   * callDirect update this tracker from response headers in addition to the
   * process-global singleton. Callers (runAgentLoop) should create one per
   * agent invocation so that a 429 on one agent does not suppress requests
   * from other agents on the same daemon.
   */
  rateLimitTracker?: import("./rate-limit-tracker.js").RateLimitTracker;

  /**
   * Stable identifier for the end user / agent sent as the `user` field in
   * every OpenRouter request.  OpenRouter uses this for per-user abuse
   * detection and shows it in the dashboard.  Prefer `sessionId` as the
   * value so sessions map 1-to-1 with OpenRouter user identifiers.
   */
  user?: string;
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
  /** HTTP status code of the failed response, when isError is true. */
  httpStatus?: number;
  /** OpenRouter generation ID — used to fetch actual cost/provider from /api/v1/generation */
  generationId?: string;
}

export interface GenerationMeta {
  id: string;
  model: string;
  providerName: string;
  /** Actual USD cost charged for this generation */
  totalCost: number;
  /** Cache discount applied (USD saved) */
  cacheDiscount: number;
  nativeTokensPrompt: number;
  nativeTokensCompletion: number;
  latencyMs: number;
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

/**
 * A rule evaluated before each agent turn to dynamically switch models.
 * Rules are evaluated in order; the first matching rule wins.
 * Lower priority than an explicit `onTurnStart` override.
 */
export interface TurnModelRule {
  /** The model to switch to when this rule matches. */
  model: string;
  /** Match when turn number >= afterTurn (0-indexed). */
  afterTurn?: number;
  /** Match when cumulative cost > costAbove USD. */
  costAbove?: number;
  /** Match when cumulative prompt tokens > tokensAbove. */
  tokensAbove?: number;
  /**
   * When true, apply this rule for one turn only then stop matching it.
   * Default: false (sticky — applies every turn once matched).
   */
  once?: boolean;
}

/** Per-turn overrides that `onTurnStart` may return to adjust the API call. */
export interface TurnCallOverrides {
  model?: string;
  max_completion_tokens?: number;
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
  /** Fallback model to use when the primary model does not support vision and the prompt contains images. */
  visionModel?: string;
  /** When summarizing, keep the last N assistant turns intact and only summarize
   * the older messages. 0 or undefined = summarize everything (default behavior).
   */
  summarizeKeepRecentTurns?: number;
  /**
   * Force summarization every N turns regardless of token pressure.
   * 0 or undefined = disabled (default). Recommended: 5–7.
   * Works alongside summarizeAt — whichever trigger fires first wins.
   */
  summarizeTurnInterval?: number;
  /** Turn model routing rules (from config file). */
  turnModelRules?: TurnModelRule[];
  /** Structured prompt content for multimodal inputs (from config file). */
  promptContent?: UserMessageContentBlock[];
  /** Answer to a pending approval from a previous run. */
  approvalAnswer?: { choiceKey: string; toolCallId: string } | null;
  /** When set to "question", approval prompts emit a question event and terminate the run. */
  approvalMode?: "tty" | "question";
  /** Named agent profile preset to apply (e.g. "code-review", "bug-fix"). */
  profile?: string;
  /** Path to orager settings file (default: ~/.orager/settings.json). */
  settingsFile?: string;
  /** Resume the session even if its stored cwd doesn't match the current cwd. */
  forceResume?: boolean;
  /** MCP servers to connect to. Key is the server name (tool prefix: mcp__<name>__<tool>). */
  mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
  /**
   * MCP server names that must successfully connect before the run starts.
   * Names must match keys in `mcpServers`.
   */
  requireMcpServers?: string[];
  /**
   * Per-tool execution timeout overrides (milliseconds).
   * Key is the tool name; value is the timeout in ms.
   * Example: { "bash": 30000, "web_fetch": 20000 }
   */
  toolTimeouts?: Record<string, number>;
  /**
   * Maximum depth of nested spawn_agent calls. Default 3. Set to 0 to disable
   * subagent spawning entirely.
   */
  maxSpawnDepth?: number;
  /**
   * Maximum number of consecutive turns with identical tool-call signatures
   * before the loop injects a "you appear to be stuck" warning.
   * Default 5. Set to 0 to disable.
   */
  maxIdenticalToolCallTurns?: number;
  /**
   * When true, terminate the run immediately if any single tool exceeds the
   * consecutive-failure budget (5 consecutive errors). Default false (logs warning and resets).
   */
  toolErrorBudgetHardStop?: boolean;
  /** Run-level timeout in seconds. 0 = no timeout. */
  timeoutSec?: number;
  /** Additional API keys to rotate through on 429/503 errors. */
  apiKeys?: string[];
  /** Env var names that must be present before the loop starts. */
  requiredEnvVars?: string[];
  /** What to do when a hook exits non-zero: "ignore", "warn", or "fail". */
  hookErrorMode?: "ignore" | "warn" | "fail";
  /** Run in plan-mode: model must call exit_plan_mode before taking any actions. */
  planMode?: boolean;
  /** Inject workspace/directory context into the first user message. */
  injectContext?: boolean;
  /** Append :online suffix to model to enable web-search-augmented responses. */
  onlineSearch?: boolean;
  /** Stable agent identifier sent as the OpenRouter `user` field for attribution. */
  agentId?: string;
  /** Repository URL — used to derive memory key when memoryKey is not explicit. */
  repoUrl?: string;
  /** Load browser automation tools (Puppeteer). */
  enableBrowserTools?: boolean;
  /** Track file changes made during the run and report them in the result event. */
  trackFileChanges?: boolean;
  /** Wrap tool outputs in XML tags for cleaner context. Default true. */
  tagToolOutputs?: boolean;
  /** Enable auto-memory tools (read_memory, write_memory, list_memories). */
  autoMemory?: boolean;
}

// ── Bash policy ──────────────────────────────────────────────────────────────

/**
 * Policy controlling what the bash tool is allowed to do.
 * All restrictions are advisory — they run in-process and cannot replace
 * OS-level sandboxing, but catch common accidental misuse patterns.
 */
export interface BashPolicy {
  /**
   * Commands to block. Each entry is matched against the first word of the
   * command string (case-insensitive). Defaults to [] (no blocking).
   * Example: ["curl", "wget", "ssh", "nc", "socat"]
   */
  blockedCommands?: string[];
  /**
   * Env var key patterns to strip from the bash subprocess environment.
   * Matched case-insensitively against the key name.
   * Example: ["SSH_AUTH_SOCK", "AWS_", "GITHUB_TOKEN"]
   */
  stripEnvKeys?: string[];
  /**
   * When true, the bash subprocess only sees the keys listed in `allowedEnvKeys`
   * plus PATH, HOME, USER, SHELL, LANG, TERM, and PWD.
   * Overrides `stripEnvKeys` when set.
   */
  isolateEnv?: boolean;
  /**
   * Keys to preserve when `isolateEnv` is true. Defaults to [].
   */
  allowedEnvKeys?: string[];
  /**
   * When true, wrap bash subprocess in an OS-level sandbox (macOS sandbox-exec,
   * Linux bwrap). Requires `sandboxRoot` to be set on `AgentLoopOptions` — the
   * subprocess gets read-everywhere / write-only-to-sandboxRoot restrictions.
   * Defaults to false. Falls back gracefully to text-policy-only if the required
   * OS tool is unavailable.
   */
  osSandbox?: boolean;
  /**
   * When `osSandbox` is true, allow outbound network connections from the
   * sandbox. Default false (network blocked). Has no effect when osSandbox
   * is false.
   */
  allowNetwork?: boolean;
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
  /**
   * Soft cost limit in USD. When total cost exceeds this value the agent logs a
   * warning but continues running. Useful for alerting without hard-stopping.
   * Must be less than maxCostUsd to be meaningful.
   */
  maxCostUsdSoft?: number;
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
  /**
   * When summarizing, keep the last N assistant turns intact and only summarize
   * the older messages. 0 or undefined = summarize everything (default behavior).
   */
  summarizeKeepRecentTurns?: number;
  /**
   * Force summarization every N turns regardless of token pressure.
   * 0 or undefined = disabled (default). Recommended: 5–7.
   */
  summarizeTurnInterval?: number;
  /**
   * Custom system prompt for the summarization call.
   * Overrides the built-in SUMMARIZE_PROMPT constant.
   * Useful for domain-specific summaries (e.g. "focus on file paths modified").
   */
  summarizePrompt?: string;
  /**
   * Number of most-recent turns to keep when summarization fails completely.
   * When summarization fails and the cooldown is active, fall back to hard
   * truncation: keep the system prompt + the last N messages.
   * Set to 0 to disable fallback truncation.
   * @default 40
   */
  summarizeFallbackKeep?: number;
  /**
   * Timeout in milliseconds for TTY-mode approval prompts.
   * After this duration the prompt auto-denies. Default: 5 minutes.
   * Has no effect when approvalMode is "question".
   */
  approvalTimeoutMs?: number;
  /** Per-turn model routing rules. Evaluated before each API call; first match wins. */
  turnModelRules?: TurnModelRule[];
  /** Structured first-message content for multimodal prompts. Overrides the text `prompt` field. */
  promptContent?: UserMessageContentBlock[];
  /**
   * Fallback model to use when the primary model does not support vision and
   * the prompt contains image_url blocks. orager detects this automatically and
   * swaps models for the run. Example: "google/gemini-2.0-flash"
   */
  visionModel?: string;
  /**
   * Answer to a pending approval from a previous run.
   * When set and the session has a pendingApproval, the loop resolves
   * the approval with this answer instead of prompting.
   */
  approvalAnswer?: { choiceKey: string; toolCallId: string } | null;
  /**
   * When set to "question", approval prompts emit a question event and terminate
   * the run instead of blocking on TTY. Default: "tty".
   */
  approvalMode?: "tty" | "question";
  /**
   * Per-tool execution timeout overrides (milliseconds).
   * Key is the tool name; value is the timeout in ms.
   * Tools without an entry use no timeout (run until completion).
   * Example: { "bash": 30000, "web_fetch": 20000 }
   */
  toolTimeouts?: Record<string, number>;
  /**
   * Optional AbortSignal to cancel the agent loop mid-run.
   * When the signal fires, the current turn completes and the loop exits cleanly
   * with a "error_cancelled" result event.
   */
  abortSignal?: AbortSignal;
  /**
   * Policy restricting what the bash tool can do (command blocklist, env isolation).
   * When omitted, no bash restrictions apply.
   */
  bashPolicy?: BashPolicy;

  /**
   * Maximum depth of nested spawn_agent calls. Default 3. Set to 0 to disable
   * subagent spawning entirely.
   */
  maxSpawnDepth?: number;

  /**
   * Internal — current spawn depth. Set automatically by the spawn_agent tool.
   * Do not set this manually.
   */
  _spawnDepth?: number;

  /**
   * Features required for this run. If the selected model does not support all
   * listed features, a warning is logged but the run still proceeds.
   * Values: "vision" | "extendedThinking" | "toolUse" | "jsonMode"
   */
  requiredCapabilities?: Array<"vision" | "extendedThinking" | "toolUse" | "jsonMode">;

  /**
   * Maximum number of consecutive turns with identical tool-call signatures
   * before the loop injects a "you appear to be stuck" warning and breaks.
   * Default 5. Set to 0 to disable.
   */
  maxIdenticalToolCallTurns?: number;

  /**
   * When true, track files written or deleted during the run and include
   * them in result events as `filesChanged`. Default false.
   */
  trackFileChanges?: boolean;

  /**
   * URL to POST the result event to when the run completes (any subtype).
   * The request body is the JSON-serialized result event.
   * Failures are silently ignored.
   */
  webhookUrl?: string;

  /**
   * When set to "discord", shapes the webhook payload as a Discord embed
   * instead of the raw result event JSON.
   */
  webhookFormat?: "discord";

  /**
   * Optional HMAC-SHA256 signing secret for webhook payloads.
   * When set, every webhook POST includes an `X-Orager-Signature: sha256=<hex>`
   * header. Receivers should verify: HMAC-SHA256(secret, rawBody) === signature.
   */
  webhookSecret?: string;

  /**
   * When true, wraps each tool result in XML tags identifying the source tool.
   * Helps the model resist prompt injection attacks from malicious tool outputs.
   * Example: <tool_result name="web_fetch" url="...">content</tool_result>
   * Default: TRUE (opt out with false if you need raw tool output).
   */
  tagToolOutputs?: boolean;

  /**
   * When true, automatically gather and prepend git status, recent commits,
   * and directory context to the first user message. Default false.
   */
  injectContext?: boolean;

  /**
   * When true, terminate the run immediately if any single tool exceeds the
   * consecutive-failure budget (5 consecutive errors). Default false (logs a
   * warning and resets the counter, allowing the run to continue).
   */
  toolErrorBudgetHardStop?: boolean;

  /**
   * Run-level timeout in seconds. When > 0, the loop aborts cleanly with an
   * "error_cancelled" result event after this many seconds. Composed with
   * `abortSignal` when both are provided.  0 or omitted = no timeout.
   */
  timeoutSec?: number;

  /**
   * Additional API keys to rotate through on rate-limit (429/503) errors.
   * Combined with `apiKey` to form a pool; `callWithRetry` rotates the key
   * on the first 429 before escalating to model rotation.
   */
  apiKeys?: string[];

  /**
   * Environment variable names that must be present and non-empty in
   * `process.env` before the loop starts. Emits an error result immediately
   * if any are missing — useful for fail-fast validation when specific tools
   * need env vars (e.g. GITHUB_TOKEN for GitHub MCP).
   */
  requiredEnvVars?: string[];

  /**
   * Internal: list of ancestor session IDs for spawn-cycle detection.
   * Set automatically when spawning sub-agents; do not set manually.
   */
  _parentSessionIds?: string[];

  /**
   * When true (default), reads CLAUDE.md and ORAGER.md from the cwd hierarchy
   * and injects them into the system prompt.
   */
  readProjectInstructions?: boolean;

  /**
   * MCP servers to connect to. Key is the server name (used as tool prefix mcp__<name>__<tool>).
   *
   * Each value is either a stdio config `{ command, args?, env? }` (spawns a subprocess)
   * or an HTTP config `{ url, headers? }` (connects to a running Streamable HTTP+SSE server).
   */
  mcpServers?: Record<string, import("./mcp-client.js").McpServerConfig>;

  /**
   * MCP server names that must successfully connect before the run starts.
   * If any named server fails to connect, the run emits an error result immediately.
   * Names must match keys in `mcpServers`.
   */
  requireMcpServers?: string[];

  /**
   * Hooks to run on lifecycle events and tool calls.
   * Each hook target can be a shell command string, an HTTP URL object
   * `{ url: string; format?: "discord" }`, or an array of both.
   *
   * Supported events: PreToolCall, PostToolCall, SessionStart, SessionStop,
   * PreLLMRequest, PostLLMResponse, Stop, ToolDenied, ToolTimeout, MaxTurnsReached.
   */
  hooks?: import("./hooks.js").HookConfig;

  /**
   * Timeout in milliseconds for each hook invocation. Default: 10 000.
   * Individual hooks that exceed this are killed and treated as failures.
   */
  hookTimeoutMs?: number;

  /**
   * What to do when a hook exits non-zero or times out.
   * - "ignore" — silently discard the failure (default)
   * - "warn"   — emit a warning to stderr and continue
   * - "fail"   — terminate the run with an error result
   */
  hookErrorMode?: "ignore" | "warn" | "fail";

  /** Path to orager settings file (default: ~/.orager/settings.json). */
  settingsFile?: string;

  /**
   * Named agent profile preset to apply (e.g. "code-review", "bug-fix", "research").
   * Profile defaults are applied before the run starts; caller opts always win.
   * Built-in profiles: code-review, bug-fix, research, refactor, test-writer, devops.
   * Custom profiles can be defined in ~/.orager/profiles/<name>.yaml.
   */
  profile?: string;

  /**
   * When true, starts the loop in plan mode: only readonly tools are available
   * until the model calls exit_plan_mode. Default false.
   */
  planMode?: boolean;

  /**
   * Requested response format. When set to `{ type: "json_object" }`, the loop
   * will attempt to parse the assistant's text response as JSON and, if parsing
   * fails, inject a one-shot healing message asking the model to retry with
   * valid JSON. Healing is capped at one attempt per run.
   */
  response_format?: OpenRouterResponseFormat;

  /**
   * When true, add the browser automation tools (browser_navigate,
   * browser_screenshot, browser_click, browser_type, browser_key,
   * browser_scroll, browser_close) to the agent's tool set.
   *
   * Requires the `playwright` package and Chromium to be installed:
   *   npm install playwright && npx playwright install chromium
   *
   * Default: false (browser tools are not loaded unless explicitly enabled).
   */
  enableBrowserTools?: boolean;

  /**
   * Enable or disable cross-session persistent memory. When true (default),
   * the `remember` tool is available and the memory block is injected into
   * the system prompt at startup. Set to false to fully disable memory.
   */
  memory?: boolean;

  /**
   * Stable key used to identify the memory store for this agent.
   * Typically the Paperclip agent ID (passed by the adapter) so memories
   * persist across session resets. Falls back to a hash of the cwd for
   * standalone use. Sanitized to [a-zA-Z0-9_-], max 128 chars.
   */
  memoryKey?: string;

  /**
   * Repository URL — used to derive memory key when memoryKey is not explicit.
   * Produces a stable key based on agent ID + repo slug, which survives workspace
   * path changes (unlike CWD-based keying). Ignored when memoryKey is set.
   */
  repoUrl?: string;

  /**
   * Maximum characters injected into the system prompt from the memory store.
   * Entries are sorted by importance (high first) and truncated at this limit
   * to avoid crowding out the task context. Default: 6000 (~1500 tokens).
   */
  memoryMaxChars?: number;

  /**
   * Minimum entry count before switching from inject-all to scored retrieval.
   * Default: 15. Set to 0 to always score; Infinity to always inject all.
   */
  memoryRetrievalThreshold?: number;

  /**
   * "local" = Phase 1 term overlap (default)
   * "embedding" = Phase 2 cosine similarity with cached embeddings
   */
  memoryRetrieval?: "local" | "fts" | "embedding";

  /**
   * OpenRouter embedding model to use. Example: "openai/text-embedding-3-small"
   * Required when memoryRetrieval === "embedding". Ignored otherwise.
   */
  memoryEmbeddingModel?: string;

  /**
   * Per-agent API key override. When set, this agent uses its own
   * key instead of the global PROTOCOL_API_KEY. Isolates rate limits so one
   * agent's 429 cannot starve others.
   */
  agentApiKey?: string;

  /**
   * Maximum total wait time (ms) when retrying to acquire the session lock.
   * If the lock is still held after this duration, the run fails with a
   * descriptive error. Default: 5000 ms.
   */
  sessionLockTimeoutMs?: number;

  /**
   * Stable identifier for this agent sent as the `user` field on every
   * OpenRouter request.  OpenRouter uses it for per-user abuse detection and
   * dashboard attribution.  Defaults to the session ID when not set.
   */
  agentId?: string;

  /**
   * When true, appends `:online` to the model string so OpenRouter routes the
   * request to a web-search-enabled variant of the model (e.g.
   * "openai/gpt-4o" → "openai/gpt-4o:online").  Has no effect if the model
   * already ends with a suffix like `:online`, `:nitro`, or `:thinking`.
   */
  onlineSearch?: boolean;

  /**
   * When true, enables auto-memory: the agent gains `write_memory` and
   * `read_memory` tools that persist notes to CLAUDE.md (project-scoped) or
   * ~/.orager/MEMORY.md (global-scoped) across sessions.
   *
   * At session start, the project CLAUDE.md and global MEMORY.md are injected
   * into the system prompt so the agent can reference past notes without an
   * explicit read_memory call.
   *
   * This is distinct from the structured `memory` (MemoryStore/remember-tool)
   * system — auto-memory stores plain markdown, making notes human-readable and
   * version-control-friendly.
   *
   * Default: false.
   */
  autoMemory?: boolean;

  /**
   * Per-run environment variables injected into bash subprocesses.
   * Merged on top of process.env (or the bash-policy-filtered env) so the
   * agent can access platform context like PAPERCLIP_API_KEY, PAPERCLIP_API_URL,
   * PAPERCLIP_TASK_ID, etc. when running inside the daemon (which otherwise
   * only has its own startup env).
   * These are NOT set on process.env — they are only passed to subprocess spawns.
   */
  env?: Record<string, string>;
}

// ── Permission types ─────────────────────────────────────────────────────────

export type PermissionLevel = "allow" | "deny" | "ask";

export interface PermissionRequest {
  toolName: string;
  description: string;
  details: string;
}
