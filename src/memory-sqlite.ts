/**
 * SQLite-backed memory store using better-sqlite3 (synchronous API).
 *
 * Activated when ORAGER_DB_PATH env var is set.
 * Schema: memory_entries table with FTS5 virtual table for full-text search.
 *
 * WAL mode is enabled for better concurrent read performance.
 */
import Database from "better-sqlite3";
import type { Database as DB } from "better-sqlite3";
import crypto from "node:crypto";
import type { MemoryStore, MemoryEntry } from "./memory.js";

// ── Singleton DB ───────────────────────────────────────────────────────────────

let _db: DB | null = null;

function getDb(): DB {
  if (_db) return _db;
  const dbPath = process.env["ORAGER_DB_PATH"];
  if (!dbPath) {
    throw new Error("ORAGER_DB_PATH is not set — SQLite memory is not available");
  }
  _db = new Database(dbPath);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  _db.pragma("synchronous = NORMAL");
  _migrate(_db);
  return _db;
}

/** Reset the singleton — for testing only. */
export function _resetDbForTesting(): void {
  if (_db) {
    try { _db.close(); } catch { /* ignore */ }
    _db = null;
  }
}

function _migrate(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_entries (
      id          TEXT PRIMARY KEY,
      memory_key  TEXT NOT NULL,
      content     TEXT NOT NULL,
      tags        TEXT,
      created_at  TEXT NOT NULL,
      expires_at  TEXT,
      run_id      TEXT,
      importance  INTEGER NOT NULL DEFAULT 2,
      embedding   BLOB,
      embedding_model TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_memory_key ON memory_entries(memory_key);

    CREATE VIRTUAL TABLE IF NOT EXISTS memory_entries_fts USING fts5(
      content,
      content='memory_entries',
      content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS memory_entries_ai AFTER INSERT ON memory_entries BEGIN
      INSERT INTO memory_entries_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_entries_ad AFTER DELETE ON memory_entries BEGIN
      INSERT INTO memory_entries_fts(memory_entries_fts, rowid, content)
        VALUES ('delete', old.rowid, old.content);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_entries_au AFTER UPDATE ON memory_entries BEGIN
      INSERT INTO memory_entries_fts(memory_entries_fts, rowid, content)
        VALUES ('delete', old.rowid, old.content);
      INSERT INTO memory_entries_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
  `);
}

// ── Row mapping ───────────────────────────────────────────────────────────────

interface MemoryRow {
  id: string;
  memory_key: string;
  content: string;
  tags: string | null;
  created_at: string;
  expires_at: string | null;
  run_id: string | null;
  importance: number;
  embedding: string | null;
  embedding_model: string | null;
}

function rowToEntry(row: MemoryRow): MemoryEntry {
  const entry: MemoryEntry = {
    id: row.id,
    content: row.content,
    createdAt: row.created_at,
    importance: (row.importance === 1 || row.importance === 2 || row.importance === 3
      ? row.importance
      : 2) as 1 | 2 | 3,
  };
  if (row.tags) {
    try { entry.tags = JSON.parse(row.tags) as string[]; } catch { /* ignore */ }
  }
  if (row.expires_at) entry.expiresAt = row.expires_at;
  if (row.run_id) entry.runId = row.run_id;
  if (row.embedding) {
    try { entry._embedding = JSON.parse(row.embedding) as number[]; } catch { /* ignore */ }
  }
  if (row.embedding_model) entry._embeddingModel = row.embedding_model;
  return entry;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Load all non-expired entries for a given memoryKey.
 * Prunes expired entries in the same transaction.
 */
export function loadMemoryStoreSqlite(memoryKey: string): MemoryStore {
  const db = getDb();
  const now = new Date().toISOString();

  const doLoad = db.transaction((key: string, nowIso: string) => {
    // Prune expired
    db.prepare(
      "DELETE FROM memory_entries WHERE memory_key = ? AND expires_at IS NOT NULL AND expires_at <= ?"
    ).run(key, nowIso);

    // Load remaining
    const rows = db.prepare(
      "SELECT id, memory_key, content, tags, created_at, expires_at, run_id, importance, embedding, embedding_model " +
      "FROM memory_entries WHERE memory_key = ?"
    ).all(key) as MemoryRow[];

    return rows;
  });

  const rows = doLoad(memoryKey, now);
  return {
    memoryKey,
    entries: rows.map(rowToEntry),
    updatedAt: now,
  };
}

/**
 * Upsert all entries from the store into the DB.
 */
export function saveMemoryStoreSqlite(memoryKey: string, store: MemoryStore): void {
  const db = getDb();
  const upsert = db.prepare(`
    INSERT OR REPLACE INTO memory_entries
      (id, memory_key, content, tags, created_at, expires_at, run_id, importance, embedding, embedding_model)
    VALUES
      (@id, @memoryKey, @content, @tags, @createdAt, @expiresAt, @runId, @importance, @embedding, @embeddingModel)
  `);

  const doSave = db.transaction((entries: MemoryEntry[]) => {
    for (const e of entries) {
      upsert.run({
        id: e.id,
        memoryKey,
        content: e.content,
        tags: e.tags ? JSON.stringify(e.tags) : null,
        createdAt: e.createdAt,
        expiresAt: e.expiresAt ?? null,
        runId: e.runId ?? null,
        importance: e.importance,
        embedding: e._embedding ? JSON.stringify(e._embedding) : null,
        embeddingModel: e._embeddingModel ?? null,
      });
    }
  });

  doSave(store.entries);
}

/**
 * Insert a single entry, returning the full MemoryEntry with generated id + createdAt.
 */
export function addMemoryEntrySqlite(
  memoryKey: string,
  entry: Omit<MemoryEntry, "id" | "createdAt">,
): MemoryEntry {
  const db = getDb();
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  db.prepare(`
    INSERT INTO memory_entries
      (id, memory_key, content, tags, created_at, expires_at, run_id, importance, embedding, embedding_model)
    VALUES
      (@id, @memoryKey, @content, @tags, @createdAt, @expiresAt, @runId, @importance, @embedding, @embeddingModel)
  `).run({
    id,
    memoryKey,
    content: entry.content,
    tags: entry.tags ? JSON.stringify(entry.tags) : null,
    createdAt,
    expiresAt: entry.expiresAt ?? null,
    runId: entry.runId ?? null,
    importance: entry.importance ?? 2,
    embedding: entry._embedding ? JSON.stringify(entry._embedding) : null,
    embeddingModel: entry._embeddingModel ?? null,
  });

  return {
    ...entry,
    id,
    createdAt,
    importance: entry.importance ?? 2,
  };
}

/**
 * Delete an entry by id + memoryKey. Returns true if a row was deleted.
 */
export function removeMemoryEntrySqlite(memoryKey: string, id: string): boolean {
  const db = getDb();
  const result = db.prepare(
    "DELETE FROM memory_entries WHERE id = ? AND memory_key = ?"
  ).run(id, memoryKey);
  return result.changes > 0;
}

/**
 * FTS5 full-text search over memory_entries for a given memoryKey.
 * Returns non-expired entries matching the query, up to `limit`.
 */
export function searchMemoryFts(
  memoryKey: string,
  query: string,
  limit = 20,
): MemoryEntry[] {
  const db = getDb();
  const now = new Date().toISOString();

  // Sanitize query for FTS5: strip special operator characters
  const sanitized = query.replace(/["*^()[\]{}]/g, " ").trim();
  if (!sanitized) return [];
  const ftsQuery = `"${sanitized.replace(/"/g, '""')}"`;

  const rows = db.prepare(`
    SELECT m.id, m.memory_key, m.content, m.tags, m.created_at, m.expires_at,
           m.run_id, m.importance, m.embedding, m.embedding_model
    FROM memory_entries_fts f
    JOIN memory_entries m ON m.rowid = f.rowid
    WHERE memory_entries_fts MATCH ?
      AND m.memory_key = ?
      AND (m.expires_at IS NULL OR m.expires_at > ?)
    ORDER BY rank
    LIMIT ?
  `).all(ftsQuery, memoryKey, now, limit) as MemoryRow[];

  return rows.map(rowToEntry);
}

/**
 * Returns all distinct memory_key values in the database.
 */
export function listMemoryKeysSqlite(): string[] {
  const db = getDb();
  const rows = db.prepare("SELECT DISTINCT memory_key FROM memory_entries ORDER BY memory_key").all() as { memory_key: string }[];
  return rows.map((r) => r.memory_key);
}

/**
 * Deletes all entries for a given memoryKey. Returns the number of deleted rows.
 */
export function clearMemoryStoreSqlite(memoryKey: string): number {
  const db = getDb();
  const result = db.prepare("DELETE FROM memory_entries WHERE memory_key = ?").run(memoryKey);
  return result.changes;
}

/**
 * Returns true when ORAGER_DB_PATH is set, indicating SQLite memory is available.
 */
export function isSqliteMemoryEnabled(): boolean {
  return Boolean(process.env["ORAGER_DB_PATH"]);
}
