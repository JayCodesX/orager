#!/usr/bin/env node
import process from "node:process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runAgentLoop } from "./loop.js";
import { emit } from "./emit.js";
import { loadToolsFromFile } from "./tools/load-tools.js";
import {
  pruneOldSessions,
  deleteTrashedSessions,
  trashSession,
  restoreSession,
  deleteSession,
  listSessions,
  rollbackSession,
  searchSessions,
} from "./session.js";
import type { CliOptions, EmitResultEvent, TurnModelRule, UserMessageContentBlock, AgentLoopOptions } from "./types.js";
import { startDaemon, readDaemonPort } from "./daemon.js";
import { mintJwt, KEY_PATH } from "./jwt.js";
import { applyProfileAsync } from "./profiles.js";
import { initTelemetry } from "./telemetry.js";
import { runSetupWizard } from "./setup.js";
import { createRequire } from "node:module";
import { loadMemoryStoreAny, MEMORY_DIR } from "./memory.js";
import {
  isSqliteMemoryEnabled,
  listMemoryKeysSqlite,
  clearMemoryStoreSqlite,
} from "./memory-sqlite.js";
import readline from "node:readline";

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

// ── Stdin reading ────────────────────────────────────────────────────────────

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    process.stderr.write(
      "orager: no input provided. Usage: echo '<prompt>' | orager --print -\n"
    );
    process.exit(1);
  }

  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

// ── Arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    model: "deepseek/deepseek-chat-v3-2",
    models: [],
    sessionId: null,
    addDirs: [],
    maxTurns: 20,
    maxRetries: 3,
    forceResume: false,
    dangerouslySkipPermissions: false,
    verbose: false,
    outputFormat: "stream-json",
    toolsFiles: [],
    useFinishTool: false,
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    switch (arg) {
      case "--print": {
        // consume the next token (expected to be "-")
        i++;
        break;
      }
      case "--output-format": {
        const val = argv[++i];
        if (val === "stream-json" || val === "text") {
          opts.outputFormat = val;
        }
        break;
      }
      case "--model": {
        opts.model = argv[++i];
        break;
      }
      case "--resume": {
        opts.sessionId = argv[++i] ?? null;
        break;
      }
      case "--force-resume": {
        opts.forceResume = true;
        break;
      }
      case "--max-retries": {
        const n = parseInt(argv[++i], 10);
        if (!isNaN(n) && n >= 0) opts.maxRetries = n;
        break;
      }
      case "--timeout-sec": {
        const n = parseFloat(argv[++i]);
        if (!isNaN(n) && n >= 0) opts.timeoutSec = n;
        break;
      }
      case "--require-env": {
        const s = argv[++i];
        if (s) opts.requiredEnvVars = s.split(",").map((v) => v.trim()).filter(Boolean);
        break;
      }
      case "--add-dir": {
        const dir = argv[++i];
        if (dir) opts.addDirs.push(dir);
        break;
      }
      case "--max-turns": {
        const n = parseInt(argv[++i], 10);
        if (!isNaN(n)) opts.maxTurns = n;
        break;
      }
      case "--dangerously-skip-permissions": {
        opts.dangerouslySkipPermissions = true;
        break;
      }
      case "--verbose": {
        opts.verbose = true;
        break;
      }
      case "--sandbox-root": {
        opts.sandboxRoot = argv[++i];
        break;
      }
      case "--tools-file": {
        const f = argv[++i];
        if (f) opts.toolsFiles.push(f);
        break;
      }
      case "--require-approval": {
        opts.requireApproval = "all";
        break;
      }
      case "--require-approval-for": {
        const s = argv[++i];
        if (s) opts.requireApproval = s.split(",").map((t) => t.trim()).filter(Boolean);
        break;
      }
      case "--use-finish-tool": {
        opts.useFinishTool = true;
        break;
      }
      case "--max-cost-usd": {
        const n = parseFloat(argv[++i]);
        if (!isNaN(n) && n > 0) opts.maxCostUsd = n;
        break;
      }
      case "--cost-per-input-token": {
        const n = parseFloat(argv[++i]);
        if (!isNaN(n) && n >= 0) opts.costPerInputToken = n;
        break;
      }
      case "--cost-per-output-token": {
        const n = parseFloat(argv[++i]);
        if (!isNaN(n) && n >= 0) opts.costPerOutputToken = n;
        break;
      }
      case "--site-url": {
        opts.siteUrl = argv[++i];
        break;
      }
      case "--site-name": {
        opts.siteName = argv[++i];
        break;
      }
      case "--temperature": {
        const n = parseFloat(argv[++i]);
        if (!isNaN(n)) opts.temperature = n;
        break;
      }
      case "--top-p": {
        const n = parseFloat(argv[++i]);
        if (!isNaN(n)) opts.top_p = n;
        break;
      }
      case "--top-k": {
        const n = parseInt(argv[++i], 10);
        if (!isNaN(n)) opts.top_k = n;
        break;
      }
      case "--frequency-penalty": {
        const n = parseFloat(argv[++i]);
        if (!isNaN(n)) opts.frequency_penalty = n;
        break;
      }
      case "--presence-penalty": {
        const n = parseFloat(argv[++i]);
        if (!isNaN(n)) opts.presence_penalty = n;
        break;
      }
      case "--repetition-penalty": {
        const n = parseFloat(argv[++i]);
        if (!isNaN(n)) opts.repetition_penalty = n;
        break;
      }
      case "--min-p": {
        const n = parseFloat(argv[++i]);
        if (!isNaN(n)) opts.min_p = n;
        break;
      }
      case "--seed": {
        const n = parseInt(argv[++i], 10);
        if (!isNaN(n)) opts.seed = n;
        break;
      }
      case "--stop": {
        const s = argv[++i];
        if (s) {
          if (!opts.stop) opts.stop = [];
          opts.stop.push(s);
        }
        break;
      }
      case "--tool-choice": {
        opts.tool_choice = argv[++i] as "none" | "auto" | "required";
        break;
      }
      case "--parallel-tool-calls": {
        opts.parallel_tool_calls = true;
        break;
      }
      case "--no-parallel-tool-calls": {
        opts.parallel_tool_calls = false;
        break;
      }
      case "--reasoning-effort": {
        opts.reasoningEffort = argv[++i] as "xhigh" | "high" | "medium" | "low" | "minimal" | "none";
        break;
      }
      case "--reasoning-max-tokens": {
        const n = parseInt(argv[++i], 10);
        if (!isNaN(n)) opts.reasoningMaxTokens = n;
        break;
      }
      case "--reasoning-exclude": {
        opts.reasoningExclude = true;
        break;
      }
      case "--provider-order": {
        const s = argv[++i];
        if (s) opts.providerOrder = s.split(",").map((p) => p.trim()).filter(Boolean);
        break;
      }
      case "--provider-only": {
        const s = argv[++i];
        if (s) opts.providerOnly = s.split(",").map((p) => p.trim()).filter(Boolean);
        break;
      }
      case "--provider-ignore": {
        const s = argv[++i];
        if (s) opts.providerIgnore = s.split(",").map((p) => p.trim()).filter(Boolean);
        break;
      }
      case "--data-collection": {
        opts.dataCollection = argv[++i] as "allow" | "deny";
        break;
      }
      case "--zdr": {
        opts.zdr = true;
        break;
      }
      case "--sort": {
        opts.sort = argv[++i] as "price" | "throughput" | "latency";
        break;
      }
      case "--quantizations": {
        const s = argv[++i];
        if (s) opts.quantizations = s.split(",").map((q) => q.trim()).filter(Boolean);
        break;
      }
      case "--require-parameters": {
        opts.require_parameters = true;
        break;
      }
      case "--preset": {
        opts.preset = argv[++i];
        break;
      }
      case "--transforms": {
        const s = argv[++i];
        if (s) opts.transforms = s.split(",").map((t) => t.trim()).filter(Boolean);
        break;
      }
      case "--model-fallback": {
        const s = argv[++i];
        if (s) opts.models.push(s);
        break;
      }
      case "--system-prompt-file": {
        opts.systemPromptFile = argv[++i];
        break;
      }
      case "--summarize-at": {
        const n = parseFloat(argv[++i]);
        if (!isNaN(n) && n > 0 && n <= 1) opts.summarizeAt = n;
        break;
      }
      case "--summarize-model": {
        opts.summarizeModel = argv[++i];
        break;
      }
      case "--summarize-keep-recent-turns": {
        const n = parseInt(argv[++i], 10);
        if (!isNaN(n) && n >= 0) opts.summarizeKeepRecentTurns = n;
        break;
      }
      case "--approval-mode": {
        const v = argv[++i];
        if (v === "tty" || v === "question") opts.approvalMode = v;
        break;
      }
      case "--profile": {
        opts.profile = argv[++i];
        break;
      }
      case "--settings-file": {
        opts.settingsFile = argv[++i];
        break;
      }
      case "--plan-mode": {
        opts.planMode = true;
        break;
      }
      case "--inject-context": {
        opts.injectContext = true;
        break;
      }
      case "--enable-browser-tools": {
        opts.enableBrowserTools = true;
        break;
      }
      case "--track-file-changes": {
        opts.trackFileChanges = true;
        break;
      }
      case "--tag-tool-outputs": {
        opts.tagToolOutputs = true;
        break;
      }
      case "--no-tag-tool-outputs": {
        opts.tagToolOutputs = false;
        break;
      }
      case "--hook-error-mode": {
        const v = argv[++i];
        if (v === "ignore" || v === "warn" || v === "fail") opts.hookErrorMode = v;
        break;
      }
      case "--tool-error-budget-hard-stop": {
        opts.toolErrorBudgetHardStop = true;
        break;
      }
      case "--prune-sessions": {
        // handled in main before loop
        break;
      }
      case "--older-than": {
        // handled in main before loop (paired with --prune-sessions)
        i++;
        break;
      }
      default:
        // Unknown flags or positional args — skip
        break;
    }

    i++;
  }

  return opts;
}

