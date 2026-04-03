/**
 * Database path resolution and size budget constants.
 *
 * ADR-0008: per-namespace SQLite files replace the monolithic orager.db.
 *
 *   ~/.orager/memory/<memoryKey>.sqlite   — one file per memory namespace
 *   ~/.orager/skills/skills.sqlite        — shared SkillBank store
 *   ~/.orager/sessions/index.sqlite       — session metadata + FTS + checkpoints
 *   ~/.orager/sessions/<sessionId>.jsonl  — append-only session transcripts
 */
import os from "node:os";
import path from "node:path";

// ── Default DB path (legacy — still used for ORAGER_DB_PATH=none opt-out) ────

/**
 * Default path for the legacy monolithic orager SQLite database.
 * Used when ORAGER_DB_PATH is not explicitly set and for backward compat.
 */
export const DEFAULT_DB_PATH = path.join(os.homedir(), ".orager", "orager.db");

// ── Size budget ───────────────────────────────────────────────────────────────

/** Log a warning when DB exceeds this size. */
export const DB_WARN_BYTES  = 50  * 1024 * 1024; // 50 MB
/** Trigger auto-prune of low-importance expired entries at this size. */
export const DB_PRUNE_BYTES = 80  * 1024 * 1024; // 80 MB

// ── Path resolver ─────────────────────────────────────────────────────────────

/**
 * Resolve the DB path to use for this process.
 *
 * Resolution order:
 *  1. ORAGER_DB_PATH env var, if set and non-empty and not "none" → use it
 *  2. Otherwise → DEFAULT_DB_PATH (~/.orager/orager.db)
 *
 * To explicitly disable SQLite and force the JSON fallback, set:
 *   ORAGER_DB_PATH=none
 * or:
 *   ORAGER_DB_PATH=""  (empty string)
 */
export function resolveDbPath(): string | null {
  const envVal = process.env["ORAGER_DB_PATH"];
  if (envVal === "" || envVal === "none") return null; // explicit opt-out → JSON fallback
  return envVal ?? DEFAULT_DB_PATH;
}

// ── ADR-0008 per-namespace path resolvers ─────────────────────────────────────

/**
 * Directory for per-namespace memory SQLite files.
 * Override with ORAGER_MEMORY_SQLITE_DIR env var.
 */
export function resolveMemoryDir(): string {
  return process.env["ORAGER_MEMORY_SQLITE_DIR"] ?? path.join(os.homedir(), ".orager", "memory");
}

/**
 * Path to the shared SkillBank SQLite database.
 * Override with ORAGER_SKILLS_DB_PATH env var.
 */
export function resolveSkillsDbPath(): string {
  return process.env["ORAGER_SKILLS_DB_PATH"] ?? path.join(os.homedir(), ".orager", "skills", "skills.sqlite");
}

/**
 * Directory for JSONL session transcripts and the index.sqlite.
 * Reads ORAGER_SESSIONS_DIR for compatibility with existing env overrides.
 */
export function resolveSessionsDir(): string {
  return process.env["ORAGER_SESSIONS_DIR"] ?? path.join(os.homedir(), ".orager", "sessions");
}

/**
 * Sanitize a memoryKey into a safe filename component.
 * Replaces `/` with `__` and any other non-alphanumeric chars (except `-_.`) with `_`.
 */
export function sanitizeKeyForFilename(key: string): string {
  return key.replace(/\//g, "__").replace(/[^a-zA-Z0-9_\-.]/g, "_");
}

// ── Size check ────────────────────────────────────────────────────────────────

import type { SqliteDatabase } from "./native-sqlite.js";

/**
 * Returns the current on-disk size of the database in bytes.
 * Uses PRAGMA page_count * page_size for an exact in-process measurement.
 */
export function getDbSizeBytes(db: SqliteDatabase): number {
  const row = db.prepare("SELECT page_count * page_size AS sz FROM pragma_page_count(), pragma_page_size()").get() as { sz: number } | undefined;
  return row?.sz ?? 0;
}

/**
 * Check the DB size and log a warning / flag prune if thresholds are exceeded.
 * Returns: 'ok' | 'warn' | 'prune'
 */
export function checkDbSize(db: SqliteDatabase): "ok" | "warn" | "prune" {
  const bytes = getDbSizeBytes(db);
  if (bytes >= DB_PRUNE_BYTES) return "prune";
  if (bytes >= DB_WARN_BYTES)  return "warn";
  return "ok";
}
