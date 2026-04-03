#!/usr/bin/env node
/**
 * orager CLI entry point (refactored Sprint 7).
 *
 * Large blocks extracted to:
 *   src/commands/session-commands.ts  — session management handlers
 *   src/commands/memory-command.ts    — `orager memory` subcommand
 *   src/commands/run-command.ts       — `orager run` subcommand
 *   src/commands/chat-command.ts      — `orager chat` subcommand
 *   src/commands/cli-helpers.ts       — shared emit/positional helpers
 *   src/cli/config-file-expansion.ts  — --config-file globalThis expansion
 */
import process from "node:process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgentLoop } from "./loop.js";
import { emit } from "./emit.js";
import { loadToolsFromFile } from "./tools/load-tools.js";
import type { EmitResultEvent, TurnModelRule, UserMessageContentBlock, AgentLoopOptions } from "./types.js";
import { applyProfileAsync } from "./profiles.js";
import { initTelemetry } from "./telemetry.js";
import { runSetupWizard } from "./setup.js";
import { startUiServer } from "./ui-server.js";
import { createRequire } from "node:module";
import { parseArgs, readStdin } from "./cli/parse-args.js";
import { loadUserConfig } from "./cli/config-loading.js";
import { applyConfigFileExpansion, hadConfigFile } from "./cli/config-file-expansion.js";
import {
  handleListSessions, handleTrashSession, handleRestoreSession, handleDeleteSession,
  handleRollbackSession, handleForkSession, handleSearchSessions, handleCompactSession,
  handleDeleteTrashed, handleAbandonedSessions, handlePrune, handleSessionsCommand,
} from "./commands/session-commands.js";
import { handleMemorySubcommand } from "./commands/memory-command.js";
import { handleRunCommand } from "./commands/run-command.js";
import { handleChatCommand } from "./commands/chat-command.js";
import { makeCliOnEmit, extractFlag } from "./commands/cli-helpers.js";
import { requestShutdown } from "./shutdown.js";
import { closeDb } from "./memory-sqlite.js";

// ── Node.js version gate ──────────────────────────────────────────────────────
{
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 20 || (major === 20 && minor < 3)) {
    process.stderr.write(
      `orager requires Node.js >= 20.3.0 (found ${process.versions.node})\n`
    );
    process.exit(1);
  }
}

// ── Version ───────────────────────────────────────────────────────────────────
const _ORAGER_VERSION: string = (() => {
  try {
    const req = createRequire(import.meta.url);
    return (req("../package.json") as { version?: string }).version ?? "0.0.1";
  } catch {
    return "0.0.1";
  }
})();

// ── Global CLI instance lock ──────────────────────────────────────────────────
// Prevents multiple orager CLI processes from running simultaneously.
// Skipped when spawned by the adapter (--config-file) or the daemon,
// or when ORAGER_SKIP_PID_LOCK=1 (testing).

const CLI_PID_FILE = path.join(os.homedir(), ".orager", "orager.pid");
let _cliLockHeld = false;

async function acquireCliPidLock(): Promise<void> {
  const pidData = JSON.stringify({ pid: process.pid, startedAt: Date.now() });
  await fs.mkdir(path.dirname(CLI_PID_FILE), { recursive: true });

  try {
    await fs.writeFile(CLI_PID_FILE, pidData, { encoding: "utf8", mode: 0o600, flag: "wx" });
    _cliLockHeld = true;
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }

  try {
    const existing = await fs.readFile(CLI_PID_FILE, "utf8");
    const parsed = JSON.parse(existing) as { pid: number };
    try {
      process.kill(parsed.pid, 0);
      process.stderr.write(
        `[orager] another instance is already running (PID ${parsed.pid}).\n` +
        `Stop it first with: kill ${parsed.pid}\n`,
      );
      process.exit(1);
    } catch (killErr) {
      if ((killErr as NodeJS.ErrnoException).code === "EPERM") {
        process.stderr.write(
          `[orager] another instance appears to be running (PID ${parsed.pid}).\n`,
        );
        process.exit(1);
      }
      // ESRCH — process is dead, reclaim the lock
    }
  } catch {
    // Can't read/parse — treat as stale
  }

  for (let retry = 0; retry < 3; retry++) {
    await fs.unlink(CLI_PID_FILE).catch(() => {});
    try {
      await fs.writeFile(CLI_PID_FILE, pidData, { encoding: "utf8", mode: 0o600, flag: "wx" });
      _cliLockHeld = true;
      return;
    } catch {
      const raw = await fs.readFile(CLI_PID_FILE, "utf8").catch(() => "{}");
      const p = JSON.parse(raw) as { pid?: number };
      if (p.pid && p.pid !== process.pid) {
        try {
          process.kill(p.pid, 0);
          process.stderr.write(
            `[orager] another instance just started (PID ${p.pid}).\n`,
          );
          process.exit(1);
        } catch {
          // Dead — retry
        }
      }
    }
  }
}