// ── Signal handling ──────────────────────────────────────────────────────────

let interruptSessionId = "";
let interruptUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };

function handleInterrupt(signal: string): void {
  process.stderr.write(`\n[orager] received ${signal}, shutting down\n`);

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
  process.exit(0);
}

process.on("SIGINT", () => handleInterrupt("SIGINT"));
process.on("SIGTERM", () => handleInterrupt("SIGTERM"));

// ── Main ─────────────────────────────────────────────────────────────────────

// ── Help command ─────────────────────────────────────────────────────────────

function handleHelp(): void {
  process.stdout.write(`orager ${_ORAGER_VERSION} — autonomous AI agent runner

USAGE
  orager [OPTIONS] [PROMPT]
  echo "prompt" | orager --print -

BASIC
  --model <id>              Model to use (default: deepseek/deepseek-chat-v3-2)
  --max-turns <n>           Maximum agent turns (default: 30)
  --timeout-sec <n>         Run-level timeout in seconds (default: 300)
  --session-id <id>         Resume an existing session
  --cwd <path>              Working directory for the agent
  --print                   Print result to stdout (non-interactive mode)
  --verbose                 Verbose logging

DAEMON
  --serve                   Start the HTTP daemon (persistent server mode)
  --port <n>                Daemon port (default: 3456)
  --max-concurrent <n>      Max concurrent runs (default: 3)
  --idle-timeout <duration> Idle shutdown timeout, e.g. 30m, 1h (default: 30m)
  --status                  Check if the daemon is running
  --status --json           Machine-readable status output
  --clear-model-cache       Delete cached model metadata (force fresh fetch)

PROFILES
  --profile <name>          Apply a named profile preset (code-review, bug-fix,
                            research, refactor, test-writer, devops)

SESSIONS
  --list-sessions           List all sessions
  --search-sessions <q>     Search sessions by content
  --trash-session <id>      Move a session to trash
  --restore-session <id>    Restore a trashed session
  --delete-session <id>     Permanently delete a session
  --delete-trashed          Delete all trashed sessions
  --rollback-session <id>   Roll back a session to previous turn
  --prune-sessions          Delete sessions older than 30 days

TOOLS & SAFETY
  --dangerously-skip-permissions  Skip all tool-use permission checks
  --require-approval <mode>       Approval mode: all, none, tools
  --bash-policy <json>            Bash tool policy (blocked commands, env vars)
  --settings-file <path>          Path to a custom settings JSON file

COST
  --max-cost-usd <n>        Hard stop if cost exceeds this value
  --max-cost-usd-soft <n>   Warn (but continue) when cost exceeds this value

OTHER
  --version, -v             Print version and exit
  --help, -h                Print this help and exit
  setup                     Run the interactive setup wizard

ENVIRONMENT
  OPENROUTER_API_KEY        OpenRouter API key (required)
  ORAGER_API_KEY            Alternative API key env var
  ORAGER_SESSIONS_DIR       Override sessions directory
  ORAGER_PROFILES_DIR       Override profiles directory
  ORAGER_SETTINGS_ALLOWED_ROOTS  Colon-separated absolute path roots for settingsFile

DOCS
  https://github.com/JayCodesX/orager
`);
  process.exit(0);
}

