/**
 * Agent registry — persisted catalog of AgentDefinition records.
 *
 * Storage hierarchy (higher priority wins on name collision):
 *   1. Seed agents         — built into orager, always available
 *   2. User-level files    — ~/.orager/agents/*.json
 *   3. Project-level files — <cwd>/.orager/agents/*.json
 *   4. DB-stored           — created/modified via `orager agents add/edit`
 *   5. opts.agents         — programmatic overrides (handled in loop.ts)
 *
 * Database: ~/.orager/agents/agents.sqlite
 *   tables: agents, agent_scores (scores managed by score.ts)
 *
 * File format: JSON files with an AgentDefinition-shaped object.
 * The filename (minus .json) becomes the agent key.
 *
 *   ~/.orager/agents/my-reviewer.json → key "my-reviewer"
 *
 * File contents:
 *   {
 *     "description": "...",
 *     "prompt": "...",
 *     "tools": ["Read", "Grep"],
 *     "model": "openai/gpt-4o-mini"
 *   }
 */

import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { openDb } from "../native-sqlite.js";
import { runMigrations } from "../db-migrations.js";
import { resolveAgentsDbPath, resolveUserAgentsDir, resolveProjectAgentsDir } from "../db.js";
import { SEED_AGENTS } from "./seeds.js";
import type { AgentDefinition } from "../types.js";
import type { SqliteDatabase } from "../native-sqlite.js";

// ── Migrations ────────────────────────────────────────────────────────────────

const AGENTS_MIGRATIONS = [
  {
    version: 1,
    name: "create_agents_table",
    sql: `
      CREATE TABLE IF NOT EXISTS agents (
        id          TEXT    PRIMARY KEY,
        name        TEXT,
        definition  TEXT    NOT NULL,
        source      TEXT    NOT NULL DEFAULT 'db',
        created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS agent_scores (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id    TEXT    NOT NULL,
        session_id  TEXT,
        success     INTEGER NOT NULL DEFAULT 1,
        turns       INTEGER NOT NULL DEFAULT 0,
        cost_usd    REAL    NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        recorded_at TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_agent_scores_agent_id
        ON agent_scores(agent_id);
      CREATE INDEX IF NOT EXISTS idx_agent_scores_recorded_at
        ON agent_scores(recorded_at);
    `,
  },
];

// ── DB singleton ──────────────────────────────────────────────────────────────

let _db: SqliteDatabase | null = null;

/**
 * Open (or return the cached) agents database.
 * Lazy — only opens the file if something actually needs it.
 */
export async function getAgentsDb(): Promise<SqliteDatabase> {
  if (_db) return _db;
  const dbPath = resolveAgentsDbPath();
  _db = await openDb(dbPath);
  runMigrations(_db, AGENTS_MIGRATIONS);
  return _db;
}

/** Close the cached DB connection. Call at process shutdown. */
export function closeAgentsDb(): void {
  if (_db) {
    try { _db.close(); } catch { /* ignore */ }
    _db = null;
  }
}

// ── File loader helpers ───────────────────────────────────────────────────────

function loadAgentsFromDir(
  dir: string,
  source: "user" | "project",
): Record<string, AgentDefinition> {
  const result: Record<string, AgentDefinition> = {};
  if (!existsSync(dir)) return result;

  let entries: string[];
  try { entries = readdirSync(dir); } catch { return result; }

  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const key = entry.slice(0, -5); // strip .json
    const filePath = path.join(dir, entry);
    try {
      const raw = readFileSync(filePath, "utf-8");
      const defn = JSON.parse(raw) as AgentDefinition;
      result[key] = { ...defn, source };
    } catch {
      // Malformed file — skip silently (don't break the session)
    }
  }
  return result;
}

// ── DB CRUD ───────────────────────────────────────────────────────────────────

/** Load all DB-stored agent definitions. */
async function loadDbAgents(): Promise<Record<string, AgentDefinition>> {
  const db = await getAgentsDb();
  const rows = db.prepare("SELECT id, definition FROM agents").all() as Array<{
    id: string;
    definition: string;
  }>;

  const result: Record<string, AgentDefinition> = {};
  for (const row of rows) {
    try {
      result[row.id] = { ...JSON.parse(row.definition), source: "db" as const };
    } catch {
      // Corrupt row — skip
    }
  }
  return result;
}