async function releaseCliPidLock(): Promise<void> {
  if (!_cliLockHeld) return;
  _cliLockHeld = false;
  await fs.unlink(CLI_PID_FILE).catch(() => {});
}

// ── Signal handling ───────────────────────────────────────────────────────────

let interruptSessionId = "";
let interruptUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };

// Hard-kill timeout: if graceful shutdown hangs for >5s, force exit.
const SHUTDOWN_TIMEOUT_MS = 5_000;
let _shutdownInProgress = false;

async function handleInterrupt(signal: string): Promise<void> {
  // Prevent re-entrant signal handling (e.g. double Ctrl-C)
  if (_shutdownInProgress) {
    process.stderr.write(`\n[orager] force exit on second ${signal}\n`);
    process.exit(1);
  }
  _shutdownInProgress = true;

  process.stderr.write(`\n[orager] received ${signal}, shutting down gracefully...\n`);

  // Set the flag — the agent loop checks this at the top of each turn and
  // breaks cleanly, allowing the finally block to save sessions + release locks.
  requestShutdown();

  // Emit interrupted result so listeners (e.g. Paperclip adapter) know we stopped.
  const resultEvent: EmitResultEvent = {
    type: "result",
    subtype: "interrupted",
    result: `Process interrupted by ${signal}`,
    session_id: interruptSessionId,
    finish_reason: null,
    usage: interruptUsage,
    total_cost_usd: 0,
  };
  emit(resultEvent);

  // Hard-kill fallback — if the loop doesn't exit within SHUTDOWN_TIMEOUT_MS,
  // force-close everything and exit. This prevents hanging on stuck tool calls.
  const hardKill = setTimeout(() => {
    process.stderr.write(`[orager] shutdown timeout (${SHUTDOWN_TIMEOUT_MS}ms) — forcing exit\n`);
    _doFinalCleanup().finally(() => process.exit(1));
  }, SHUTDOWN_TIMEOUT_MS);
  // Don't let this timer keep the process alive if the loop exits normally.
  if (hardKill.unref) hardKill.unref();

  // Flush OTel spans/metrics before exit so no telemetry is lost on SIGTERM.
  try {
    const { flushTelemetry } = await import("./telemetry.js");
    await flushTelemetry();
  } catch { /* non-fatal — never block shutdown */ }
}

/**
 * Close all open SQLite handles and release the PID lock.
 * Called both on normal exit and on hard-kill timeout.
 */
async function _doFinalCleanup(): Promise<void> {
  try { closeDb(); } catch { /* best-effort WAL checkpoint */ }
  await releaseCliPidLock();
}

process.on("SIGINT", () => { void handleInterrupt("SIGINT"); });
process.on("SIGTERM", () => { void handleInterrupt("SIGTERM"); });

// ── Help command ──────────────────────────────────────────────────────────────

