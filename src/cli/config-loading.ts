import process from "node:process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// ── Config file schema ────────────────────────────────────────────────────────
// When --config-file <path> is passed (e.g. from the paperclip adapter),
// read the JSON config, delete the file immediately (it may contain secrets),
// then inject the decoded options into argv so the rest of parseArgs works
// without modification. The file is chmod 600 by the writer; we delete it
// before doing anything else to minimise the window where it is readable.

export interface ConfigFileSchema {
  model?: string;
  models?: string[];
  maxTurns?: number;
  maxRetries?: number;
  sessionId?: string;
  addDirs?: string[];
  dangerouslySkipPermissions?: boolean;
  sandboxRoot?: string;
  useFinishTool?: boolean;
  siteUrl?: string;
  siteName?: string;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  repetition_penalty?: number;
  min_p?: number;
  seed?: number;
  stop?: string[];
  tool_choice?: string;
  parallel_tool_calls?: boolean;
  reasoningEffort?: string;
  reasoningMaxTokens?: number;
  reasoningExclude?: boolean;
  providerOrder?: string[];
  providerIgnore?: string[];
  providerOnly?: string[];
  dataCollection?: string;
  zdr?: boolean;
  sort?: string;
  quantizations?: string[];
  require_parameters?: boolean;
  preset?: string;
  transforms?: string[];
  maxCostUsd?: number;
  costPerInputToken?: number;
  costPerOutputToken?: number;
  /** "all" or list of tool names — replaces old boolean requireApproval + requireApprovalFor */
  requireApproval?: "all" | string[];
  toolsFiles?: string[];
  systemPromptFile?: string;
  outputFormat?: string;
  summarizeAt?: number;
  summarizeModel?: string;
  summarizeKeepRecentTurns?: number;
  turnModelRules?: unknown[]; // TurnModelRule[] — kept as unknown[] to avoid circular import
  promptContent?: unknown[]; // UserMessageContentBlock[]
  approvalAnswer?: { choiceKey: string; toolCallId: string } | null;
  approvalMode?: "tty" | "question";
  profile?: string;
  settingsFile?: string;
  forceResume?: boolean;
  /** MCP servers — complex object, passed via globalThis not argv */
  mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
  requireMcpServers?: string[];
  toolTimeouts?: Record<string, number>;
  maxSpawnDepth?: number;
  maxIdenticalToolCallTurns?: number;
  toolErrorBudgetHardStop?: boolean;
  /** Response format for JSON healing — complex object, passed via globalThis not argv */
  response_format?: { type: string; json_schema?: Record<string, unknown> };
  /** Shell hooks for lifecycle events — complex object, passed via globalThis not argv */
  hooks?: Record<string, string>;
  planMode?: boolean;
  injectContext?: boolean;
  tagToolOutputs?: boolean;
  readProjectInstructions?: boolean;
  summarizePrompt?: string;
  summarizeFallbackKeep?: number;
  webhookUrl?: string;
  webhookFormat?: "discord";
  webhookSecret?: string;
  /** Bash policy — complex object, passed via globalThis not argv */
  bashPolicy?: Record<string, unknown>;
  trackFileChanges?: boolean;
  enableBrowserTools?: boolean;
  maxCostUsdSoft?: number;
  approvalTimeoutMs?: number;
  hookTimeoutMs?: number;
  hookErrorMode?: "ignore" | "warn" | "fail";
  /** Run-level timeout in seconds. 0 = no timeout. */
  timeoutSec?: number;
  /** Additional API keys to rotate through on 429/503 errors. */
  apiKeys?: string[];
  /** Env var names that must be present before the loop starts. */
  requiredEnvVars?: string[];
  /** Enable or disable cross-session persistent memory (default true). */
  memory?: boolean;
  /** Stable key for the agent's memory store (e.g. Paperclip agent ID). */
  memoryKey?: string;
  /** Max chars injected from memory into the system prompt (default 6000). */
  memoryMaxChars?: number;
  /** Daemon default port (applied when --serve is used). */
  daemonPort?: number;
  /** Daemon max concurrent runs (applied when --serve is used). */
  daemonMaxConcurrent?: number;
  /** Daemon idle-shutdown timeout string, e.g. "30m" or "1h" (applied when --serve is used). */
  daemonIdleTimeout?: string;
  /** Per-agent OpenRouter API key override — isolates rate limits from the global key. */
  agentApiKey?: string;
  /** Memory retrieval mode: "local" (default FTS) or "embedding" (cosine similarity). */
  memoryRetrieval?: "local" | "embedding";
  /** OpenRouter embedding model for memoryRetrieval === "embedding". */
  memoryEmbeddingModel?: string;
  /**
   * Fallback model to use when the primary model does not support vision and
   * the prompt contains image attachments. orager auto-detects this and swaps
   * models for the run. Example: "google/gemini-2.0-flash"
   */
  visionModel?: string;
}

