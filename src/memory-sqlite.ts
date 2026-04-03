/**
 * SQLite-backed memory store — ADR-0008 Phase 2.
 *
 * Per-namespace SQLite files: ~/.orager/memory/<memoryKey>.sqlite
 * One file per memory namespace eliminates cross-agent write contention.
 * Agents operating in different namespaces never touch the same file.
 * Agents sharing a namespace get real WAL concurrency — unlimited readers,
 * serialised writers that queue rather than fail (busy_timeout=5000).
 *
 * Skills table has been moved to skillbank's own DB (~/.orager/skills/).
 */
import { openWasmDb } from "./native-sqlite.js";
import type { WasmDatabase } from "./native-sqlite.js";
import crypto from "node:crypto";
import type { MemoryStore, MemoryEntry } from "./memory.js";
import { resolveDbPath, resolveMemoryDir, sanitizeKeyForFilename, checkDbSize } from "./db.js";
import { mkdirSync } from "node:fs";
import path from "node:path";

// ── Per-namespace DB map ───────────────────────────────────────────────────────
// Each memoryKey gets its own SQLite file. The map caches open connections.

const _dbs = new Map<string, WasmDatabase>();

/**
 * Returns the on-disk path for a given memoryKey's SQLite file.
 * ~/.orager/memory/<sanitizedKey>.sqlite
 */
export function resolveMemoryDbPath(memoryKey: string): string {
  const dir = resolveMemoryDir();
  return path.join(dir, `${sanitizeKeyForFilename(memoryKey)}.sqlite`);
}

async function getDb(memoryKey: string): Promise<WasmDatabase> {
  const existing = _dbs.get(memoryKey);
  if (existing) return existing;

  const dbPath = resolveMemoryDbPath(memoryKey);
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = await openWasmDb(dbPath);
  _migrate(db);
  _logDbSize(db, memoryKey);
  _dbs.set(memoryKey, db);
  return db;
}

function _logDbSize(db: WasmDatabase, memoryKey: string): void {
  const status = checkDbSize(db);
  if (status === "prune") {
    process.stderr.write(
      `[orager] WARNING: memory DB "${memoryKey}" ≥80 MB — consider 'remember reset' or memory consolidation.\n`
    );
  } else if (status === "warn") {
    process.stderr.write(
      `[orager] INFO: memory DB "${memoryKey}" ≥50 MB — approaching budget.\n`
    );
  }
}

/**
 * Close the SQLite connection for a specific memoryKey, or all if omitted.
 * Call before process exit to ensure WAL is checkpointed.
 */
export function closeDb(memoryKey?: string): void {
  if (memoryKey) {
    const db = _dbs.get(memoryKey);
    if (db) {
      try { db.close(); } catch { /* ignore */ }
      _dbs.delete(memoryKey);
    }
  } else {
    for (const [key, db] of _dbs) {
      try { db.close(); } catch { /* ignore */ }
      _dbs.delete(key);
    }
  }
}

