/**
 * CLI session management command handlers (Sprint 7 decomposition).
 *
 * Extracted from src/index.ts. Each handler corresponds to a --flag that
 * operates on sessions: list, trash, restore, delete, rollback, fork,
 * search, compact, delete-trashed, prune, abandoned-sessions.
 */

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
} from "../session.js";

// ── List sessions ─────────────────────────────────────────────────────────────

export async function handleListSessions(): Promise<void> {
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

// ── Trash session ─────────────────────────────────────────────────────────────

export async function handleTrashSession(argv: string[]): Promise<void> {
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

// ── Restore session ───────────────────────────────────────────────────────────

export async function handleRestoreSession(argv: string[]): Promise<void> {
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

// ── Delete session ────────────────────────────────────────────────────────────

export async function handleDeleteSession(argv: string[]): Promise<void> {
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

// ── Rollback session ──────────────────────────────────────────────────────────

export async function handleRollbackSession(argv: string[]): Promise<void> {
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

// ── Fork session ──────────────────────────────────────────────────────────────

// P-09: Fork a session — creates a new session branched from an existing one.
export async function handleForkSession(argv: string[]): Promise<{ sessionId: string; resume: boolean } | never> {
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
      return { sessionId: result.sessionId, resume: true };
    }
    process.exit(0);
  } catch (err) {
    process.stderr.write(`orager: fork failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

// ── Search sessions ───────────────────────────────────────────────────────────

export async function handleSearchSessions(argv: string[]): Promise<void> {
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

// ── Compact session ───────────────────────────────────────────────────────────

export async function handleCompactSession(argv: string[]): Promise<void> {
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

// ── Delete trashed sessions ───────────────────────────────────────────────────

export async function handleDeleteTrashed(): Promise<void> {
  const result = await deleteTrashedSessions();
  process.stdout.write(
    `Deleted ${result.deleted} trashed session(s). Active sessions kept: ${result.kept}. Errors: ${result.errors}.\n`,
  );
  process.exit(0);
}

// ── Abandoned sessions ────────────────────────────────────────────────────────

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function handleAbandonedSessions(): Promise<void> {
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

// ── Prune sessions ────────────────────────────────────────────────────────────

export async function handlePrune(argv: string[]): Promise<void> {
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
        `orager: invalid --older-than value "${raw}". Use e.g. 30d, 7d, 24h, 1h.\n`,
      );
      process.exit(1);
    }
  }

  const days = (olderThanMs / (24 * 60 * 60 * 1000)).toFixed(1);
  process.stderr.write(`[orager] pruning sessions older than ${days} day(s)...\n`);

  const result = await pruneOldSessions(olderThanMs);
  process.stdout.write(
    `Pruned ${result.deleted} session(s). Kept ${result.kept}. Errors: ${result.errors}.\n`,
  );
  process.exit(0);
}

// ── Sessions table ────────────────────────────────────────────────────────────

// ADR-0003: --sessions now queries the local SQLite store directly instead of
// proxying to the removed daemon. Equivalent to --list-sessions but with a
// richer cost-aware table format.
export async function handleSessionsCommand(argv: string[]): Promise<void> {
  const jsonMode = argv.includes("--json");
  const sessions = (await listSessions()).slice(0, 20);

  if (jsonMode) {
    const result = sessions.map((s) => ({
      sessionId: s.sessionId,
      lastRunAt: s.updatedAt,
      cumulativeCostUsd: s.cumulativeCostUsd ?? 0,
      runCount: s.turnCount,
    }));
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.exit(0);
  }

  const header = `${"SESSION ID".padEnd(22)} ${"LAST RUN AT".padEnd(20)} ${"COST USD".padStart(10)} ${"TURNS".padStart(6)}`;
  process.stdout.write(header + "\n");
  process.stdout.write("-".repeat(header.length) + "\n");
  for (const s of sessions) {
    const id = s.sessionId.slice(0, 20).padEnd(22);
    const lastRun = (s.updatedAt ?? "").slice(0, 16).replace("T", " ").padEnd(20);
    const cost = `$${((s.cumulativeCostUsd ?? 0)).toFixed(4)}`.padStart(10);
    const turns = String(s.turnCount).padStart(6);
    process.stdout.write(`${id} ${lastRun} ${cost} ${turns}\n`);
  }
  process.exit(0);
}