// ── Status command ────────────────────────────────────────────────────────────

function formatUptime(uptimeMs: number): string {
  const uptimeSec = Math.floor(uptimeMs / 1000);
  const h = Math.floor(uptimeSec / 3600);
  const m = Math.floor((uptimeSec % 3600) / 60);
  const s = uptimeSec % 60;
  return `${h}h ${m}m ${s}s`;
}

async function handleStatus(jsonMode = false): Promise<void> {
  const port = await readDaemonPort();
  if (!port) {
    if (jsonMode) {
      process.stdout.write(JSON.stringify({ running: false, port: null, url: null, error: "no port file found" }) + "\n");
    } else {
      process.stdout.write("orager daemon: not running (no port file found)\n");
    }
    process.exit(1);
  }

  const url = `http://127.0.0.1:${port}`;
  try {
    const healthRes = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!healthRes.ok) {
      if (jsonMode) {
        process.stdout.write(JSON.stringify({ running: false, port, url, error: `/health returned HTTP ${healthRes.status}` }) + "\n");
      } else {
        process.stdout.write(
          `orager daemon: port file found (port ${port}) but /health returned HTTP ${healthRes.status}\n`,
        );
      }
      process.exit(1);
    }
  } catch {
    const msg = "daemon not responding (connection refused or timeout)";
    if (jsonMode) {
      process.stdout.write(JSON.stringify({ running: false, port, url, error: msg }) + "\n");
    } else {
      process.stdout.write(`orager daemon: port file found (port ${port}) but ${msg}\n`);
    }
    process.exit(1);
  }

  // Daemon is alive — fetch full metrics for extended status display.
  // Non-fatal: if the key can't be read or /metrics fails, we still report running.
  interface MetricsBody {
    uptimeMs?: number;
    activeRuns?: number;
    completedRuns?: number;
    errorRuns?: number;
    circuitBreakersByAgent?: Record<string, unknown>;
    recentModels?: string[];
  }
  let metrics: MetricsBody | null = null;
  try {
    const keyData = await fs.readFile(KEY_PATH, "utf8");
    const signingKey = keyData.trim();
    if (signingKey) {
      const token = mintJwt(signingKey, "orager-cli-status");
      const metricsRes = await fetch(`${url}/metrics`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(3000),
      });
      if (metricsRes.ok) {
        metrics = await metricsRes.json() as MetricsBody;
      }
    }
  } catch {
    // Key not found or metrics call failed — proceed without metrics
  }

  const uptimeMs = metrics?.uptimeMs ?? null;

  if (jsonMode) {
    const out: Record<string, unknown> = { running: true, port, url, uptimeMs };
    if (metrics) {
      out["activeRuns"] = metrics.activeRuns ?? null;
      out["completedRuns"] = metrics.completedRuns ?? null;
      out["errorRuns"] = metrics.errorRuns ?? null;
      out["circuitBreakersByAgent"] = metrics.circuitBreakersByAgent ?? {};
      out["recentModels"] = metrics.recentModels ?? [];
      if (typeof uptimeMs === "number") out["uptime"] = formatUptime(uptimeMs);
    }
    process.stdout.write(JSON.stringify(out) + "\n");
  } else {
    process.stdout.write(`orager daemon: running on port ${port}\n`);
    process.stdout.write(`  url: ${url}\n`);
    if (uptimeMs !== null) {
      process.stdout.write(`  uptime: ${formatUptime(uptimeMs)}\n`);
    }
    if (metrics) {
      process.stdout.write(`  activeRuns: ${metrics.activeRuns ?? "n/a"}\n`);
      process.stdout.write(`  completedRuns: ${metrics.completedRuns ?? "n/a"}\n`);
      process.stdout.write(`  errorRuns: ${metrics.errorRuns ?? "n/a"}\n`);
      const cbStates = metrics.circuitBreakersByAgent ?? {};
      const cbEntries = Object.entries(cbStates);
      if (cbEntries.length > 0) {
        process.stdout.write(`  circuitBreakers:\n`);
        for (const [agent, state] of cbEntries) {
          process.stdout.write(`    ${agent}: ${JSON.stringify(state)}\n`);
        }
      }
      const recentModels = metrics.recentModels ?? [];
      if (recentModels.length > 0) {
        process.stdout.write(`  recentModels: ${recentModels.join(", ")}\n`);
      }
    }
  }
  process.exit(0);
}

// ── Clear model cache command ─────────────────────────────────────────────────

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

// ── Session management subcommands ───────────────────────────────────────────

async function handleListSessions(): Promise<void> {
  const sessions = await listSessions();
  if (sessions.length === 0) {
    process.stdout.write("No sessions found.\n");
    process.exit(0);
  }

  const active = sessions.filter((s) => !s.trashed);
  const trashed = sessions.filter((s) => s.trashed);

  const fmt = (s: (typeof sessions)[0]) =>
    `  ${s.sessionId}  ${s.model.padEnd(40)}  turns:${String(s.turnCount).padStart(3)}  ${s.updatedAt.slice(0, 16).replace("T", " ")}  ${s.trashed ? "[TRASHED]" : ""}`;

  if (active.length > 0) {
    process.stdout.write(`Active sessions (${active.length}):\n`);
    for (const s of active) process.stdout.write(fmt(s) + "\n");
  }
  if (trashed.length > 0) {
    process.stdout.write(`\nTrashed sessions (${trashed.length}):\n`);
    for (const s of trashed) process.stdout.write(fmt(s) + "\n");
  }
  process.exit(0);
}

async function handleTrashSession(argv: string[]): Promise<void> {
  const idx = argv.indexOf("--trash-session");
  const sessionId = argv[idx + 1] ?? "";
  if (!sessionId) {
    process.stderr.write("orager: --trash-session requires a session ID.\n");
    process.exit(1);
  }
  const ok = await trashSession(sessionId);
  if (ok) {
    process.stdout.write(`Session ${sessionId} marked as trashed.\n`);
  } else {
    process.stderr.write(`Session ${sessionId} not found.\n`);
    process.exit(1);
  }
  process.exit(0);
}

