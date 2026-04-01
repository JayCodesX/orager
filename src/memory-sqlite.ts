/**
 * SQLite-backed memory store using WASM SQLite (synchronous API).
 *
 * Activated when ORAGER_DB_PATH env var is set.
 * Schema: memory_entries table with FTS5 virtual table for full-text search.
 */
import { openWasmDb } from "./wasm-sqlite.js";
import type { WasmDatabase } from "./wasm-sqlite.js";
import crypto from "node:crypto";
import type { MemoryStore, MemoryEntry } from "./memory.js";
import { resolveDbPath, checkDbSize } from "./db.js";
import { mkdirSync } from "node:fs";
import path from "node:path";

// ── Singleton DB ───────────────────────────────────────────────────────────────

let _db: WasmDatabase | null = null;

async function getDb(): Promise<WasmDatabase> {
  if (_db) return _db;
  const dbPath = resolveDbPath();
  if (!dbPath) {
    throw new Error("SQLite is disabled (ORAGER_DB_PATH=none) — memory store not available");
  }
  // Ensure the parent directory exists (e.g. ~/.orager/ on first run).
  mkdirSync(path.dirname(dbPath), { recursive: true });
  _db = await openWasmDb(dbPath);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  _db.pragma("synchronous = NORMAL");
  // auto_vacuum=INCREMENTAL takes effect on new databases; existing DBs need
  // a one-time VACUUM to change mode — set unconditionally, no-op if already set.
  _db.pragma("auto_vacuum = INCREMENTAL");
  _migrate(_db);
  _logDbSize(_db);
  return _db;
}

function _logDbSize(db: WasmDatabase): void {
  const status = checkDbSize(db);
  if (status === "prune") {
    process.stderr.write(
      `[orager] WARNING: DB size ≥80 MB — consider running 'remember reset' or enabling memory consolidation.\n`
    );
  } else if (status === "warn") {
    process.stderr.write(
      `[orager] INFO: DB size ≥50 MB — approaching budget. Summarization will keep this in check.\n`
    );
  }
}

/**
 * Close the SQLite database cleanly — call before process exit to ensure the
 * WAL is checkpointed and no data is lost. Safe to call when no DB is open.
 */
export function closeDb(): void {
  if (_db) {
    try { _db.close(); } catch { /* ignore */ }
    _db = null;
  }
}

/** Reset the singleton — for testing only. */
export function _resetDbForTesting(): void {
  closeDb();
}

