#!/usr/bin/env node
import process from "node:process";
import fs from "node:fs/promises";
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
} from "./session.js";
import type { CliOptions, EmitResultEvent } from "./types.js";

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

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // Session management commands — no API key needed
  if (argv.includes("--list-sessions"))    { await handleListSessions();         return; }
  if (argv.includes("--trash-session"))    { await handleTrashSession(argv);    return; }
  if (argv.includes("--restore-session"))  { await handleRestoreSession(argv);  return; }
  if (argv.includes("--delete-session"))   { await handleDeleteSession(argv);   return; }
  if (argv.includes("--delete-trashed"))   { await handleDeleteTrashed();       return; }
  if (argv.includes("--rollback-session")) { await handleRollbackSession(argv); return; }
  if (argv.includes("--prune-sessions"))   { await handlePrune(argv);           return; }

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
    opts.dataCollection || opts.zdr || opts.sort || opts.quantizations)
    ? {
        ...(opts.providerOrder ? { order: opts.providerOrder } : {}),
        ...(opts.providerIgnore ? { ignore: opts.providerIgnore } : {}),
        ...(opts.providerOnly ? { only: opts.providerOnly } : {}),
        ...(opts.dataCollection ? { data_collection: opts.dataCollection } : {}),
        ...(opts.zdr ? { zdr: true } : {}),
        ...(opts.sort ? { sort: opts.sort } : {}),
        ...(opts.quantizations ? { quantizations: opts.quantizations } : {}),
      }
    : undefined;

  await runAgentLoop({
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
    onEmit: emit,
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
    appendSystemPrompt,
  });
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`orager: fatal error: ${message}\n`);
  process.exit(1);
});