export type LoadConfigFileResult = {
  args: string[];
  turnModelRules?: unknown[];
  promptContent?: unknown[];
  approvalAnswer?: { choiceKey: string; toolCallId: string } | null;
  approvalMode?: "tty" | "question";
  mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
  requireMcpServers?: string[];
  toolTimeouts?: Record<string, number>;
  maxSpawnDepth?: number;
  maxIdenticalToolCallTurns?: number;
  toolErrorBudgetHardStop?: boolean;
  response_format?: { type: string; json_schema?: Record<string, unknown> };
  hooks?: Record<string, string>;
  planMode?: boolean;
  injectContext?: boolean;
  tagToolOutputs?: boolean;
  readProjectInstructions?: boolean;
  summarizePrompt?: string;
  summarizeFallbackKeep?: number;
  webhookUrl?: string;
  webhookFormat?: "discord";
  webhookSecret?: string;
  bashPolicy?: Record<string, unknown>;
  trackFileChanges?: boolean;
  enableBrowserTools?: boolean;
  maxCostUsdSoft?: number;
  approvalTimeoutMs?: number;
  hookTimeoutMs?: number;
  hookErrorMode?: "ignore" | "warn" | "fail";
  timeoutSec?: number;
  apiKeys?: string[];
  requiredEnvVars?: string[];
  memory?: boolean;
  memoryKey?: string;
  memoryMaxChars?: number;
  agentApiKey?: string;
  memoryRetrieval?: "local" | "embedding";
  memoryEmbeddingModel?: string;
};

/**
 * Read the config file at `filePath`, delete it immediately, and return
 * an argv fragment equivalent to the flags the config represents.
 */