/**
 * Upsert an agent definition into the DB.
 * `id` is the registry key (e.g. "my-reviewer").
 */
export async function upsertAgent(
  id: string,
  defn: Omit<AgentDefinition, "source">,
): Promise<void> {
  const db = await getAgentsDb();
  const name = defn.name ?? id;
  const json = JSON.stringify({ ...defn, source: undefined });

  db.prepare(
    `INSERT INTO agents (id, name, definition, source)
     VALUES (?, ?, ?, 'db')
     ON CONFLICT(id) DO UPDATE SET
       name       = excluded.name,
       definition = excluded.definition,
       source     = 'db',
       updated_at = datetime('now')`,
  ).run(id, name, json);
}

/**
 * Delete an agent definition from the DB.
 * Does not affect seed or file-sourced agents.
 */
export async function deleteAgent(id: string): Promise<boolean> {
  const db = await getAgentsDb();
  const { changes } = db.prepare("DELETE FROM agents WHERE id = ?").run(id);
  return changes > 0;
}

/**
 * List all DB-stored agent IDs.
 */
export async function listDbAgentIds(): Promise<string[]> {
  const db = await getAgentsDb();
  return (
    db.prepare("SELECT id FROM agents ORDER BY id").all() as { id: string }[]
  ).map((r) => r.id);
}

// ── Master loader ─────────────────────────────────────────────────────────────

/**
 * Load the full merged agent catalog in priority order.
 *
 *   seeds → user files → project files → db
 *
 * Higher priority overrides lower priority on name collision.
 *
 * @param cwd Project root (for project-level agents). Defaults to process.cwd().
 * @param skipDb Skip the DB lookup — useful in tests or when the DB is unavailable.
 */
export async function loadAllAgents(
  cwd?: string,
  skipDb = false,
): Promise<Record<string, AgentDefinition>> {
  const merged: Record<string, AgentDefinition> = {};

  // 1. Seeds — lowest priority
  Object.assign(merged, SEED_AGENTS);

  // 2. User-level files: ~/.orager/agents/*.json
  const userDir = resolveUserAgentsDir();
  Object.assign(merged, loadAgentsFromDir(userDir, "user"));

  // 3. Project-level files: <cwd>/.orager/agents/*.json
  const effectiveCwd = cwd ?? process.cwd();
  const projectDir = resolveProjectAgentsDir(effectiveCwd);
  Object.assign(merged, loadAgentsFromDir(projectDir, "project"));

  // 4. DB-stored — highest priority
  if (!skipDb) {
    try {
      const dbAgents = await loadDbAgents();
      Object.assign(merged, dbAgents);
    } catch {
      // Non-fatal — if agents DB is unavailable, seeds+files still work
    }
  }

  return merged;
}

// ── File export helpers ───────────────────────────────────────────────────────

/**
 * Write an agent definition to the user-level agents directory as JSON.
 * Useful for bootstrapping a new agent without touching the DB.
 */
export function exportAgentToUserDir(
  id: string,
  defn: Omit<AgentDefinition, "source">,
): string {
  const dir = resolveUserAgentsDir();
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${id}.json`);
  writeFileSync(filePath, JSON.stringify(defn, null, 2) + "\n", "utf-8");
  return filePath;
}

/**
 * Write an agent definition to the project-level agents directory.
 */
export function exportAgentToProjectDir(
  id: string,
  defn: Omit<AgentDefinition, "source">,
  cwd?: string,
): string {
  const dir = resolveProjectAgentsDir(cwd ?? process.cwd());
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${id}.json`);
  writeFileSync(filePath, JSON.stringify(defn, null, 2) + "\n", "utf-8");
  return filePath;
}

/**
 * Remove an agent JSON file from the user-level agents directory.
 */
export function removeAgentFile(id: string): boolean {
  const filePath = path.join(resolveUserAgentsDir(), `${id}.json`);
  if (!existsSync(filePath)) return false;
  try { rmSync(filePath); return true; } catch { return false; }
}