function _migrate(db: WasmDatabase): void {
  // ── Base table ────────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_entries (
      id              TEXT PRIMARY KEY,
      memory_key      TEXT NOT NULL,
      content         TEXT NOT NULL,
      tags            TEXT,
      created_at      TEXT NOT NULL,
      expires_at      TEXT,
      run_id          TEXT,
      importance      INTEGER NOT NULL DEFAULT 2,
      embedding       BLOB,
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

  // ── Phase 0 additive migrations ───────────────────────────────────────────
  // SQLite does not support IF NOT EXISTS for ALTER TABLE ADD COLUMN, so we
  // check pragma_table_info() before each ALTER to make _migrate() idempotent.

  const existingCols = new Set(
    (db.prepare("SELECT name FROM pragma_table_info('memory_entries')").all() as { name: string }[])
      .map((r) => r.name)
  );

  // context_id: logical namespace (replaces memory_key scoping for cross-session memory).
  // Default 'default' preserves behaviour for all existing rows.
  if (!existingCols.has("context_id")) {
    db.exec(`ALTER TABLE memory_entries ADD COLUMN context_id TEXT NOT NULL DEFAULT 'default'`);
  }

  // type: categorises entries — 'master_context' | 'insight' | 'fact' | 'competitor' |
  //        'decision' | 'risk' | 'open_question' | 'session_summary'
  // Default 'insight' treats all pre-existing rows as generic insights.
  if (!existingCols.has("type")) {
    db.exec(`ALTER TABLE memory_entries ADD COLUMN type TEXT NOT NULL DEFAULT 'insight'`);
  }

  // metadata: flexible JSON payload — { confidence, tags[], source_model, session_id }
  // Supersedes the flat 'tags' and 'importance' columns for new rows; old columns kept
  // for backward compat with existing code paths.
  if (!existingCols.has("metadata")) {
    db.exec(`ALTER TABLE memory_entries ADD COLUMN metadata JSON`);
    // Back-fill metadata from existing tags + importance for all current rows.
    db.exec(`
      UPDATE memory_entries
      SET metadata = json_object(
        'tags',       COALESCE(tags, '[]'),
        'importance', importance
      )
      WHERE metadata IS NULL
    `);
  }

  // Composite index for the primary retrieval pattern in the new memory system:
  //   WHERE context_id = ? AND type IN (...)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_context_type ON memory_entries(context_id, type);
  `);

  // One-time migration: convert legacy JSON-string embeddings to binary Float32 BLOB.
  // Rows written by older versions stored embeddings as JSON text (e.g. "[1.0,2.0,...]").
  // SQLite's typeof() returns 'text' for those and 'blob' for the new binary format.
  const legacyRows = db.prepare(
    "SELECT rowid, embedding FROM memory_entries WHERE embedding IS NOT NULL AND typeof(embedding) = 'text'",
  ).all() as unknown as Array<{ rowid: number; embedding: string }>;

  if (legacyRows.length > 0) {
    const upd = db.prepare("UPDATE memory_entries SET embedding = ? WHERE rowid = ?");
    for (const row of legacyRows) {
      try {
        const floats = JSON.parse(row.embedding) as number[];
        upd.run(new Uint8Array(new Float32Array(floats).buffer), row.rowid);
      } catch { /* skip malformed rows */ }
    }
  }
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
  /** WASM sqlite returns BLOBs as Uint8Array; legacy rows may be JSON strings. */
  embedding: Uint8Array | string | null;
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
    try {
      if (row.embedding instanceof Uint8Array) {
        // New format: raw Float32 binary BLOB
        const f32 = new Float32Array(
          row.embedding.buffer,
          row.embedding.byteOffset,
          row.embedding.byteLength / 4,
        );
        entry._embedding = Array.from(f32);
      } else {
        // Legacy format: JSON string
        entry._embedding = JSON.parse(row.embedding) as number[];
      }
    } catch { /* ignore */ }
  }
  if (row.embedding_model) entry._embeddingModel = row.embedding_model;
  return entry;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Load all non-expired entries for a given memoryKey.
 * Prunes expired entries in the same transaction.
 */
export async function loadMemoryStoreSqlite(memoryKey: string): Promise<MemoryStore> {
  const db = await getDb();
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
    ).all(key) as unknown as MemoryRow[];

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
 * Upsert all entries from the store into the DB and delete any rows for this
 * memoryKey that are no longer present in store.entries.
 *
 * Without the delete pass, entries removed via removeMemoryEntry() + saveMemoryStoreAny()
 * would silently persist in the DB and reappear on next loadMemoryStoreSqlite call.
 */
export async function saveMemoryStoreSqlite(memoryKey: string, store: MemoryStore): Promise<void> {
  const db = await getDb();
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
        embedding: e._embedding
          ? new Uint8Array(new Float32Array(e._embedding).buffer)
          : null,
        embeddingModel: e._embeddingModel ?? null,
      });
    }

    // Delete any DB rows for this memoryKey that are no longer in store.entries.
    // This ensures entries removed via removeMemoryEntry() are actually deleted
    // from the DB rather than silently re-appearing on next load.
    if (entries.length === 0) {
      db.prepare("DELETE FROM memory_entries WHERE memory_key = ?").run(memoryKey);
    } else {
      const placeholders = entries.map(() => "?").join(",");
      const ids = entries.map((e) => e.id);
      db.prepare(
        `DELETE FROM memory_entries WHERE memory_key = ? AND id NOT IN (${placeholders})`
      ).run(memoryKey, ...ids);
    }
  });

  doSave(store.entries);
}

/**
 * Insert a single entry, returning the full MemoryEntry with generated id + createdAt.
 */
export async function addMemoryEntrySqlite(
  memoryKey: string,
  entry: Omit<MemoryEntry, "id" | "createdAt">,
): Promise<MemoryEntry> {
  const db = await getDb();
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
    embedding: entry._embedding
      ? Buffer.from(new Float32Array(entry._embedding).buffer)
      : null,
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
export async function removeMemoryEntrySqlite(memoryKey: string, id: string): Promise<boolean> {
  const db = await getDb();
  const result = db.prepare(
    "DELETE FROM memory_entries WHERE id = ? AND memory_key = ?"
  ).run(id, memoryKey);
  return result.changes > 0;
}

/**
 * FTS5 full-text search over memory_entries for a given memoryKey.
 * Returns non-expired entries matching the query, up to `limit`.
 */
export async function searchMemoryFts(
  memoryKey: string,
  query: string,
  limit = 20,
): Promise<MemoryEntry[]> {
  const db = await getDb();
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
  `).all(ftsQuery, memoryKey, now, limit) as unknown as MemoryRow[];

  return rows.map(rowToEntry);
}

/**
 * Returns all distinct memory_key values in the database.
 */
export async function listMemoryKeysSqlite(): Promise<string[]> {
  const db = await getDb();
  const rows = db.prepare("SELECT DISTINCT memory_key FROM memory_entries ORDER BY memory_key").all() as { memory_key: string }[];
  return rows.map((r) => r.memory_key);
}

/**
 * Deletes all entries for a given memoryKey. Returns the number of deleted rows.
 *
 * The AFTER DELETE trigger on memory_entries fires per row and keeps the FTS5
 * index in sync. An explicit rebuild is issued afterwards to guarantee
 * consistency even if trigger execution had any edge cases.
 */
export async function clearMemoryStoreSqlite(memoryKey: string): Promise<number> {
  const db = await getDb();
  const result = db.prepare("DELETE FROM memory_entries WHERE memory_key = ?").run(memoryKey);
  if (result.changes > 0) {
    // Force a full FTS rebuild to guarantee index consistency after bulk removal.
    db.prepare("INSERT INTO memory_entries_fts(memory_entries_fts) VALUES ('rebuild')").run();
  }
  return result.changes;
}

/**
 * Returns true when SQLite memory is available.
 *
 * SQLite is now the default backend — this returns true unless the user
 * has explicitly opted out with ORAGER_DB_PATH=none or ORAGER_DB_PATH="".
 */
export function isSqliteMemoryEnabled(): boolean {
  return resolveDbPath() !== null;
}
