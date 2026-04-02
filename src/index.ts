#!/usr/bin/env node
import process from "node:process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  compactSession,
  forkSession,
  loadLatestCheckpointByContextId,
} from "./session.js";
import type { CliOptions, EmitResultEvent, TurnModelRule, UserMessageContentBlock, AgentLoopOptions } from "./types.js";
import { startDaemon, readDaemonPort } from "./daemon.js";
import { mintJwt, KEY_PATH } from "./jwt.js";
import { applyProfileAsync } from "./profiles.js";
import { initTelemetry } from "./telemetry.js";
import { runSetupWizard } from "./setup.js";
import { startUiServer } from "./ui-server.js";
import { createRequire } from "node:module";
import { loadMemoryStoreAny, MEMORY_DIR } from "./memory.js";
import { parseArgs, readStdin } from "./cli/parse-args.js";
import { loadConfigFile, loadUserConfig } from "./cli/config-loading.js";
import {
  isSqliteMemoryEnabled,
  listMemoryKeysSqlite,
  clearMemoryStoreSqlite,
  loadMasterContext,
  getMemoryEntryCount,
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

// ── Arg parsing + stdin — see ./cli/parse-args.ts ────────────────────────────
// parseArgs and readStdin are imported at the top of this file.


// ── Global CLI instance lock ────────────────────────────────────────────────
// Prevents multiple orager CLI processes from running simultaneously.
// Skipped when spawned by the adapter (--config-file) or the daemon,
// or when ORAGER_SKIP_PID_LOCK=1 (testing).

const CLI_PID_FILE = path.join(os.homedir(), ".orager", "orager.pid");
let _cliLockHeld = false;

async function acquireCliPidLock(): Promise<void> {
  const pidData = JSON.stringify({ pid: process.pid, startedAt: Date.now() });
  await fs.mkdir(path.dirname(CLI_PID_FILE), { recursive: true });

  // Try exclusive create
  try {
    await fs.writeFile(CLI_PID_FILE, pidData, { encoding: "utf8", mode: 0o600, flag: "wx" });
    _cliLockHeld = true;
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }

  // File exists — check if the holding process is still alive
  try {
    const existing = await fs.readFile(CLI_PID_FILE, "utf8");
    const parsed = JSON.parse(existing) as { pid: number };
    try {
      process.kill(parsed.pid, 0);
      // Process is alive — reject
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

  // Stale lock — unlink and retry (narrow TOCTOU with exclusive create)
  for (let retry = 0; retry < 3; retry++) {
    await fs.unlink(CLI_PID_FILE).catch(() => {});
    try {
      await fs.writeFile(CLI_PID_FILE, pidData, { encoding: "utf8", mode: 0o600, flag: "wx" });
      _cliLockHeld = true;
      return;
    } catch {
      // Another process won the race — check if alive
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

// ── Signal handling ──────────────────────────────────────────────────────────

let interruptSessionId = "";
let interruptUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };

function handleInterrupt(signal: string): void {
  process.stderr.write(`\n[orager] received ${signal}, shutting down\n`);
  void releaseCliPidLock();

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
  --max-turns <n>           Maximum agent turns (default: 20)
  --timeout-sec <n>         Run-level timeout in seconds (default: 300)
  --resume <id>             Resume an existing session
  --cwd <path>              Working directory for the agent
  --print                   Print result to stdout (non-interactive mode)
  --verbose                 Verbose logging

DAEMON
  --serve                   Start the HTTP daemon (persistent server mode)
  --port <n>                Daemon port (default: 3456)
  --max-concurrent <n>      Max concurrent runs (default: 3)
  --idle-timeout <duration> Idle shutdown timeout, e.g. 30s, 30m, 1h (default: 30m)
  --status                  Check if the daemon is running
  --status --json           Machine-readable status output
  --clear-model-cache       Delete cached model metadata (force fresh fetch)

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
  --fork-session <id>       Create a branch of a session (like --fork-session in Claude Code)
                              --at-turn <n>   Fork at a specific turn (default: latest)
                              --resume        Immediately resume the forked session
  --compact-session <id>    Summarize a session in-place (like /compact in Claude Code)
  --prune-sessions          Delete sessions older than 30 days (default)
                              --older-than <value>  Override age threshold, e.g. 7d, 24h, 1h
  --abandoned-sessions      Show runs that were abandoned during the last daemon crash/restart

TOOLS & SAFETY
  --dangerously-skip-permissions  Skip all tool-use permission checks
  --require-approval              Require approval for all tool calls
  --require-approval-for <tools>  Require approval for specific tools (comma-separated)
  --bash-policy <json>            Bash tool policy (blocked commands, env vars)
  --settings-file <path>          Path to a custom settings JSON file
  --auto-memory                   Enable auto-memory (write_memory/read_memory tools that persist notes to CLAUDE.md)

COST
  --max-cost-usd <n>        Hard stop if cost exceeds this value
  --max-cost-usd-soft <n>   Warn (but continue) when cost exceeds this value

OTHER
  --version, -v             Print version and exit
  --help, -h                Print this help and exit
  setup                     Run the interactive setup wizard
  setup --check             Validate config and test the API key
  ui [--port <n>]           Start the browser-based UI server (default port: 3457)

ENVIRONMENT
  PROTOCOL_API_KEY          LLM provider API key (required)
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
    keyInfo?: {
      label?: string;
      disabled?: boolean;
      remaining?: number | null;
      usage?: number;
      limit?: number | null;
      isUnlimited?: boolean;
    } | null;
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
      if (metrics.keyInfo !== undefined) out["credits"] = metrics.keyInfo;
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
      const ki = metrics.keyInfo;
      if (ki) {
        const credLine = ki.isUnlimited
          ? `  credits: unlimited (key: ${ki.label ?? "?"})`
          : ki.remaining !== null && ki.remaining !== undefined
            ? `  credits: $${ki.remaining.toFixed(4)} remaining of $${(ki.limit ?? 0).toFixed(2)} (key: ${ki.label ?? "?"})`
            : `  credits: $${(ki.usage ?? 0).toFixed(4)} used (key: ${ki.label ?? "?"})`;
        process.stdout.write(credLine + "\n");
        if (ki.disabled) {
          process.stdout.write("  WARNING: API key is disabled\n");
        }
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
    `  ${s.sessionId}  ${s.model.slice(0, 40).padEnd(40)}  turns:${String(s.turnCount).padStart(3)}  ${s.updatedAt.slice(0, 16).replace("T", " ")}  ${s.trashed ? "[TRASHED]" : ""}`;

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

// P-09: Fork a session — creates a new session branched from an existing one.
async function handleForkSession(argv: string[]): Promise<{ sessionId: string; resume: boolean } | never> {
  const idx = argv.indexOf("--fork-session");
  const sourceId = argv[idx + 1] ?? "";
  if (!sourceId) {
    process.stderr.write("orager: --fork-session requires a session ID.\n");
    process.exit(1);
  }

  const atTurnIdx = argv.indexOf("--at-turn");
  const atTurn = atTurnIdx !== -1
    ? parseInt(argv[atTurnIdx + 1] ?? "", 10)
    : undefined;
  if (atTurn !== undefined && (isNaN(atTurn) || atTurn < 0)) {
    process.stderr.write("orager: --at-turn must be a non-negative integer.\n");
    process.exit(1);
  }

  const shouldResume = argv.includes("--resume");

  try {
    const result = await forkSession(sourceId, atTurn !== undefined ? { atTurn } : undefined);
    process.stdout.write(
      `Forked session ${result.forkedFrom} → ${result.sessionId} (at turn ${result.atTurn}).\n`,
    );
    if (shouldResume) {
      // Return the new session ID so the caller can resume it
      return { sessionId: result.sessionId, resume: true };
    }
    process.exit(0);
  } catch (err) {
    process.stderr.write(`orager: fork failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

async function handleSearchSessions(argv: string[]): Promise<void> {
  const idx = argv.indexOf("--search-sessions");
  const query = argv[idx + 1] ?? "";
  if (!query) {
    process.stderr.write("orager: --search-sessions requires a query string.\n");
    process.exit(1);
  }
  const limitIdx = argv.indexOf("--limit");
  const limit = Math.min(
    Math.max(1, parseInt((limitIdx !== -1 && argv[limitIdx + 1]) ? argv[limitIdx + 1]! : "20", 10) || 20),
    100,
  );
  const offsetIdx = argv.indexOf("--offset");
  const offset = Math.max(0, parseInt((offsetIdx !== -1 && argv[offsetIdx + 1]) ? argv[offsetIdx + 1]! : "0", 10) || 0);
  const results = await searchSessions(query, limit, offset);
  if (results.length === 0) {
    process.stdout.write(`No sessions found matching: ${query}${offset > 0 ? ` (offset: ${offset})` : ""}\n`);
  } else {
    process.stdout.write(`Found ${results.length} session(s) matching "${query}" (limit: ${limit}, offset: ${offset}):\n`);
    for (const s of results) {
      process.stdout.write(`  ${s.sessionId}  ${s.model.slice(0, 40).padEnd(40)}  turns:${String(s.turnCount).padStart(3)}  ${s.updatedAt.slice(0, 16).replace("T", " ")}  ${s.cwd}\n`);
    }
  }
  process.exit(0);
}

async function handleCompactSession(argv: string[]): Promise<void> {
  const idx = argv.indexOf("--compact-session");
  const sessionId = argv[idx + 1] ?? "";
  if (!sessionId) {
    process.stderr.write("orager: --compact-session requires a session ID.\n");
    process.exit(1);
  }
  const apiKey = (process.env["PROTOCOL_API_KEY"] ?? "").trim();
  if (!apiKey) {
    process.stderr.write("orager: --compact-session requires PROTOCOL_API_KEY to be set.\n");
    process.exit(1);
  }
  // Optional: --model <id> or --summarize-model <id> for the summarization call
  const modelIdx = argv.indexOf("--model");
  const model = (modelIdx !== -1 && argv[modelIdx + 1]) ? argv[modelIdx + 1]! : "deepseek/deepseek-chat-v3-2";
  const sumModelIdx = argv.indexOf("--summarize-model");
  const summarizeModel = (sumModelIdx !== -1 && argv[sumModelIdx + 1]) ? argv[sumModelIdx + 1]! : undefined;

  process.stderr.write(`[orager] compacting session ${sessionId} using ${summarizeModel ?? model}…\n`);
  try {
    const result = await compactSession(sessionId, apiKey, model, { summarizeModel });
    process.stdout.write(`Session ${result.sessionId} compacted (${result.turnCount} turn(s) summarized).\n`);
    process.stdout.write(`Summary: ${result.summary}\n`);
  } catch (err) {
    process.stderr.write(`orager: compact failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
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

// ── Abandoned sessions subcommand ────────────────────────────────────────────

async function handleAbandonedSessions(): Promise<void> {
  const recoveryPath = path.join(os.homedir(), ".orager", "recovery.json");
  let raw: string;
  try {
    raw = await fs.readFile(recoveryPath, "utf8");
  } catch {
    process.stdout.write("No abandoned session record found.\n");
    return;
  }
  let recovery: { abandonedAt?: string; runs?: Array<{ runId?: string; abandonedAt?: string }> };
  try {
    recovery = JSON.parse(raw) as typeof recovery;
  } catch {
    process.stderr.write(`[orager] error: recovery file at ${recoveryPath} is corrupt\n`);
    process.exit(1);
    return;
  }
  const runs = recovery.runs ?? [];
  if (runs.length === 0) {
    process.stdout.write(`Abandoned at: ${recovery.abandonedAt ?? "unknown"} — no run details recorded.\n`);
  } else {
    process.stdout.write(`${runs.length} run(s) abandoned at ${recovery.abandonedAt ?? "unknown"}:\n`);
    for (const run of runs) {
      process.stdout.write(`  runId: ${run.runId ?? "unknown"}  abandonedAt: ${run.abandonedAt ?? recovery.abandonedAt ?? "unknown"}\n`);
    }
  }
  process.stdout.write(`\nTo resume an abandoned session, pass the session ID with --session <id>.\n`);
  process.stdout.write(`To clear this record: rm ${recoveryPath}\n`);
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
      const keys = await listMemoryKeysSqlite();
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
      const deleted = await clearMemoryStoreSqlite(memoryKey);
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

  if (sub === "inspect") {
    const keyIdx = subArgs.indexOf("--key");
    const memoryKey = keyIdx !== -1 ? (subArgs[keyIdx + 1] ?? "") : "";
    if (!memoryKey) {
      process.stderr.write("Usage: orager memory inspect --key <memoryKey>\n");
      process.exit(1);
    }

    const store = await loadMemoryStoreAny(memoryKey);
    const sortedEntries = [...store.entries].sort(
      (a, b) => b.importance - a.importance || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    process.stdout.write(`Memory key:  ${memoryKey}\n`);
    process.stdout.write(`Entries:     ${store.entries.length}\n`);

    if (isSqliteMemoryEnabled()) {
      const count = await getMemoryEntryCount(memoryKey);
      const master = await loadMasterContext(memoryKey);
      const checkpoint = await loadLatestCheckpointByContextId(memoryKey);

      process.stdout.write(`Non-expired: ${count}\n`);
      process.stdout.write(`Master ctx:  ${master ? `${master.length} chars` : "none"}\n`);
      process.stdout.write(
        `Checkpoint:  ${checkpoint
          ? `session ${checkpoint.threadId.slice(0, 8)}… turn ${checkpoint.lastTurn}`
          : "none"}\n`,
      );

      if (master) {
        process.stdout.write(`\n── Master context ──────────────────────────────────\n`);
        process.stdout.write(master.slice(0, 600) + (master.length > 600 ? "\n[...]" : "") + "\n");
      }

      if (checkpoint?.summary) {
        process.stdout.write(`\n── Last session summary ────────────────────────────\n`);
        process.stdout.write(
          checkpoint.summary.slice(0, 600) + (checkpoint.summary.length > 600 ? "\n[...]" : "") + "\n",
        );
      }
    }

    if (sortedEntries.length > 0) {
      process.stdout.write(`\n── Top entries (by importance) ─────────────────────\n`);
      for (const e of sortedEntries.slice(0, 10)) {
        const tags = e.tags?.length ? ` [${e.tags.join(",")}]` : "";
        const preview = e.content.length > 100 ? e.content.slice(0, 100) + "…" : e.content;
        process.stdout.write(`  imp:${e.importance}${tags}  ${preview}\n`);
      }
      if (sortedEntries.length > 10) {
        process.stdout.write(`  … and ${sortedEntries.length - 10} more\n`);
      }
    } else {
      process.stdout.write("No entries found.\n");
    }

    process.exit(0);
  }

  process.stderr.write("Usage: orager memory <export|list|clear|inspect> [options]\n");
  process.exit(1);
}

// ── Config file loading + user config — see ./cli/config-loading.ts ───────────
// loadConfigFile and loadUserConfig are imported at the top of this file.
export { loadConfigFile }; // re-export for backward compatibility (tests import from index)
export { runAgentWorkflow } from "./workflow.js";
export type { AgentConfig, AgentWorkflow } from "./types.js";

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

  // ── UI server ─────────────────────────────────────────────────────────────
  if (argv[0] === "ui") {
    const portIdx = argv.indexOf("--port");
    const port = portIdx !== -1 ? parseInt(argv[portIdx + 1] ?? "3457", 10) : 3457;
    await startUiServer({ port });
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
      process.env["PROTOCOL_API_KEY"] ?? "";
    if (!apiKey) {
      process.stderr.write("orager: API key not set. Export PROTOCOL_API_KEY.\n");
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
      const m = /^(\d+(?:\.\d+)?)(s|m|h)$/.exec(raw);
      if (m) idleTimeoutMs = parseFloat(m[1]) * (m[2] === "h" ? 3600_000 : m[2] === "m" ? 60_000 : 1_000);
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
  // P-09: --fork-session forks a session. With --resume, it continues to the agent loop.
  if (argv.includes("--fork-session")) {
    const forkResult = await handleForkSession(argv);
    if (forkResult.resume) {
      // Strip fork-related flags and inject --resume with the new session ID
      const cleaned: string[] = [];
      for (let fi = 0; fi < argv.length; fi++) {
        if (argv[fi] === "--fork-session" || argv[fi] === "--at-turn") { fi++; continue; } // skip flag + value
        if (argv[fi] === "--resume") continue; // remove bare --resume (fork already handled it)
        cleaned.push(argv[fi]!);
      }
      cleaned.push("--resume", forkResult.sessionId, "--force-resume");
      argv = cleaned;
    }
    // If handleForkSession called process.exit (no --resume), we won't reach here.
  }
  if (argv.includes("--compact-session"))  { await handleCompactSession(argv);  return; }
  if (argv.includes("--prune-sessions"))   { await handlePrune(argv);           return; }
  if (argv.includes("--abandoned-sessions")) { await handleAbandonedSessions(); return; }
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
    if (userCfg.webhookUrl && !G.__oragerWebhookUrl)             G.__oragerWebhookUrl = userCfg.webhookUrl;
    if (userCfg.webhookFormat && !G.__oragerWebhookFormat)       G.__oragerWebhookFormat = userCfg.webhookFormat;
    if (userCfg.webhookSecret && !G.__oragerWebhookSecret)       G.__oragerWebhookSecret = userCfg.webhookSecret;
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
    if (cfResult.webhookFormat) {
      (globalThis as Record<string, unknown>).__oragerWebhookFormat = cfResult.webhookFormat;
    }
    if (cfResult.webhookSecret) {
      (globalThis as Record<string, unknown>).__oragerWebhookSecret = cfResult.webhookSecret;
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
    if (cfResult.agentApiKey) {
      (globalThis as Record<string, unknown>).__oragerAgentApiKey = cfResult.agentApiKey;
    }
    if (cfResult.memoryRetrieval !== undefined) {
      (globalThis as Record<string, unknown>).__oragerMemoryRetrieval = cfResult.memoryRetrieval;
    }
    if (cfResult.memoryEmbeddingModel) {
      (globalThis as Record<string, unknown>).__oragerMemoryEmbeddingModel = cfResult.memoryEmbeddingModel;
    }
  }

  // ── Acquire global CLI instance lock ──────────────────────────────────────
  // Skip when spawned by the adapter (--config-file), when running under the
  // daemon (ORAGER_DAEMON_MODE=1), or when testing (ORAGER_SKIP_PID_LOCK=1).
  const _skipPidLock = cfIdx !== -1
    || process.env["ORAGER_DAEMON_MODE"] === "1"
    || process.env["ORAGER_SKIP_PID_LOCK"] === "1";
  if (!_skipPidLock) {
    await acquireCliPidLock();
  }

  // Resolve API key
  const apiKey =
    process.env["PROTOCOL_API_KEY"] ?? "";

  if (!apiKey) {
    process.stderr.write(
      "orager: API key not set. Export PROTOCOL_API_KEY.\n"
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
    visionModel: opts.visionModel,
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
    webhookFormat: (globalThis as Record<string, unknown>).__oragerWebhookFormat as "discord" | undefined,
    webhookSecret: (globalThis as Record<string, unknown>).__oragerWebhookSecret as string | undefined,
    bashPolicy: (globalThis as Record<string, unknown>).__oragerBashPolicy as AgentLoopOptions["bashPolicy"] | undefined,
    trackFileChanges: (globalThis as Record<string, unknown>).__oragerTrackFileChanges as boolean | undefined ?? opts.trackFileChanges,
    enableBrowserTools: (globalThis as Record<string, unknown>).__oragerEnableBrowserTools as boolean | undefined ?? opts.enableBrowserTools,
    autoMemory: opts.autoMemory,
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
    agentApiKey: (globalThis as Record<string, unknown>).__oragerAgentApiKey as string | undefined,
    memoryRetrieval: (globalThis as Record<string, unknown>).__oragerMemoryRetrieval as "local" | "embedding" | undefined,
    memoryEmbeddingModel: (globalThis as Record<string, unknown>).__oragerMemoryEmbeddingModel as string | undefined,
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