function handleHelp(): void {
  process.stdout.write(`orager ${_ORAGER_VERSION} — autonomous AI agent runner

USAGE
  orager run [OPTIONS] "prompt"
  orager chat [OPTIONS]
  echo "prompt" | orager --print -   (legacy pipe mode)

COMMANDS
  run "prompt"              Run the agent once and exit (non-interactive)
  chat                      Start an interactive multi-turn conversation

COMMON OPTIONS (run & chat)
  --model <id>              Model to use (default: deepseek/deepseek-chat-v3-2)
  --session-id <id>         Resume an existing session (alias: --resume)
  --max-turns <n>           Maximum agent turns (default: 20)
  --max-cost-usd <n>        Hard stop when cost exceeds this value (USD)
  --memory-key <key>        Memory namespace for this run
  --file <path>             Attach a file (image, PDF, audio, text) — repeatable
  --subprocess              Run agent in an isolated subprocess (JSON-RPC transport)
  --verbose                 Verbose logging
  --dangerously-skip-permissions  Skip all tool-use permission checks

PROFILES
  --profile <name>          Apply a named profile preset (code-review, bug-fix,
                            research, refactor, test-writer, devops)

SESSIONS
  --list-sessions           List all sessions
  --search-sessions <q>     Search sessions by content
                              --limit <n>    Cap results (default 20, max 100)
                              --offset <n>   Skip first n results for pagination (default 0)
  --trash-session <id>      Move a session to trash
  --restore-session <id>    Restore a trashed session
  --delete-session <id>     Permanently delete a session
  --delete-trashed          Delete all trashed sessions
  --rollback-session <id>   Roll back a session to previous turn
  --fork-session <id>       Create a branch of a session
                              --at-turn <n>   Fork at a specific turn (default: latest)
                              --resume        Immediately resume the forked session
  --compact-session <id>    Summarize a session in-place
  --prune-sessions          Delete sessions older than 30 days (default)
                              --older-than <value>  Override age threshold, e.g. 7d, 24h, 1h

TOOLS & SAFETY
  --require-approval              Require approval for all tool calls
  --require-approval-for <tools>  Require approval for specific tools (comma-separated)
  --bash-policy <json>            Bash tool policy (blocked commands, env vars)
  --settings-file <path>          Path to a custom settings JSON file
  --auto-memory                   Enable auto-memory (write_memory/read_memory tools)

COST
  --max-cost-usd <n>        Hard stop if cost exceeds this value
  --max-cost-usd-soft <n>   Warn (but continue) when cost exceeds this value
  --timeout-sec <n>         Run-level timeout in seconds

OTHER
  --version, -v             Print version and exit
  --help, -h                Print this help and exit
  setup                     Run the interactive setup wizard
  setup --check             Validate config and test the API key
  ui [--port <n>]           Start the browser-based UI server (default port: 3457)
  memory <list|inspect|export|clear>  Manage memory namespaces
  skills <list|show|delete|stats|extract>  Manage learned skills (SkillBank)
  skill-train [--rl] [--status] [--rollback] [--setup-cron]  OMLS RL training

SERVER
  --serve [--port <n>]      Start the HTTP UI server (opt-in, port default: 3456)

ENVIRONMENT
  PROTOCOL_API_KEY          LLM provider API key (required)
  ORAGER_MAX_TURNS          Override default max turns (overridden by --max-turns flag)
  ORAGER_JSON_LOGS          Set to "1" to emit structured JSON startup log to stderr
  ORAGER_SESSIONS_DIR       Override sessions directory
  ORAGER_PROFILES_DIR       Override profiles directory
  ORAGER_SETTINGS_ALLOWED_ROOTS  Colon-separated absolute path roots for settingsFile

DOCS
  https://github.com/JayCodesX/orager
`);
  process.exit(0);
}

// ── Status command (no-op stub — ADR-0003) ────────────────────────────────────

async function handleStatus(jsonMode = false): Promise<void> {
  const msg = "orager daemon has been removed (ADR-0003). Use `orager serve` to start the UI server.";
  if (jsonMode) {
    process.stdout.write(JSON.stringify({ running: false, error: msg }) + "\n");
  } else {
    process.stdout.write(msg + "\n");
  }
  process.exit(1);
}

// ── Clear model cache ─────────────────────────────────────────────────────────

async function handleClearModelCache(): Promise<void> {
  const cacheFiles = [
    path.join(os.homedir(), ".orager", "model-meta-cache.json"),
    path.join(os.homedir(), ".orager", "model-context-cache.json"),
  ];
  let cleared = 0;
  for (const f of cacheFiles) {
    try {
      await fs.unlink(f);
      process.stdout.write(`cleared: ${f}\n`);
      cleared++;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        process.stderr.write(`orager: failed to delete ${f}: ${(err as Error).message}\n`);
      }
    }
  }
  if (cleared === 0) {
    process.stdout.write("orager: no model cache files found (already clear)\n");
  } else {
    process.stdout.write(`orager: cleared ${cleared} cache file(s). Next run will fetch fresh model metadata.\n`);
  }
  process.exit(0);
}