/** Reset all singletons — for testing only. */
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

  // ── Additive migrations ───────────────────────────────────────────────────
  const existingCols = new Set(
    (db.prepare("SELECT name FROM pragma_table_info('memory_entries')").all() as { name: string }[])
      .map((r) => r.name)
  );

  if (!existingCols.has("context_id")) {
    db.exec(`ALTER TABLE memory_entries ADD COLUMN context_id TEXT NOT NULL DEFAULT 'default'`);
  }
  if (!existingCols.has("type")) {
    db.exec(`ALTER TABLE memory_entries ADD COLUMN type TEXT NOT NULL DEFAULT 'insight'`);
  }
  if (!existingCols.has("metadata")) {
    db.exec(`ALTER TABLE memory_entries ADD COLUMN metadata JSON`);
    db.exec(`
      UPDATE memory_entries
      SET metadata = json_object(
        'tags',       COALESCE(tags, '[]'),
        'importance', importance
      )
      WHERE metadata IS NULL
    `);
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_context_type ON memory_entries(context_id, type);
  `);

  // One-time migration: convert legacy JSON-string embeddings to binary Float32 BLOB.
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
        const f32 = new Float32Array(
          row.embedding.buffer,
          row.embedding.byteOffset,
          row.embedding.byteLength / 4,
        );
        entry._embedding = Array.from(f32);
      } else {
        entry._embedding = JSON.parse(row.embedding) as number[];
      }
    } catch { /* ignore */ }
  }
  if (row.embedding_model) entry._embeddingModel = row.embedding_model;
  return entry;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function loadMemoryStoreSqlite(memoryKey: string): Promise<MemoryStore> {
  const db = await getDb(memoryKey);
  const now = new Date().toISOString();

  const doLoad = db.transaction((key: string, nowIso: string) => {
    db.prepare(
      "DELETE FROM memory_entries WHERE memory_key = ? AND expires_at IS NOT NULL AND expires_at <= ?"
    ).run(key, nowIso);
    const rows = db.prepare(
      "SELECT id, memory_key, content, tags, created_at, expires_at, run_id, importance, embedding, embedding_model " +
      "FROM memory_entries WHERE memory_key = ?"
    ).all(key) as unknown as MemoryRow[];
    return rows;
  });

  const rows = doLoad(memoryKey, now);
  return { memoryKey, entries: rows.map(rowToEntry), updatedAt: now };
}

export async function saveMemoryStoreSqlite(memoryKey: string, store: MemoryStore): Promise<void> {
  const db = await getDb(memoryKey);
  const upsert = db.prepare(`
    INSERT OR REPLACE INTO memory_entries
      (id, memory_key, content, tags, created_at, expires_at, run_id, importance, embedding, embedding_model)
    VALUES
      (@id, @memoryKey, @content, @tags, @createdAt, @expiresAt, @runId, @importance, @embedding, @embeddingModel)
  `);

  const doSave = db.transaction((entries: MemoryEntry[]) => {
    for (const e of entries) {
      upsert.run({
        id: e.id, memoryKey, content: e.content,
        tags: e.tags ? JSON.stringify(e.tags) : null,
        createdAt: e.createdAt, expiresAt: e.expiresAt ?? null, runId: e.runId ?? null,
        importance: e.importance,
        embedding: e._embedding ? new Uint8Array(new Float32Array(e._embedding).buffer) : null,
        embeddingModel: e._embeddingModel ?? null,
      });
    }
    if (entries.length === 0) {
      db.prepare("DELETE FROM memory_entries WHERE memory_key = ?").run(memoryKey);
    } else {
      const placeholders = entries.map(() => "?").join(",");
      db.prepare(
        `DELETE FROM memory_entries WHERE memory_key = ? AND id NOT IN (${placeholders})`
      ).run(memoryKey, ...entries.map((e) => e.id));
    }
  });

  doSave(store.entries);
}

export async function addMemoryEntrySqlite(
  memoryKey: string,
  entry: Omit<MemoryEntry, "id" | "createdAt">,
): Promise<MemoryEntry> {
  const db = await getDb(memoryKey);
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  db.prepare(`
    INSERT INTO memory_entries
      (id, memory_key, content, tags, created_at, expires_at, run_id, importance, embedding, embedding_model, type)
    VALUES
      (@id, @memoryKey, @content, @tags, @createdAt, @expiresAt, @runId, @importance, @embedding, @embeddingModel, @type)
  `).run({
    id, memoryKey, content: entry.content,
    tags: entry.tags ? JSON.stringify(entry.tags) : null,
    createdAt, expiresAt: entry.expiresAt ?? null, runId: entry.runId ?? null,
    importance: entry.importance ?? 2,
    embedding: entry._embedding ? Buffer.from(new Float32Array(entry._embedding).buffer) : null,
    embeddingModel: entry._embeddingModel ?? null,
    type: entry.type ?? "insight",
  });

  return { ...entry, id, createdAt, importance: entry.importance ?? 2 };
}

export async function removeMemoryEntrySqlite(memoryKey: string, id: string): Promise<boolean> {
  const db = await getDb(memoryKey);
  const result = db.prepare(
    "DELETE FROM memory_entries WHERE id = ? AND memory_key = ?"
  ).run(id, memoryKey);
  return result.changes > 0;
}

export async function searchMemoryFts(
  memoryKey: string,
  query: string,
  limit = 20,
): Promise<MemoryEntry[]> {
  const db = await getDb(memoryKey);
  const now = new Date().toISOString();
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
 * FTS5 full-text search across multiple memoryKeys.
 * ADR-0008: opens each namespace's DB separately and merges results in JS.
 */
export async function searchMemoryFtsMulti(
  keys: string[],
  query: string,
  limit = 20,
): Promise<MemoryEntry[]> {
  if (keys.length === 0) return [];
  if (keys.length === 1) return searchMemoryFts(keys[0]!, query, limit);

  // Open each namespace DB and search independently, then merge by FTS rank proxy
  const perKeyResults = await Promise.all(
    keys.map((key) => searchMemoryFts(key, query, limit))
  );
  // Flatten and de-duplicate by id, keeping first occurrence (highest rank)
  const seen = new Set<string>();
  const merged: MemoryEntry[] = [];
  for (const results of perKeyResults) {
    for (const entry of results) {
      if (!seen.has(entry.id)) {
        seen.add(entry.id);
        merged.push(entry);
      }
    }
    if (merged.length >= limit) break;
  }
  return merged.slice(0, limit);
}

export async function listMemoryKeysSqlite(): Promise<string[]> {
  // With per-namespace files, enumerate by reading the memory directory
  const { readdirSync } = await import("node:fs");
  const dir = resolveMemoryDir();
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".sqlite"))
      .map((f) => f.slice(0, -7)); // strip .sqlite
  } catch {
    return [];
  }
}

export async function clearMemoryStoreSqlite(memoryKey: string): Promise<number> {
  const db = await getDb(memoryKey);
  const result = db.prepare("DELETE FROM memory_entries WHERE memory_key = ?").run(memoryKey);
  if (result.changes > 0) {
    db.prepare("INSERT INTO memory_entries_fts(memory_entries_fts) VALUES ('rebuild')").run();
  }
  return result.changes;
}

export function isSqliteMemoryEnabled(): boolean {
  return resolveDbPath() !== null;
}

// ── Master context (Layer 1) ──────────────────────────────────────────────────

export const MASTER_CONTEXT_MAX_CHARS = 8_000;

export async function loadMasterContext(contextId: string): Promise<string | null> {
  const db = await getDb(contextId);
  const row = db.prepare(
    `SELECT content FROM memory_entries
     WHERE context_id = ? AND type = 'master_context'
     ORDER BY created_at DESC LIMIT 1`
  ).get(contextId) as { content: string } | undefined;
  return row?.content ?? null;
}

export async function upsertMasterContext(contextId: string, content: string): Promise<void> {
  const db = await getDb(contextId);
  const trimmed = content.slice(0, MASTER_CONTEXT_MAX_CHARS);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  db.transaction(() => {
    db.prepare(
      `DELETE FROM memory_entries WHERE context_id = ? AND type = 'master_context'`
    ).run(contextId);
    db.prepare(`
      INSERT INTO memory_entries
        (id, memory_key, context_id, type, content, tags, created_at, importance)
      VALUES (?, ?, ?, 'master_context', ?, '[]', ?, 3)
    `).run(id, contextId, contextId, trimmed, now);
  })();
}

// ── Distillation helpers ──────────────────────────────────────────────────────

export async function getMemoryEntryCount(memoryKey: string): Promise<number> {
  const db = await getDb(memoryKey);
  const now = new Date().toISOString();
  const row = db.prepare(
    `SELECT COUNT(*) AS count FROM memory_entries
     WHERE memory_key = ?
       AND (expires_at IS NULL OR expires_at > ?)
       AND type != 'master_context'`
  ).get(memoryKey, now) as { count: number } | undefined;
  return row?.count ?? 0;
}

export async function getEntriesForDistillation(
  memoryKey: string,
  limit: number,
): Promise<MemoryEntry[]> {
  const db = await getDb(memoryKey);
  const now = new Date().toISOString();
  const rows = db.prepare(`
    SELECT id, memory_key, content, tags, created_at, expires_at, run_id,
           importance, embedding, embedding_model
    FROM memory_entries
    WHERE memory_key = ?
      AND (expires_at IS NULL OR expires_at > ?)
      AND importance < 3
      AND type != 'master_context'
    ORDER BY importance ASC, created_at ASC
    LIMIT ?
  `).all(memoryKey, now, limit) as unknown as MemoryRow[];
  return rows.map(rowToEntry);
}

export async function deleteMemoryEntriesByIds(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  // Group by memoryKey since ids may span namespaces — load each affected DB
  // Simplification: scan all open DBs for the given ids
  const placeholders = ids.map(() => "?").join(",");
  for (const db of _dbs.values()) {
    try {
      db.prepare(`DELETE FROM memory_entries WHERE id IN (${placeholders})`).run(...ids);
    } catch { /* ignore */ }
  }
}

/**
 * @internal — exposed for skillbank.ts so it can get a DB connection for a
 * given memory namespace (where skills co-locate with memory).
 * @deprecated Use resolveSkillsDbPath() + openWasmDb() in skillbank directly.
 */
export { getDb as _getDb };