export async function loadConfigFile(filePath: string): Promise<LoadConfigFileResult> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    throw new Error(`Cannot read --config-file "${filePath}": ${err instanceof Error ? err.message : String(err)}`);
  }

  // Delete immediately — the file may contain secrets (API keys via env, etc.)
  // Best-effort: a deletion failure is not fatal but is logged.
  try {
    await fs.unlink(filePath);
  } catch (err) {
    process.stderr.write(`[orager] warning: could not delete config file "${filePath}": ${err instanceof Error ? err.message : String(err)}\n`);
  }

  let cfg: ConfigFileSchema;
  try {
    cfg = JSON.parse(raw) as ConfigFileSchema;
  } catch (err) {
    throw new Error(`--config-file contains invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Convert config object back to argv tokens so parseArgs handles it uniformly
  const args: string[] = [];

  if (cfg.model) args.push("--model", cfg.model);
  if (Array.isArray(cfg.models)) {
    for (const m of cfg.models) args.push("--model-fallback", m);
  }
  if (cfg.maxTurns !== undefined) args.push("--max-turns", String(cfg.maxTurns));
  if (cfg.maxRetries !== undefined) args.push("--max-retries", String(cfg.maxRetries));
  if (cfg.sessionId) args.push("--resume", cfg.sessionId);
  if (Array.isArray(cfg.addDirs)) {
    for (const d of cfg.addDirs) args.push("--add-dir", d);
  }
  if (cfg.dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
  if (cfg.sandboxRoot) args.push("--sandbox-root", cfg.sandboxRoot);
  if (cfg.useFinishTool) args.push("--use-finish-tool");
  if (cfg.siteUrl) args.push("--site-url", cfg.siteUrl);
  if (cfg.siteName) args.push("--site-name", cfg.siteName);
  if (cfg.temperature !== undefined) args.push("--temperature", String(cfg.temperature));
  if (cfg.top_p !== undefined) args.push("--top-p", String(cfg.top_p));
  if (cfg.top_k !== undefined) args.push("--top-k", String(cfg.top_k));
  if (cfg.frequency_penalty !== undefined) args.push("--frequency-penalty", String(cfg.frequency_penalty));
  if (cfg.presence_penalty !== undefined) args.push("--presence-penalty", String(cfg.presence_penalty));
  if (cfg.repetition_penalty !== undefined) args.push("--repetition-penalty", String(cfg.repetition_penalty));
  if (cfg.min_p !== undefined) args.push("--min-p", String(cfg.min_p));
  if (cfg.seed !== undefined) args.push("--seed", String(cfg.seed));
  if (Array.isArray(cfg.stop)) {
    for (const s of cfg.stop) args.push("--stop", s);
  }
  if (cfg.tool_choice) args.push("--tool-choice", cfg.tool_choice);
  if (cfg.parallel_tool_calls === true) args.push("--parallel-tool-calls");
  if (cfg.parallel_tool_calls === false) args.push("--no-parallel-tool-calls");
  if (cfg.reasoningEffort) args.push("--reasoning-effort", cfg.reasoningEffort);
  if (cfg.reasoningMaxTokens !== undefined) args.push("--reasoning-max-tokens", String(cfg.reasoningMaxTokens));
  if (cfg.reasoningExclude) args.push("--reasoning-exclude");
  if (Array.isArray(cfg.providerOrder) && cfg.providerOrder.length > 0)
    args.push("--provider-order", cfg.providerOrder.join(","));
  if (Array.isArray(cfg.providerIgnore) && cfg.providerIgnore.length > 0)
    args.push("--provider-ignore", cfg.providerIgnore.join(","));
  if (Array.isArray(cfg.providerOnly) && cfg.providerOnly.length > 0)
    args.push("--provider-only", cfg.providerOnly.join(","));
  if (cfg.dataCollection) args.push("--data-collection", cfg.dataCollection);
  if (cfg.zdr) args.push("--zdr");
  if (cfg.sort) args.push("--sort", cfg.sort);
  if (Array.isArray(cfg.quantizations) && cfg.quantizations.length > 0)
    args.push("--quantizations", cfg.quantizations.join(","));
  if (cfg.require_parameters) args.push("--require-parameters");
  if (cfg.preset) args.push("--preset", cfg.preset);
  if (Array.isArray(cfg.transforms) && cfg.transforms.length > 0)
    args.push("--transforms", cfg.transforms.join(","));
  if (cfg.maxCostUsd !== undefined) args.push("--max-cost-usd", String(cfg.maxCostUsd));
  if (cfg.costPerInputToken !== undefined) args.push("--cost-per-input-token", String(cfg.costPerInputToken));
  if (cfg.costPerOutputToken !== undefined) args.push("--cost-per-output-token", String(cfg.costPerOutputToken));
  if (cfg.requireApproval === "all") {
    args.push("--require-approval");
  } else if (Array.isArray(cfg.requireApproval) && cfg.requireApproval.length > 0) {
    args.push("--require-approval-for", cfg.requireApproval.join(","));
  }
  if (cfg.forceResume) args.push("--force-resume");
  if (cfg.profile) args.push("--profile", cfg.profile);
  if (cfg.settingsFile) args.push("--settings-file", cfg.settingsFile);
  if (Array.isArray(cfg.toolsFiles)) {
    for (const f of cfg.toolsFiles) args.push("--tools-file", f);
  }
  if (cfg.systemPromptFile) args.push("--system-prompt-file", cfg.systemPromptFile);
  if (cfg.outputFormat) args.push("--output-format", cfg.outputFormat);
  if (cfg.summarizeAt !== undefined) args.push("--summarize-at", String(cfg.summarizeAt));
  if (cfg.summarizeModel) args.push("--summarize-model", cfg.summarizeModel);
  if (cfg.summarizeKeepRecentTurns !== undefined) args.push("--summarize-keep-recent-turns", String(cfg.summarizeKeepRecentTurns));
  if (cfg.visionModel) args.push("--vision-model", cfg.visionModel);

  const result: LoadConfigFileResult = { args };
  if (Array.isArray(cfg.turnModelRules) && cfg.turnModelRules.length > 0) {
    result.turnModelRules = cfg.turnModelRules;
  }
  if (Array.isArray(cfg.promptContent) && cfg.promptContent.length > 0) {
    result.promptContent = cfg.promptContent;
  }
  if (cfg.approvalAnswer !== undefined) {
    result.approvalAnswer = cfg.approvalAnswer;
  }
  if (cfg.approvalMode !== undefined) {
    result.approvalMode = cfg.approvalMode;
  }
  if (cfg.mcpServers && typeof cfg.mcpServers === "object") {
    result.mcpServers = cfg.mcpServers;
  }
  if (Array.isArray(cfg.requireMcpServers) && cfg.requireMcpServers.length > 0) {
    result.requireMcpServers = cfg.requireMcpServers;
  }
  if (cfg.toolTimeouts && typeof cfg.toolTimeouts === "object") {
    result.toolTimeouts = cfg.toolTimeouts as Record<string, number>;
  }
  if (cfg.maxSpawnDepth !== undefined) result.maxSpawnDepth = cfg.maxSpawnDepth;
  if (cfg.maxIdenticalToolCallTurns !== undefined) result.maxIdenticalToolCallTurns = cfg.maxIdenticalToolCallTurns;
  if (cfg.toolErrorBudgetHardStop !== undefined) result.toolErrorBudgetHardStop = cfg.toolErrorBudgetHardStop;
  if (cfg.response_format && typeof cfg.response_format.type === "string") result.response_format = cfg.response_format;
  if (cfg.hooks && typeof cfg.hooks === "object") result.hooks = cfg.hooks as Record<string, string>;
  if (cfg.planMode !== undefined) result.planMode = cfg.planMode;
  if (cfg.injectContext !== undefined) result.injectContext = cfg.injectContext;
  if (cfg.tagToolOutputs !== undefined) result.tagToolOutputs = cfg.tagToolOutputs;
  if (cfg.readProjectInstructions !== undefined) result.readProjectInstructions = cfg.readProjectInstructions;
  if (cfg.summarizePrompt) result.summarizePrompt = cfg.summarizePrompt;
  if (cfg.summarizeFallbackKeep !== undefined) result.summarizeFallbackKeep = cfg.summarizeFallbackKeep;
  if (cfg.webhookUrl) result.webhookUrl = cfg.webhookUrl;
  if (cfg.webhookFormat === "discord") result.webhookFormat = "discord";
  if (cfg.webhookSecret) result.webhookSecret = cfg.webhookSecret;
  if (cfg.bashPolicy && typeof cfg.bashPolicy === "object") result.bashPolicy = cfg.bashPolicy as Record<string, unknown>;
  if (cfg.trackFileChanges !== undefined) result.trackFileChanges = cfg.trackFileChanges;
  if (cfg.enableBrowserTools !== undefined) result.enableBrowserTools = cfg.enableBrowserTools;
  if (cfg.maxCostUsdSoft !== undefined) result.maxCostUsdSoft = cfg.maxCostUsdSoft;
  if (cfg.approvalTimeoutMs !== undefined) result.approvalTimeoutMs = cfg.approvalTimeoutMs;
  if (cfg.hookTimeoutMs !== undefined) result.hookTimeoutMs = cfg.hookTimeoutMs;
  if (cfg.hookErrorMode !== undefined) result.hookErrorMode = cfg.hookErrorMode;
  // timeoutSec is a simple scalar — push as a CLI flag so parseArgs picks it up
  if (cfg.timeoutSec !== undefined && cfg.timeoutSec > 0) {
    result.args.push("--timeout-sec", String(cfg.timeoutSec));
  }
  // apiKeys contains secrets — pass via globalThis to keep them out of argv
  if (Array.isArray(cfg.apiKeys) && cfg.apiKeys.length > 0) {
    result.apiKeys = cfg.apiKeys.filter((k): k is string => typeof k === "string" && k.trim().length > 0);
  }
  // requiredEnvVars are var names (not values) — push as CLI flags
  if (Array.isArray(cfg.requiredEnvVars) && cfg.requiredEnvVars.length > 0) {
    const names = cfg.requiredEnvVars.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
    if (names.length > 0) result.args.push("--require-env", names.join(","));
  }
  // Daemon defaults — push as CLI flags so the --serve branch reads them via argv.indexOf
  if (cfg.daemonPort !== undefined && cfg.daemonPort > 0) args.push("--port", String(cfg.daemonPort));
  if (cfg.daemonMaxConcurrent !== undefined && cfg.daemonMaxConcurrent > 0) args.push("--max-concurrent", String(cfg.daemonMaxConcurrent));
  if (typeof cfg.daemonIdleTimeout === "string") {
    if (/^\d+(?:\.\d+)?[smh]$/.test(cfg.daemonIdleTimeout)) {
      args.push("--idle-timeout", cfg.daemonIdleTimeout);
    } else if (cfg.daemonIdleTimeout.trim()) {
      process.stderr.write(
        `[orager] WARNING: daemonIdleTimeout "${cfg.daemonIdleTimeout}" is not a valid duration ` +
        `(expected a number followed by s, m, or h, e.g. "30m" or "1h") — using default\n`
      );
    }
  }
  // Memory — pass via result object so they can be stored in globalThis
  if (cfg.memory !== undefined) result.memory = cfg.memory;
  if (typeof cfg.memoryKey === "string" && cfg.memoryKey.trim()) result.memoryKey = cfg.memoryKey.trim();
  if (typeof cfg.memoryMaxChars === "number" && cfg.memoryMaxChars > 0) result.memoryMaxChars = cfg.memoryMaxChars;
  // Per-agent key isolation and memory retrieval — pass via result object (contain secrets / typed values)
  if (typeof cfg.agentApiKey === "string" && cfg.agentApiKey.trim()) result.agentApiKey = cfg.agentApiKey.trim();
  if (cfg.memoryRetrieval === "local" || cfg.memoryRetrieval === "embedding") result.memoryRetrieval = cfg.memoryRetrieval;
  if (typeof cfg.memoryEmbeddingModel === "string" && cfg.memoryEmbeddingModel.trim()) result.memoryEmbeddingModel = cfg.memoryEmbeddingModel.trim();
  return result;
}

// ── User config file (~/.orager/config.json) ──────────────────────────────────
// Loaded once at startup as base defaults. CLI flags and --config-file always
// win over user config (user config is prepended to argv so it comes first).
// The file is NOT deleted — it is a persistent configuration file.

const USER_CONFIG_PATH = path.join(os.homedir(), ".orager", "config.json");

export async function loadUserConfig(): Promise<LoadConfigFileResult> {
  let raw: string;
  try {
    raw = await fs.readFile(USER_CONFIG_PATH, "utf8");
  } catch {
    return { args: [] }; // file doesn't exist — silently skip
  }
  let cfg: ConfigFileSchema;
  try {
    cfg = JSON.parse(raw) as ConfigFileSchema;
  } catch {
    process.stderr.write(`[orager] WARNING: ~/.orager/config.json contains invalid JSON — ignoring\n`);
    return { args: [] };
  }
  // Reuse loadConfigFile's parsing logic but without the read/delete steps.
  // We write a temporary file and call loadConfigFile so the conversion logic
  // stays in one place. We use a temp path guaranteed not to contain secrets.
  const tmpPath = path.join(os.tmpdir(), `.orager-userconfig-${process.pid}.json`);
  try {
    await fs.writeFile(tmpPath, JSON.stringify(cfg), { mode: 0o600 });
    const result = await loadConfigFile(tmpPath);
    return result;
  } catch {
    return { args: [] };
  }
}