async function handleRestoreSession(argv: string[]): Promise<void> {
  const idx = argv.indexOf("--restore-session");
  const sessionId = argv[idx + 1] ?? "";
  if (!sessionId) {
    process.stderr.write("orager: --restore-session requires a session ID.\n");
    process.exit(1);
  }
  const ok = await restoreSession(sessionId);
  if (ok) {
    process.stdout.write(`Session ${sessionId} restored.\n`);
  } else {
    process.stderr.write(`Session ${sessionId} not found.\n`);
    process.exit(1);
  }
  process.exit(0);
}

async function handleDeleteSession(argv: string[]): Promise<void> {
  const idx = argv.indexOf("--delete-session");
  const sessionId = argv[idx + 1] ?? "";
  if (!sessionId) {
    process.stderr.write("orager: --delete-session requires a session ID.\n");
    process.exit(1);
  }
  await deleteSession(sessionId);
  process.stdout.write(`Session ${sessionId} deleted.\n`);
  process.exit(0);
}

async function handleRollbackSession(argv: string[]): Promise<void> {
  const idx = argv.indexOf("--rollback-session");
  const sessionId = argv[idx + 1] ?? "";
  if (!sessionId) {
    process.stderr.write("orager: --rollback-session requires a session ID.\n");
    process.exit(1);
  }
  const toIdx = argv.indexOf("--to-turn");
  if (toIdx === -1) {
    process.stderr.write("orager: --rollback-session requires --to-turn <n>.\n");
    process.exit(1);
  }
  const toTurn = parseInt(argv[toIdx + 1] ?? "", 10);
  if (isNaN(toTurn) || toTurn < 0) {
    process.stderr.write("orager: --to-turn must be a non-negative integer.\n");
    process.exit(1);
  }
  const result = await rollbackSession(sessionId, toTurn);
  if (!result.ok) {
    process.stderr.write(`Session ${sessionId} not found.\n`);
    process.exit(1);
  }
  if (result.newTurnCount === result.originalTurnCount) {
    process.stdout.write(
      `Session ${sessionId} unchanged (already at ${result.originalTurnCount} turn(s), requested to-turn=${toTurn}).\n`,
    );
  } else {
    process.stdout.write(
      `Session ${sessionId} rolled back from turn ${result.originalTurnCount} to turn ${result.newTurnCount}.\n`,
    );
  }
  process.exit(0);
}

async function handleSearchSessions(argv: string[]): Promise<void> {
  const idx = argv.indexOf("--search-sessions");
  const query = argv[idx + 1] ?? "";
  if (!query) {
    process.stderr.write("orager: --search-sessions requires a query string.\n");
    process.exit(1);
  }
  const results = await searchSessions(query);
  if (results.length === 0) {
    process.stdout.write(`No sessions found matching: ${query}\n`);
  } else {
    for (const s of results) {
      process.stdout.write(`${s.sessionId}  ${s.model}  ${s.updatedAt.slice(0, 10)}  ${s.cwd}\n`);
    }
  }
  process.exit(0);
}

async function handleDeleteTrashed(): Promise<void> {
  const result = await deleteTrashedSessions();
  process.stdout.write(
    `Deleted ${result.deleted} trashed session(s). Active sessions kept: ${result.kept}. Errors: ${result.errors}.\n`,
  );
  process.exit(0);
}

// ── Prune subcommand ──────────────────────────────────────────────────────────

async function handlePrune(argv: string[]): Promise<void> {
  // Parse --older-than <value> where value is e.g. "30d", "7d", "24h", "1h"
  let olderThanMs = 30 * 24 * 60 * 60 * 1000; // default: 30 days
  const idx = argv.indexOf("--older-than");
  if (idx !== -1) {
    const raw = argv[idx + 1] ?? "";
    const match = /^(\d+(?:\.\d+)?)(d|h|m)$/.exec(raw);
    if (match) {
      const n = parseFloat(match[1]);
      const unit = match[2];
      if (unit === "d") olderThanMs = n * 24 * 60 * 60 * 1000;
      else if (unit === "h") olderThanMs = n * 60 * 60 * 1000;
      else if (unit === "m") olderThanMs = n * 60 * 1000;
    } else {
      process.stderr.write(
        `orager: invalid --older-than value "${raw}". Use e.g. 30d, 7d, 24h, 1h.\n`
      );
      process.exit(1);
    }
  }

  const days = (olderThanMs / (24 * 60 * 60 * 1000)).toFixed(1);
  process.stderr.write(`[orager] pruning sessions older than ${days} day(s)...\n`);

  const result = await pruneOldSessions(olderThanMs);
  process.stdout.write(
    `Pruned ${result.deleted} session(s). Kept ${result.kept}. Errors: ${result.errors}.\n`
  );
  process.exit(0);
}

// ── Sessions table command ───────────────────────────────────────────────────

async function handleSessionsCommand(argv: string[]): Promise<void> {
  const jsonMode = argv.includes("--json");

  const port = await readDaemonPort();
  if (!port) {
    process.stderr.write("Daemon is not running\n");
    process.exit(1);
  }

  const url = `http://127.0.0.1:${port}`;

  // Mint JWT for authenticated requests
  let token: string;
  try {
    const keyData = await fs.readFile(KEY_PATH, "utf8");
    token = mintJwt(keyData.trim(), "orager-cli-sessions");
  } catch {
    process.stderr.write("orager: could not read signing key\n");
    process.exit(1);
  }

  // Fetch sessions list
  let sessions: Array<{
    sessionId: string;
    updatedAt: string;
    turnCount: number;
    model: string;
  }>;
  try {
    const res = await fetch(`${url}/sessions?limit=20`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      process.stderr.write(`orager: GET /sessions returned HTTP ${res.status}\n`);
      process.exit(1);
    }
    const body = await res.json() as { sessions: typeof sessions };
    sessions = body.sessions ?? [];
  } catch {
    process.stderr.write("Daemon is not running\n");
    process.exit(1);
  }

  // Fetch cost for each session
  const costMap = new Map<string, number>();
  await Promise.all(
    sessions.map(async (s) => {
      try {
        const res = await fetch(`${url}/sessions/${encodeURIComponent(s.sessionId)}/cost`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
          const body = await res.json() as { cumulativeCostUsd: number };
          costMap.set(s.sessionId, body.cumulativeCostUsd ?? 0);
        }
      } catch { /* non-fatal */ }
    }),
  );

  if (jsonMode) {
    const result = sessions.map((s) => ({
      sessionId: s.sessionId,
      lastRunAt: s.updatedAt,
      cumulativeCostUsd: costMap.get(s.sessionId) ?? 0,
      runCount: s.turnCount,
    }));
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.exit(0);
  }

  // Print formatted table
  const header = `${"SESSION ID".padEnd(22)} ${"LAST RUN AT".padEnd(20)} ${"COST USD".padStart(10)} ${"TURNS".padStart(6)}`;
  process.stdout.write(header + "\n");
  process.stdout.write("-".repeat(header.length) + "\n");

  for (const s of sessions) {
    const id = s.sessionId.slice(0, 20).padEnd(22);
    const lastRun = (s.updatedAt ?? "").slice(0, 16).replace("T", " ").padEnd(20);
    const cost = `$${(costMap.get(s.sessionId) ?? 0).toFixed(4)}`.padStart(10);
    const turns = String(s.turnCount).padStart(6);
    process.stdout.write(`${id} ${lastRun} ${cost} ${turns}\n`);
  }
  process.exit(0);
}