// ── Re-exports ────────────────────────────────────────────────────────────────
// loadConfigFile re-exported for backward compatibility (tests import from index)
export { loadConfigFile } from "./cli/config-loading.js";
export { runAgentWorkflow } from "./workflow.js";
export type { AgentConfig, AgentWorkflow, AgentDefinition } from "./types.js";

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Load settings early so telemetry.enabled/endpoint can be respected at startup.
  // The full settings merge happens inside runAgentLoop; this is just a lightweight
  // pre-read to extract the telemetry block before any SDK initialisation.
  const { loadSettings } = await import("./settings.js");
  const earlySettings = await loadSettings();
  await initTelemetry("orager", earlySettings.telemetry);

  let argv = process.argv.slice(2);
  // Track whether --config-file was present before expansion (used to skip PID lock)
  const _hadConfigFile = hadConfigFile(argv);

  // ── Version ──────────────────────────────────────────────────────────────────
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`orager ${_ORAGER_VERSION}\n`);
    process.exit(0);
  }

  // ── Help ──────────────────────────────────────────────────────────────────────
  if (argv.includes("--help") || argv.includes("-h")) {
    handleHelp();
    return;
  }

  // ── Setup wizard ──────────────────────────────────────────────────────────────
  if (argv[0] === "setup") {
    await runSetupWizard(argv.slice(1));
    return;
  }

  // ── UI server ─────────────────────────────────────────────────────────────────
  if (argv[0] === "ui") {
    const portIdx = argv.indexOf("--port");
    const port = portIdx !== -1 ? parseInt(argv[portIdx + 1] ?? "3457", 10) : 3457;
    await startUiServer({ port });
    return;
  }

  // ── Memory subcommand ─────────────────────────────────────────────────────────
  if (argv[0] === "memory") {
    await handleMemorySubcommand(argv);
    return;
  }

  // ── skills subcommand (ADR-0006) ──────────────────────────────────────────────
  if (argv[0] === "skills") {
    const { handleSkillsSubcommand } = await import("./cli/skills-command.js");
    await handleSkillsSubcommand(argv.slice(1));
    return;
  }

  // ── skill-train subcommand (ADR-0007) ─────────────────────────────────────────
  if (argv[0] === "skill-train") {
    const { handleSkillTrainSubcommand } = await import("./cli/skill-train-command.js");
    await handleSkillTrainSubcommand(argv.slice(1));
    return;
  }

  // ── run subcommand ────────────────────────────────────────────────────────────
  if (argv[0] === "run") {
    await handleRunCommand(argv.slice(1), {
      releaseCliPidLock,
      setInterruptSessionId: (id) => { interruptSessionId = id; },
    });
    return;
  }

  // ── chat subcommand ───────────────────────────────────────────────────────────
  if (argv[0] === "chat") {
    await handleChatCommand(argv.slice(1), {
      setInterruptSessionId: (id) => { interruptSessionId = id; },
    });
    return;
  }

  // ── Subprocess server mode (JSON-RPC 2.0 over stdio) ─────────────────────────
  if (argv.includes("--subprocess")) {
    const { startSubprocessServer } = await import("./subprocess.js");
    await startSubprocessServer();
    return;
  }

  // ── serve — UI-only HTTP server ───────────────────────────────────────────────
  if (argv.includes("--serve")) {
    const portIdx = argv.indexOf("--port");
    const port = portIdx !== -1 ? parseInt(argv[portIdx + 1] ?? "3457", 10) : 3457;
    await startUiServer({ port });
    return;
  }

  // ── Status command ────────────────────────────────────────────────────────────
  if (argv.includes("--status")) { await handleStatus(argv.includes("--json")); return; }

  // ── Sessions table command ────────────────────────────────────────────────────
  if (argv.includes("--sessions")) { await handleSessionsCommand(argv); return; }

  // ── Rotate-key command (ADR-0003: daemon removed) ─────────────────────────────
  if (argv.includes("--rotate-key")) {
    process.stderr.write("orager: --rotate-key has been removed (ADR-0003 — daemon is gone).\n");
    process.exit(1);
  }

  // ── Session management commands ───────────────────────────────────────────────
  if (argv.includes("--list-sessions"))    { await handleListSessions();         return; }
  if (argv.includes("--search-sessions"))  { await handleSearchSessions(argv);  return; }
  if (argv.includes("--trash-session"))    { await handleTrashSession(argv);    return; }
  if (argv.includes("--restore-session"))  { await handleRestoreSession(argv);  return; }
  if (argv.includes("--delete-session"))   { await handleDeleteSession(argv);   return; }
  if (argv.includes("--delete-trashed"))   { await handleDeleteTrashed();       return; }
  if (argv.includes("--rollback-session")) { await handleRollbackSession(argv); return; }
  // P-09: --fork-session forks a session. With --resume, it continues to the agent loop.
  if (argv.includes("--fork-session")) {
    const forkResult = await handleForkSession(argv);
    if (forkResult.resume) {
      const cleaned: string[] = [];
      for (let fi = 0; fi < argv.length; fi++) {
        if (argv[fi] === "--fork-session" || argv[fi] === "--at-turn") { fi++; continue; }
        if (argv[fi] === "--resume") continue;
        cleaned.push(argv[fi]!);
      }
      cleaned.push("--resume", forkResult.sessionId, "--force-resume");
      argv = cleaned;
    }
  }
  if (argv.includes("--compact-session"))  { await handleCompactSession(argv);  return; }
  if (argv.includes("--prune-sessions"))   { await handlePrune(argv);           return; }
  if (argv.includes("--abandoned-sessions")) { await handleAbandonedSessions(); return; }
  if (argv.includes("--clear-model-cache")) { await handleClearModelCache(); return; }

  // ── User config (~/.orager/config.json) — base defaults ──────────────────────
  {
    const userCfg = await loadUserConfig();
    if (userCfg.args.length > 0) {
      argv = [...userCfg.args, ...argv];
    }
    const G = globalThis as Record<string, unknown>;
    if (userCfg.turnModelRules && !G.__oragerTurnModelRules)         G.__oragerTurnModelRules = userCfg.turnModelRules;
    if (userCfg.promptContent  && !G.__oragerPromptContent)          G.__oragerPromptContent  = userCfg.promptContent;
    if (userCfg.mcpServers     && !G.__oragerMcpServers)             G.__oragerMcpServers     = userCfg.mcpServers;
    if (userCfg.hooks          && !G.__oragerHooks)                  G.__oragerHooks          = userCfg.hooks;
    if (userCfg.bashPolicy     && !G.__oragerBashPolicy)             G.__oragerBashPolicy     = userCfg.bashPolicy;
    if (userCfg.planMode       !== undefined && !G.__oragerPlanMode)   G.__oragerPlanMode   = userCfg.planMode;
    if (userCfg.injectContext  !== undefined && !G.__oragerInjectContext) G.__oragerInjectContext = userCfg.injectContext;
    if (userCfg.tagToolOutputs !== undefined && !G.__oragerTagToolOutputs) G.__oragerTagToolOutputs = userCfg.tagToolOutputs;
    if (userCfg.trackFileChanges !== undefined && !G.__oragerTrackFileChanges) G.__oragerTrackFileChanges = userCfg.trackFileChanges;
    if (userCfg.enableBrowserTools !== undefined && !G.__oragerEnableBrowserTools) G.__oragerEnableBrowserTools = userCfg.enableBrowserTools;
    if (userCfg.memory  !== undefined && !G.__oragerMemory)          G.__oragerMemory = userCfg.memory;
    if (userCfg.memoryKey && !G.__oragerMemoryKey)                   G.__oragerMemoryKey = userCfg.memoryKey;
    if (userCfg.memoryMaxChars !== undefined && !G.__oragerMemoryMaxChars) G.__oragerMemoryMaxChars = userCfg.memoryMaxChars;
    if (userCfg.apiKeys && !G.__oragerApiKeys)                       G.__oragerApiKeys = userCfg.apiKeys;
    if (userCfg.webhookUrl && !G.__oragerWebhookUrl)                 G.__oragerWebhookUrl = userCfg.webhookUrl;
    if (userCfg.webhookFormat && !G.__oragerWebhookFormat)           G.__oragerWebhookFormat = userCfg.webhookFormat;
    if (userCfg.webhookSecret && !G.__oragerWebhookSecret)           G.__oragerWebhookSecret = userCfg.webhookSecret;
    if (userCfg.maxCostUsdSoft !== undefined && !G.__oragerMaxCostUsdSoft) G.__oragerMaxCostUsdSoft = userCfg.maxCostUsdSoft;
  }

  // ── Config file expansion ─────────────────────────────────────────────────────
  argv = await applyConfigFileExpansion(argv);

  // ── Acquire global CLI instance lock ──────────────────────────────────────────
  const _skipPidLock = _hadConfigFile
    || process.env["ORAGER_DAEMON_MODE"] === "1"
    || process.env["ORAGER_SKIP_PID_LOCK"] === "1";
  if (!_skipPidLock) {
    await acquireCliPidLock();
  }

  // ── Resolve API key ───────────────────────────────────────────────────────────
  const apiKey = process.env["PROTOCOL_API_KEY"] ?? "";
  if (!apiKey) {
    process.stderr.write("orager: API key not set. Export PROTOCOL_API_KEY.\n");
    process.exit(1);
  }

  const cliMemoryKey = extractFlag(argv, "--memory-key");
  const [prompt, opts] = await Promise.all([
    readStdin(),
    Promise.resolve(parseArgs(argv)),
  ]);

  // Load extra tools from JSON spec files
  const extraTools = [];
  for (const filePath of opts.toolsFiles) {
    try {
      const loaded = await loadToolsFromFile(filePath);
      extraTools.push(...loaded);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`orager: ${msg}\n`);
      process.exit(1);
    }
  }

  if (!prompt.trim()) {
    process.stderr.write("orager: empty prompt — nothing to do\n");
    process.exit(1);
  }

  // Load system prompt file if provided
  let appendSystemPrompt: string | undefined;
  if (opts.systemPromptFile) {
    try {
      appendSystemPrompt = await fs.readFile(opts.systemPromptFile, "utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`orager: warning: could not read --system-prompt-file "${opts.systemPromptFile}": ${msg}\n`);
    }
  }

  if (opts.sessionId) {
    interruptSessionId = opts.sessionId;
  }

  const reasoning = (opts.reasoningEffort || opts.reasoningMaxTokens || opts.reasoningExclude)
    ? {
        ...(opts.reasoningEffort ? { effort: opts.reasoningEffort } : {}),
        ...(opts.reasoningMaxTokens ? { max_tokens: opts.reasoningMaxTokens } : {}),
        ...(opts.reasoningExclude ? { exclude: true } : {}),
      }
    : undefined;

  const provider = (opts.providerOrder || opts.providerIgnore || opts.providerOnly ||
    opts.dataCollection || opts.zdr || opts.sort || opts.quantizations || opts.require_parameters)
    ? {
        ...(opts.providerOrder ? { order: opts.providerOrder } : {}),
        ...(opts.providerIgnore ? { ignore: opts.providerIgnore } : {}),
        ...(opts.providerOnly ? { only: opts.providerOnly } : {}),
        ...(opts.dataCollection ? { data_collection: opts.dataCollection } : {}),
        ...(opts.zdr ? { zdr: true } : {}),
        ...(opts.sort ? { sort: opts.sort } : {}),
        ...(opts.quantizations ? { quantizations: opts.quantizations } : {}),
        ...(opts.require_parameters ? { require_parameters: true } : {}),
      }
    : undefined;

  // ── Build loop options ────────────────────────────────────────────────────────
  const G = globalThis as Record<string, unknown>;
  let loopOpts: AgentLoopOptions = {
    prompt,
    model: opts.model,
    apiKey,
    sessionId: opts.sessionId,
    addDirs: opts.addDirs,
    maxTurns: opts.maxTurns,
    maxRetries: opts.maxRetries,
    forceResume: opts.forceResume,
    cwd: process.cwd(),
    dangerouslySkipPermissions: opts.dangerouslySkipPermissions,
    verbose: opts.verbose,
    onEmit: makeCliOnEmit(emit),
    onLog: (stream, chunk) => {
      if (stream === "stderr") process.stderr.write(chunk);
    },
    models: opts.models.length > 0 ? opts.models : undefined,
    sandboxRoot: opts.sandboxRoot,
    extraTools: extraTools.length > 0 ? extraTools : undefined,
    requireApproval: opts.requireApproval,
    useFinishTool: opts.useFinishTool,
    maxCostUsd: opts.maxCostUsd,
    costPerInputToken: opts.costPerInputToken,
    costPerOutputToken: opts.costPerOutputToken,
    siteUrl: opts.siteUrl,
    siteName: opts.siteName,
    temperature: opts.temperature,
    top_p: opts.top_p,
    top_k: opts.top_k,
    frequency_penalty: opts.frequency_penalty,
    presence_penalty: opts.presence_penalty,
    repetition_penalty: opts.repetition_penalty,
    min_p: opts.min_p,
    seed: opts.seed,
    stop: opts.stop,
    tool_choice: opts.tool_choice,
    parallel_tool_calls: opts.parallel_tool_calls,
    reasoning,
    provider,
    transforms: opts.transforms,
    preset: opts.preset,
    appendSystemPrompt,
    summarizeAt: opts.summarizeAt,
    summarizeModel: opts.summarizeModel,
    summarizeKeepRecentTurns: opts.summarizeKeepRecentTurns,
    visionModel: opts.visionModel,
    turnModelRules: G.__oragerTurnModelRules as TurnModelRule[] | undefined,
    promptContent: G.__oragerPromptContent as UserMessageContentBlock[] | undefined,
    approvalAnswer: (G.__oragerApprovalAnswer as { choiceKey: string; toolCallId: string } | null | undefined) ?? opts.approvalAnswer ?? null,
    approvalMode: (G.__oragerApprovalMode as "tty" | "question" | undefined) ?? opts.approvalMode,
    settingsFile: opts.settingsFile,
    mcpServers: G.__oragerMcpServers as AgentLoopOptions["mcpServers"] | undefined,
    requireMcpServers: G.__oragerRequireMcpServers as string[] | undefined,
    toolTimeouts: G.__oragerToolTimeouts as Record<string, number> | undefined,
    maxSpawnDepth: (G.__oragerMaxSpawnDepth as number | undefined) ?? opts.maxSpawnDepth,
    maxIdenticalToolCallTurns: (G.__oragerMaxIdenticalToolCallTurns as number | undefined) ?? opts.maxIdenticalToolCallTurns,
    toolErrorBudgetHardStop: (G.__oragerToolErrorBudgetHardStop as boolean | undefined) ?? opts.toolErrorBudgetHardStop,
    response_format: G.__oragerResponseFormat as AgentLoopOptions["response_format"] | undefined,
    hooks: G.__oragerHooks as AgentLoopOptions["hooks"] | undefined,
    planMode: (G.__oragerPlanMode as boolean | undefined) ?? opts.planMode,
    injectContext: (G.__oragerInjectContext as boolean | undefined) ?? opts.injectContext,
    tagToolOutputs: (G.__oragerTagToolOutputs as boolean | undefined) ?? opts.tagToolOutputs,
    readProjectInstructions: G.__oragerReadProjectInstructions as boolean | undefined,
    summarizePrompt: G.__oragerSummarizePrompt as string | undefined,
    summarizeFallbackKeep: G.__oragerSummarizeFallbackKeep as number | undefined,
    webhookUrl: G.__oragerWebhookUrl as string | undefined,
    webhookFormat: G.__oragerWebhookFormat as "discord" | undefined,
    webhookSecret: G.__oragerWebhookSecret as string | undefined,
    bashPolicy: G.__oragerBashPolicy as AgentLoopOptions["bashPolicy"] | undefined,
    trackFileChanges: (G.__oragerTrackFileChanges as boolean | undefined) ?? opts.trackFileChanges,
    enableBrowserTools: (G.__oragerEnableBrowserTools as boolean | undefined) ?? opts.enableBrowserTools,
    autoMemory: opts.autoMemory,
    ollama: opts.ollama,
    maxCostUsdSoft: G.__oragerMaxCostUsdSoft as number | undefined,
    approvalTimeoutMs: G.__oragerApprovalTimeoutMs as number | undefined,
    hookTimeoutMs: G.__oragerHookTimeoutMs as number | undefined,
    hookErrorMode: (G.__oragerHookErrorMode as AgentLoopOptions["hookErrorMode"] | undefined) ?? opts.hookErrorMode,
    timeoutSec: opts.timeoutSec,
    apiKeys: G.__oragerApiKeys as string[] | undefined,
    requiredEnvVars: opts.requiredEnvVars,
    memory: G.__oragerMemory as boolean | undefined,
    memoryKey: (G.__oragerMemoryKey as string | undefined) ?? cliMemoryKey,
    memoryMaxChars: G.__oragerMemoryMaxChars as number | undefined,
    agentApiKey: G.__oragerAgentApiKey as string | undefined,
    memoryRetrieval: G.__oragerMemoryRetrieval as "local" | "embedding" | undefined,
    memoryEmbeddingModel: G.__oragerMemoryEmbeddingModel as string | undefined,
  };

  if (opts.profile) {
    loopOpts = await applyProfileAsync(opts.profile, loopOpts);
  }

  try {
    await runAgentLoop(loopOpts);
  } finally {
    await releaseCliPidLock();
  }
}

// Guard so the module can be imported for testing without triggering the CLI.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(async (err: unknown) => {
    await releaseCliPidLock();
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`orager: fatal error: ${message}\n`);
    process.exit(1);
  });
}
