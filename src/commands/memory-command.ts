/**
 * CLI `orager memory` subcommand handler (Sprint 7 decomposition).
 *
 * Extracted from src/index.ts. Handles: list, export, clear, inspect.
 */

import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { loadMemoryStoreAny, MEMORY_DIR } from "../memory.js";
import {
  isSqliteMemoryEnabled,
  listMemoryKeysSqlite,
  clearMemoryStoreSqlite,
  loadMasterContext,
  getMemoryEntryCount,
} from "../memory-sqlite.js";
import { loadLatestCheckpointByContextId } from "../session.js";

export async function handleMemorySubcommand(argv: string[]): Promise<void> {
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
      const { MEMORY_DIR: memDir } = await import("../memory.js");
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