// ── Memory subcommand ─────────────────────────────────────────────────────────

async function handleMemorySubcommand(argv: string[]): Promise<void> {
  const subIdx = argv.indexOf("memory");
  const subArgs = argv.slice(subIdx + 1);
  const sub = subArgs[0];

  if (sub === "export") {
    const keyIdx = subArgs.indexOf("--key");
    const memoryKey = keyIdx !== -1 ? (subArgs[keyIdx + 1] ?? "") : "";
    if (!memoryKey) {
      process.stderr.write("orager memory export --key <memoryKey>\n");
      process.exit(1);
    }
    const store = await loadMemoryStoreAny(memoryKey);
    process.stdout.write(JSON.stringify(store, null, 2) + "\n");
    process.exit(0);
  }

  if (sub === "list") {
    if (isSqliteMemoryEnabled()) {
      const keys = listMemoryKeysSqlite();
      for (const k of keys) process.stdout.write(k + "\n");
    } else {
      // List files in MEMORY_DIR, strip .json suffix
      try {
        const entries = await fs.readdir(MEMORY_DIR);
        for (const entry of entries) {
          if (entry.endsWith(".json")) {
            process.stdout.write(entry.slice(0, -5) + "\n");
          }
        }
      } catch {
        // Directory doesn't exist — no memory keys
      }
    }
    process.exit(0);
  }

  if (sub === "clear") {
    const keyIdx = subArgs.indexOf("--key");
    const memoryKey = keyIdx !== -1 ? (subArgs[keyIdx + 1] ?? "") : "";
    if (!memoryKey) {
      process.stderr.write("orager memory clear --key <memoryKey> [--yes]\n");
      process.exit(1);
    }
    const skipConfirm = subArgs.includes("--yes");
    if (!skipConfirm) {
      // Interactive confirmation
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((resolve) => {
        rl.question(`Clear all memory entries for key "${memoryKey}"? [y/N] `, resolve);
      });
      rl.close();
      if (answer.trim().toLowerCase() !== "y") {
        process.stdout.write("Aborted.\n");
        process.exit(0);
      }
    }
    if (isSqliteMemoryEnabled()) {
      const deleted = clearMemoryStoreSqlite(memoryKey);
      process.stdout.write(`Cleared ${deleted} entry/entries for key "${memoryKey}".\n`);
    } else {
      const { MEMORY_DIR: memDir } = await import("./memory.js");
      const sanitized = memoryKey.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
      const filePath = path.join(memDir, `${sanitized}.json`);
      try {
        await fs.unlink(filePath);
        process.stdout.write(`Cleared memory for key "${memoryKey}".\n`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          process.stdout.write(`No memory found for key "${memoryKey}".\n`);
        } else {
          process.stderr.write(`Error: ${(err as Error).message}\n`);
          process.exit(1);
        }
      }
    }
    process.exit(0);
  }

  process.stderr.write("Usage: orager memory <export|list|clear> [options]\n");
  process.exit(1);
}

// ── Config file loading ───────────────────────────────────────────────────────
// When --config-file <path> is passed (e.g. from the paperclip adapter),
// read the JSON config, delete the file immediately (it may contain secrets),
// then inject the decoded options into argv so the rest of parseArgs works
// without modification. The file is chmod 600 by the writer; we delete it
// before doing anything else to minimise the window where it is readable.

interface ConfigFileSchema {
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
}

/**
 * Read the config file at `filePath`, delete it immediately, and return
 * an argv fragment equivalent to the flags the config represents.
 */
async function loadConfigFile(filePath: string): Promise<{
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
}> {
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

  const result: {
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
  } = { args };
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
  // Memory — pass via result object so they can be stored in globalThis
  if (cfg.memory !== undefined) result.memory = cfg.memory;
  if (typeof cfg.memoryKey === "string" && cfg.memoryKey.trim()) result.memoryKey = cfg.memoryKey.trim();
  if (typeof cfg.memoryMaxChars === "number" && cfg.memoryMaxChars > 0) result.memoryMaxChars = cfg.memoryMaxChars;
  return result;
}

// ── User config file (~/.orager/config.json) ─────────────────────────────────
// Loaded once at startup as base defaults. CLI flags and --config-file always
// win over user config (user config is prepended to argv so it comes first).
// The file is NOT deleted — it is a persistent configuration file.

const USER_CONFIG_PATH = path.join(os.homedir(), ".orager", "config.json");

async function loadUserConfig(): Promise<{
  args: string[];
  [key: string]: unknown;
}> {
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

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await initTelemetry();

  let argv = process.argv.slice(2);

  // ── Version ──────────────────────────────────────────────────────────────────
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`orager ${_ORAGER_VERSION}\n`);
    process.exit(0);
  }

  // ── Help ─────────────────────────────────────────────────────────────────────
  if (argv.includes("--help") || argv.includes("-h")) {
    handleHelp();
    return;
  }

  // ── Setup wizard ─────────────────────────────────────────────────────────────
  if (argv[0] === "setup") {
    await runSetupWizard(argv.slice(1));
    return;
  }

  // ── Memory subcommand ─────────────────────────────────────────────────────
  if (argv[0] === "memory") {
    await handleMemorySubcommand(argv);
    return;
  }

  // ── Daemon mode ─────────────────────────────────────────────────────────────
  if (argv.includes("--serve")) {
    const apiKey =
      process.env["OPENROUTER_API_KEY"] ?? process.env["ORAGER_API_KEY"] ?? "";
    if (!apiKey) {
      process.stderr.write("orager: API key not set. Export OPENROUTER_API_KEY or ORAGER_API_KEY.\n");
      process.exit(1);
    }
    const portIdx = argv.indexOf("--port");
    const port = portIdx !== -1 ? parseInt(argv[portIdx + 1] ?? "3456", 10) : 3456;

    const maxConcIdx = argv.indexOf("--max-concurrent");
    const maxConcurrent = maxConcIdx !== -1 ? parseInt(argv[maxConcIdx + 1] ?? "3", 10) : 3;

    const idleIdx = argv.indexOf("--idle-timeout");
    let idleTimeoutMs = 30 * 60 * 1000; // default 30 min
    if (idleIdx !== -1) {
      const raw = argv[idleIdx + 1] ?? "";
      const m = /^(\d+(?:\.\d+)?)(m|h)$/.exec(raw);
      if (m) idleTimeoutMs = parseFloat(m[1]) * (m[2] === "h" ? 3600_000 : 60_000);
    }

    const modelIdx = argv.indexOf("--model");
    const model = modelIdx !== -1 ? (argv[modelIdx + 1] ?? "deepseek/deepseek-chat-v3-2") : "deepseek/deepseek-chat-v3-2";

    const allowedCwdIdxs: number[] = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "--allowed-cwd") allowedCwdIdxs.push(i);
    }
    const allowedCwdPrefixes = allowedCwdIdxs
      .map((i) => argv[i + 1])
      .filter((s): s is string => !!s);

    await startDaemon({ port, maxConcurrent, idleTimeoutMs, apiKey, model, allowedCwdPrefixes: allowedCwdPrefixes.length > 0 ? allowedCwdPrefixes : undefined });
    // startDaemon never returns (server keeps process alive)
    return;
  }

  // ── Status command ────────────────────────────────────────────────────────
  if (argv.includes("--status")) { await handleStatus(argv.includes("--json")); return; }

  // ── Sessions table command ────────────────────────────────────────────────
  if (argv.includes("--sessions")) { await handleSessionsCommand(argv); return; }

  // ── Rotate-key command ────────────────────────────────────────────────────
  if (argv.includes("--rotate-key")) {
    const port = await readDaemonPort();
    if (!port) {
      process.stderr.write("orager: daemon not running (no port file found).\n");
      process.exit(1);
    }
    try {
      const keyData = await fs.readFile(KEY_PATH, "utf8");
      const signingKey = keyData.trim();
      const token = mintJwt(signingKey, "orager-cli-rotate-key");
      const res = await fetch(`http://127.0.0.1:${port}/rotate-key`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        const body = await res.text();
        process.stderr.write(`orager: rotate-key failed (HTTP ${res.status}): ${body}\n`);
        process.exit(1);
      }
      const result = await res.json() as { rotated: boolean; previousKeyExpiresAt: string };
      process.stdout.write(`Signing key rotated successfully.\n`);
      process.stdout.write(`Old key accepted until: ${result.previousKeyExpiresAt}\n`);
    } catch (err) {
      process.stderr.write(`orager: rotate-key error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
    process.exit(0);
  }

  // Session management commands — no API key needed
  if (argv.includes("--list-sessions"))    { await handleListSessions();         return; }
  if (argv.includes("--search-sessions"))  { await handleSearchSessions(argv);  return; }
  if (argv.includes("--trash-session"))    { await handleTrashSession(argv);    return; }
  if (argv.includes("--restore-session"))  { await handleRestoreSession(argv);  return; }
  if (argv.includes("--delete-session"))   { await handleDeleteSession(argv);   return; }
  if (argv.includes("--delete-trashed"))   { await handleDeleteTrashed();       return; }
  if (argv.includes("--rollback-session")) { await handleRollbackSession(argv); return; }
  if (argv.includes("--prune-sessions"))   { await handlePrune(argv);           return; }
  if (argv.includes("--clear-model-cache")) { await handleClearModelCache(); return; }

  // ── User config (~/.orager/config.json) — base defaults ──────────────────
  // Loaded before CLI flags so that explicit args always win. The file is
  // NOT deleted and must not contain secrets (use config-file for those).
  {
    const userCfg = await loadUserConfig();
    // Prepend so CLI flags (and --config-file expansion below) override them
    if (userCfg.args.length > 0) {
      argv = [...userCfg.args, ...argv];
    }
    // Complex types that can't be argv tokens — set only when not already set
    const G = globalThis as Record<string, unknown>;
    if (userCfg.turnModelRules && !G.__oragerTurnModelRules)     G.__oragerTurnModelRules = userCfg.turnModelRules;
    if (userCfg.promptContent  && !G.__oragerPromptContent)      G.__oragerPromptContent  = userCfg.promptContent;
    if (userCfg.mcpServers     && !G.__oragerMcpServers)         G.__oragerMcpServers     = userCfg.mcpServers;
    if (userCfg.hooks          && !G.__oragerHooks)              G.__oragerHooks          = userCfg.hooks;
    if (userCfg.bashPolicy     && !G.__oragerBashPolicy)         G.__oragerBashPolicy     = userCfg.bashPolicy;
    if (userCfg.planMode   !== undefined && !G.__oragerPlanMode)   G.__oragerPlanMode   = userCfg.planMode;
    if (userCfg.injectContext !== undefined && !G.__oragerInjectContext) G.__oragerInjectContext = userCfg.injectContext;
    if (userCfg.tagToolOutputs !== undefined && !G.__oragerTagToolOutputs) G.__oragerTagToolOutputs = userCfg.tagToolOutputs;
    if (userCfg.trackFileChanges !== undefined && !G.__oragerTrackFileChanges) G.__oragerTrackFileChanges = userCfg.trackFileChanges;
    if (userCfg.enableBrowserTools !== undefined && !G.__oragerEnableBrowserTools) G.__oragerEnableBrowserTools = userCfg.enableBrowserTools;
    if (userCfg.memory !== undefined && !G.__oragerMemory) G.__oragerMemory = userCfg.memory;
    if (userCfg.memoryKey && !G.__oragerMemoryKey)         G.__oragerMemoryKey = userCfg.memoryKey;
    if (userCfg.memoryMaxChars !== undefined && !G.__oragerMemoryMaxChars) G.__oragerMemoryMaxChars = userCfg.memoryMaxChars;
    if (userCfg.apiKeys && !G.__oragerApiKeys)             G.__oragerApiKeys = userCfg.apiKeys;
    if (userCfg.webhookUrl && !G.__oragerWebhookUrl)       G.__oragerWebhookUrl = userCfg.webhookUrl;
    if (userCfg.maxCostUsdSoft !== undefined && !G.__oragerMaxCostUsdSoft) G.__oragerMaxCostUsdSoft = userCfg.maxCostUsdSoft;
  }

  // ── Config file expansion ──────────────────────────────────────────────────
  // If --config-file <path> is present, load the JSON config, delete the file,
  // and expand its contents into argv. This replaces the 50+ CLI args that
  // the adapter used to pass; the file is deleted before any further processing
  // so secrets are not left on disk.
  const cfIdx = argv.indexOf("--config-file");
  if (cfIdx !== -1) {
    const cfPath = argv[cfIdx + 1];
    if (!cfPath) {
      process.stderr.write("orager: --config-file requires a path argument\n");
      process.exit(1);
    }
    // Remove --config-file and its path from argv, then inject the expanded flags
    const remaining = [...argv.slice(0, cfIdx), ...argv.slice(cfIdx + 2)];
    const cfResult = await loadConfigFile(cfPath);
    argv = [...remaining, ...cfResult.args];
    // Store extras for later — they can't be represented as argv tokens
    if (cfResult.turnModelRules) {
      (globalThis as Record<string, unknown>).__oragerTurnModelRules = cfResult.turnModelRules;
    }
    if (cfResult.promptContent) {
      (globalThis as Record<string, unknown>).__oragerPromptContent = cfResult.promptContent;
    }
    if (cfResult.approvalAnswer !== undefined) {
      (globalThis as Record<string, unknown>).__oragerApprovalAnswer = cfResult.approvalAnswer;
    }
    if (cfResult.approvalMode !== undefined) {
      (globalThis as Record<string, unknown>).__oragerApprovalMode = cfResult.approvalMode;
    }
    if (cfResult.mcpServers) {
      (globalThis as Record<string, unknown>).__oragerMcpServers = cfResult.mcpServers;
    }
    if (cfResult.requireMcpServers) {
      (globalThis as Record<string, unknown>).__oragerRequireMcpServers = cfResult.requireMcpServers;
    }
    if (cfResult.toolTimeouts) {
      (globalThis as Record<string, unknown>).__oragerToolTimeouts = cfResult.toolTimeouts;
    }
    if (cfResult.maxSpawnDepth !== undefined) {
      (globalThis as Record<string, unknown>).__oragerMaxSpawnDepth = cfResult.maxSpawnDepth;
    }
    if (cfResult.maxIdenticalToolCallTurns !== undefined) {
      (globalThis as Record<string, unknown>).__oragerMaxIdenticalToolCallTurns = cfResult.maxIdenticalToolCallTurns;
    }
    if (cfResult.toolErrorBudgetHardStop !== undefined) {
      (globalThis as Record<string, unknown>).__oragerToolErrorBudgetHardStop = cfResult.toolErrorBudgetHardStop;
    }
    if (cfResult.response_format) {
      (globalThis as Record<string, unknown>).__oragerResponseFormat = cfResult.response_format;
    }
    if (cfResult.hooks) {
      (globalThis as Record<string, unknown>).__oragerHooks = cfResult.hooks;
    }
    if (cfResult.planMode !== undefined) {
      (globalThis as Record<string, unknown>).__oragerPlanMode = cfResult.planMode;
    }
    if (cfResult.injectContext !== undefined) {
      (globalThis as Record<string, unknown>).__oragerInjectContext = cfResult.injectContext;
    }
    if (cfResult.tagToolOutputs !== undefined) {
      (globalThis as Record<string, unknown>).__oragerTagToolOutputs = cfResult.tagToolOutputs;
    }
    if (cfResult.readProjectInstructions !== undefined) {
      (globalThis as Record<string, unknown>).__oragerReadProjectInstructions = cfResult.readProjectInstructions;
    }
    if (cfResult.summarizePrompt) {
      (globalThis as Record<string, unknown>).__oragerSummarizePrompt = cfResult.summarizePrompt;
    }
    if (cfResult.summarizeFallbackKeep !== undefined) {
      (globalThis as Record<string, unknown>).__oragerSummarizeFallbackKeep = cfResult.summarizeFallbackKeep;
    }
    if (cfResult.webhookUrl) {
      (globalThis as Record<string, unknown>).__oragerWebhookUrl = cfResult.webhookUrl;
    }
    if (cfResult.bashPolicy) {
      (globalThis as Record<string, unknown>).__oragerBashPolicy = cfResult.bashPolicy;
    }
    if (cfResult.trackFileChanges !== undefined) {
      (globalThis as Record<string, unknown>).__oragerTrackFileChanges = cfResult.trackFileChanges;
    }
    if (cfResult.enableBrowserTools !== undefined) {
      (globalThis as Record<string, unknown>).__oragerEnableBrowserTools = cfResult.enableBrowserTools;
    }
    if (cfResult.maxCostUsdSoft !== undefined) {
      (globalThis as Record<string, unknown>).__oragerMaxCostUsdSoft = cfResult.maxCostUsdSoft;
    }
    if (cfResult.approvalTimeoutMs !== undefined) {
      (globalThis as Record<string, unknown>).__oragerApprovalTimeoutMs = cfResult.approvalTimeoutMs;
    }
    if (cfResult.hookTimeoutMs !== undefined) {
      (globalThis as Record<string, unknown>).__oragerHookTimeoutMs = cfResult.hookTimeoutMs;
    }
    if (cfResult.hookErrorMode !== undefined) {
      (globalThis as Record<string, unknown>).__oragerHookErrorMode = cfResult.hookErrorMode;
    }
    if (cfResult.apiKeys && cfResult.apiKeys.length > 0) {
      (globalThis as Record<string, unknown>).__oragerApiKeys = cfResult.apiKeys;
    }
    if (cfResult.memory !== undefined) {
      (globalThis as Record<string, unknown>).__oragerMemory = cfResult.memory;
    }
    if (cfResult.memoryKey) {
      (globalThis as Record<string, unknown>).__oragerMemoryKey = cfResult.memoryKey;
    }
    if (cfResult.memoryMaxChars !== undefined) {
      (globalThis as Record<string, unknown>).__oragerMemoryMaxChars = cfResult.memoryMaxChars;
    }
  }

  // Resolve API key
  const apiKey =
    process.env["OPENROUTER_API_KEY"] ?? process.env["ORAGER_API_KEY"] ?? "";

  if (!apiKey) {
    process.stderr.write(
      "orager: API key not set. Export OPENROUTER_API_KEY or ORAGER_API_KEY.\n"
    );
    process.exit(1);
  }

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

  // Keep session ID available for interrupt handler
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

  // ── CLI output tracking ─────────────────────────────────────────────────────
  const runStart = Date.now();
  let cliTurn = 0;
  let cliTurnStart = Date.now();

  function makeOnEmit(baseEmit: typeof emit) {
    return (event: Parameters<typeof emit>[0]) => {
      baseEmit(event);

      if (event.type === "assistant") {
        // Start timing this turn
        if (cliTurn === 0) cliTurnStart = Date.now();
        else cliTurnStart = Date.now();
      }

      if (event.type === "tool") {
        // A turn completed (tool calls were executed)
        const elapsed = ((Date.now() - cliTurnStart) / 1000).toFixed(1);
        // We don't have per-turn cost here — show what we have from result
        process.stderr.write(
          `\r[turn ${cliTurn + 1} | ${elapsed}s]\x1b[K\n`,
        );
        cliTurn++;
        cliTurnStart = Date.now();
      }

      if (event.type === "result") {
        const totalElapsedS = Math.round((Date.now() - runStart) / 1000);
        const promptTokens = event.usage.input_tokens;
        const completionTokens = event.usage.output_tokens;
        const cachedTokens = event.usage.cache_read_input_tokens;
        const totalTokens = promptTokens + completionTokens;
        const cachedPct = totalTokens > 0
          ? Math.round((cachedTokens / totalTokens) * 100)
          : 0;
        const cost = event.total_cost_usd;
        const sessionShort = event.session_id.slice(0, 8);

        process.stderr.write(
          `\r\x1b[K` +
          `─────────────────────────────────────\n` +
          `  Turns:    ${event.turnCount ?? cliTurn}\n` +
          `  Tokens:   ${promptTokens.toLocaleString()} prompt / ${completionTokens.toLocaleString()} completion\n` +
          `  Cached:   ${cachedTokens.toLocaleString()} (${cachedPct}%)\n` +
          `  Cost:     ~$${cost.toFixed(4)}\n` +
          `  Duration: ${totalElapsedS}s\n` +
          `  Session:  ${sessionShort}...\n` +
          `─────────────────────────────────────\n`,
        );
      }
    };
  }

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
    onEmit: makeOnEmit(emit),
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
    turnModelRules: (globalThis as Record<string, unknown>).__oragerTurnModelRules as TurnModelRule[] | undefined,
    promptContent: (globalThis as Record<string, unknown>).__oragerPromptContent as UserMessageContentBlock[] | undefined,
    approvalAnswer: ((globalThis as Record<string, unknown>).__oragerApprovalAnswer as { choiceKey: string; toolCallId: string } | null | undefined) ?? opts.approvalAnswer ?? null,
    approvalMode: ((globalThis as Record<string, unknown>).__oragerApprovalMode as "tty" | "question" | undefined) ?? opts.approvalMode,
    settingsFile: opts.settingsFile,
    mcpServers: (globalThis as Record<string, unknown>).__oragerMcpServers as AgentLoopOptions["mcpServers"] | undefined,
    requireMcpServers: (globalThis as Record<string, unknown>).__oragerRequireMcpServers as string[] | undefined,
    toolTimeouts: (globalThis as Record<string, unknown>).__oragerToolTimeouts as Record<string, number> | undefined,
    maxSpawnDepth: (globalThis as Record<string, unknown>).__oragerMaxSpawnDepth as number | undefined ?? opts.maxSpawnDepth,
    maxIdenticalToolCallTurns: (globalThis as Record<string, unknown>).__oragerMaxIdenticalToolCallTurns as number | undefined ?? opts.maxIdenticalToolCallTurns,
    toolErrorBudgetHardStop: (globalThis as Record<string, unknown>).__oragerToolErrorBudgetHardStop as boolean | undefined ?? opts.toolErrorBudgetHardStop,
    response_format: (globalThis as Record<string, unknown>).__oragerResponseFormat as AgentLoopOptions["response_format"] | undefined,
    hooks: (globalThis as Record<string, unknown>).__oragerHooks as AgentLoopOptions["hooks"] | undefined,
    planMode: (globalThis as Record<string, unknown>).__oragerPlanMode as boolean | undefined ?? opts.planMode,
    injectContext: (globalThis as Record<string, unknown>).__oragerInjectContext as boolean | undefined ?? opts.injectContext,
    tagToolOutputs: (globalThis as Record<string, unknown>).__oragerTagToolOutputs as boolean | undefined ?? opts.tagToolOutputs,
    readProjectInstructions: (globalThis as Record<string, unknown>).__oragerReadProjectInstructions as boolean | undefined,
    summarizePrompt: (globalThis as Record<string, unknown>).__oragerSummarizePrompt as string | undefined,
    summarizeFallbackKeep: (globalThis as Record<string, unknown>).__oragerSummarizeFallbackKeep as number | undefined,
    webhookUrl: (globalThis as Record<string, unknown>).__oragerWebhookUrl as string | undefined,
    bashPolicy: (globalThis as Record<string, unknown>).__oragerBashPolicy as AgentLoopOptions["bashPolicy"] | undefined,
    trackFileChanges: (globalThis as Record<string, unknown>).__oragerTrackFileChanges as boolean | undefined ?? opts.trackFileChanges,
    enableBrowserTools: (globalThis as Record<string, unknown>).__oragerEnableBrowserTools as boolean | undefined ?? opts.enableBrowserTools,
    maxCostUsdSoft: (globalThis as Record<string, unknown>).__oragerMaxCostUsdSoft as number | undefined,
    approvalTimeoutMs: (globalThis as Record<string, unknown>).__oragerApprovalTimeoutMs as number | undefined,
    hookTimeoutMs: (globalThis as Record<string, unknown>).__oragerHookTimeoutMs as number | undefined,
    hookErrorMode: (globalThis as Record<string, unknown>).__oragerHookErrorMode as AgentLoopOptions["hookErrorMode"] | undefined ?? opts.hookErrorMode,
    timeoutSec: opts.timeoutSec,
    apiKeys: (globalThis as Record<string, unknown>).__oragerApiKeys as string[] | undefined,
    requiredEnvVars: opts.requiredEnvVars,
    memory: (globalThis as Record<string, unknown>).__oragerMemory as boolean | undefined,
    memoryKey: (globalThis as Record<string, unknown>).__oragerMemoryKey as string | undefined,
    memoryMaxChars: (globalThis as Record<string, unknown>).__oragerMemoryMaxChars as number | undefined,
  };

  if (opts.profile) {
    loopOpts = await applyProfileAsync(opts.profile, loopOpts);
  }

  await runAgentLoop(loopOpts);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`orager: fatal error: ${message}\n`);
  process.exit(1);
});
