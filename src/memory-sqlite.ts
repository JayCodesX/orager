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
import { openDb, isSqliteVecAvailable } from "./native-sqlite.js";
import type { SqliteDatabase } from "./native-sqlite.js";
import { runMigrations } from "./db-migrations.js";
import crypto from "node:crypto";
import type { MemoryStore, MemoryEntry } from "./memory.js";
import { resolveDbPath, resolveMemoryDir, sanitizeKeyForFilename, checkDbSize } from "./db.js";
import { mkdirSync } from "node:fs";
import path from "node:path";

// ── Per-namespace DB map ───────────────────────────────────────────────────────
// Each memoryKey gets its own SQLite file. The map caches open connections.

const _dbs = new Map<string, SqliteDatabase>();

/**
 * Returns the on-disk path for a given memoryKey's SQLite file.
 * ~/.orager/memory/<sanitizedKey>.sqlite
 */
export function resolveMemoryDbPath(memoryKey: string): string {
  const dir = resolveMemoryDir();
  return path.join(dir, `${sanitizeKeyForFilename(memoryKey)}.sqlite`);
}

async function getDb(memoryKey: string): Promise<SqliteDatabase> {
  const existing = _dbs.get(memoryKey);
  if (existing) return existing;

  const dbPath = resolveMemoryDbPath(memoryKey);
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = await openDb(dbPath);
  _migrate(db);
  _logDbSize(db, memoryKey);
  _dbs.set(memoryKey, db);
  return db;
}

function _logDbSize(db: SqliteDatabase, memoryKey: string): void {
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

const MEMORY_MIGRATIONS = [
  {
    version: 1,
    name: "create_memory_entries_base",
    sql: `
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
      CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `,
  },
  {
    version: 2,
    name: "add_context_id",
    sql: `ALTER TABLE memory_entries ADD COLUMN context_id TEXT NOT NULL DEFAULT 'default'`,
  },
  {
    version: 3,
    name: "add_type",
    sql: `ALTER TABLE memory_entries ADD COLUMN type TEXT NOT NULL DEFAULT 'insight'`,
  },
  {
    version: 4,
    name: "add_metadata_and_index",
    sql: `
      ALTER TABLE memory_entries ADD COLUMN metadata JSON;
      UPDATE memory_entries
        SET metadata = json_object('tags', COALESCE(tags, '[]'), 'importance', importance)
        WHERE metadata IS NULL;
      CREATE INDEX IF NOT EXISTS idx_context_type ON memory_entries(context_id, type);
    `,
  },
];

function _migrate(db: SqliteDatabase): void {
  runMigrations(db, MEMORY_MIGRATIONS);

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

  // Backfill vec index from existing embeddings (no-op when sqlite-vec unavailable).
  // Called once per process per DB open; _rebuildVecForNamespace is idempotent.
  _rebuildVecForNamespace(db);
}

// ── sqlite-vec ANN helpers ────────────────────────────────────────────────────

/**
 * Create (or verify) the memory_entry_vectors vec0 virtual table.
 * Returns true when the table is ready for use with the given dimension.
 * If the stored dimension differs (model swap), drops and recreates the table.
 */
function _ensureVecTable(db: SqliteDatabase, dim: number): boolean {
  if (!isSqliteVecAvailable()) return false;
  try {
    const dimRow = db.prepare("SELECT value FROM _meta WHERE key = 'vec_dim'").get() as { value: string } | undefined;
    if (dimRow) {
      if (parseInt(dimRow.value, 10) === dim) return true;
      // Dimension changed (embedding model swap) — drop and recreate
      db.exec("DROP TABLE IF EXISTS memory_entry_vectors");
      db.prepare("DELETE FROM _meta WHERE key = 'vec_dim'").run();
    }
    db.exec(`CREATE VIRTUAL TABLE memory_entry_vectors USING vec0(embedding float[${dim}])`);
    db.prepare("INSERT INTO _meta (key, value) VALUES ('vec_dim', ?)").run(String(dim));
    return true;
  } catch {
    return false;
  }
}

/**
 * Rebuild the memory_entry_vectors table from scratch for all embeddings in
 * this DB. Called on DB open (backfill) and after saveMemoryStoreSqlite.
 * No-op when sqlite-vec is unavailable or there are no embeddings.
 */
function _rebuildVecForNamespace(db: SqliteDatabase): void {
  if (!isSqliteVecAvailable()) return;
  try {
    const embRows = db.prepare(
      "SELECT rowid, embedding FROM memory_entries WHERE embedding IS NOT NULL",
    ).all() as { rowid: number; embedding: Uint8Array }[];
    if (embRows.length === 0) return;

    const dim = embRows[0]!.embedding.byteLength / 4;
    if (!_ensureVecTable(db, dim)) return;

    db.transaction(() => {
      db.exec("DELETE FROM memory_entry_vectors");
      const ins = db.prepare("INSERT INTO memory_entry_vectors (rowid, embedding) VALUES (?, ?)");
      for (const row of embRows) {
        try { ins.run(row.rowid, row.embedding); } catch { /* skip malformed */ }
      }
    })();
  } catch { /* graceful — ANN unavailable, brute-force fallback active */ }
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
  // ON CONFLICT DO UPDATE preserves the existing rowid (unlike INSERT OR REPLACE which
  // deletes + reinserts and would break the sqlite-vec ANN index rowid references).
  const upsert = db.prepare(`
    INSERT INTO memory_entries
      (id, memory_key, content, tags, created_at, expires_at, run_id, importance, embedding, embedding_model)
    VALUES
      (@id, @memoryKey, @content, @tags, @createdAt, @expiresAt, @runId, @importance, @embedding, @embeddingModel)
    ON CONFLICT(id) DO UPDATE SET
      memory_key      = excluded.memory_key,
      content         = excluded.content,
      tags            = excluded.tags,
      created_at      = excluded.created_at,
      expires_at      = excluded.expires_at,
      run_id          = excluded.run_id,
      importance      = excluded.importance,
      embedding       = excluded.embedding,
      embedding_model = excluded.embedding_model
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
  // Rebuild ANN index to reflect any inserts, updates, or deletions.
  _rebuildVecForNamespace(db);
}

export async function addMemoryEntrySqlite(
  memoryKey: string,
  entry: Omit<MemoryEntry, "id" | "createdAt">,
): Promise<MemoryEntry> {
  const db = await getDb(memoryKey);
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  const embeddingBlob = entry._embedding ? Buffer.from(new Float32Array(entry._embedding).buffer) : null;

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
    embedding: embeddingBlob,
    embeddingModel: entry._embeddingModel ?? null,
    type: entry.type ?? "insight",
  });

  // Sync to ANN index immediately so the new entry is searchable without waiting
  // for the next saveMemoryStoreSqlite rebuild.
  if (embeddingBlob && entry._embedding && isSqliteVecAvailable()) {
    try {
      const row = db.prepare("SELECT rowid FROM memory_entries WHERE id = ?").get(id) as { rowid: number } | undefined;
      if (row && _ensureVecTable(db, entry._embedding.length)) {
        db.prepare("INSERT OR REPLACE INTO memory_entry_vectors (rowid, embedding) VALUES (?, ?)").run(
          row.rowid, embeddingBlob,
        );
      }
    } catch { /* graceful — next saveMemoryStoreSqlite will rebuild */ }
  }

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
  const placeholders = ids.map(() => "?").join(",");
  for (const db of _dbs.values()) {
    try {
      db.transaction(() => {
        // Collect rowids before deletion so we can sync the vec index.
        let rowids: number[] = [];
        if (isSqliteVecAvailable()) {
          try {
            rowids = (db.prepare(
              `SELECT rowid FROM memory_entries WHERE id IN (${placeholders})`,
            ).all(...ids) as { rowid: number }[]).map((r) => r.rowid);
          } catch { /* ignore */ }
        }
        db.prepare(`DELETE FROM memory_entries WHERE id IN (${placeholders})`).run(...ids);
        if (rowids.length > 0) {
          const rp = rowids.map(() => "?").join(",");
          try {
            db.prepare(`DELETE FROM memory_entry_vectors WHERE rowid IN (${rp})`).run(...rowids);
          } catch { /* vec table may not exist yet — no-op */ }
        }
      })();
    } catch { /* ignore */ }
  }
}

/**
 * ANN embedding retrieval using the sqlite-vec memory_entry_vectors index.
 *
 * Returns a ranked list of up to `topK` entries whose stored embedding is
 * nearest to `queryEmbedding`, re-ranked with the same importance × recency
 * weights used by the brute-force path.
 *
 * Returns null when:
 *  - sqlite-vec is unavailable on this process
 *  - the vec table does not exist yet (no embeddings ever stored)
 *  - the embedding dimension doesn't match (model was swapped)
 *  - any SQLite error occurs
 *
 * Callers must fall back to retrieveEntriesWithEmbeddings() when null is returned.
 */
export async function retrieveEntriesANNSqlite(
  memoryKey: string,
  queryEmbedding: number[],
  topK: number,
): Promise<MemoryEntry[] | null> {
  if (!isSqliteVecAvailable() || queryEmbedding.length === 0) return null;

  const db = await getDb(memoryKey);

  // Verify the vec table exists with a matching dimension
  const dimRow = db.prepare("SELECT value FROM _meta WHERE key = 'vec_dim'").get() as { value: string } | undefined;
  if (!dimRow || parseInt(dimRow.value, 10) !== queryEmbedding.length) return null;

  const now = new Date().toISOString();

  try {
    const queryBlob = new Uint8Array(new Float32Array(queryEmbedding).buffer);
    // Fetch topK*2 candidates to give buffer for post-filter and reranking.
    const annRows = db.prepare(`
      SELECT rowid, distance
      FROM memory_entry_vectors
      WHERE embedding MATCH ?
        AND k = ?
    `).all(queryBlob, topK * 2) as { rowid: number; distance: number }[];

    if (annRows.length === 0) return [];

    const distanceByRowid = new Map(annRows.map((r) => [r.rowid, r.distance]));
    const rowids = annRows.map((r) => r.rowid);
    const rp = rowids.map(() => "?").join(",");

    // Load full entry data and apply expiry + namespace + type filters
    const rows = db.prepare(`
      SELECT rowid, id, memory_key, content, tags, created_at, expires_at,
             run_id, importance, embedding, embedding_model
      FROM memory_entries
      WHERE rowid IN (${rp})
        AND memory_key = ?
        AND (expires_at IS NULL OR expires_at > ?)
        AND type != 'master_context'
    `).all(...rowids, memoryKey, now) as unknown as (MemoryRow & { rowid: number })[];

    // Re-rank with exact cosine similarity + importance × recency
    // (same formula as retrieveEntriesWithEmbeddings in memory.ts)
    const scored = rows.map((row) => {
      const entry = rowToEntry(row);
      const importanceWeight = entry.importance === 3 ? 1.5 : entry.importance === 2 ? 1.0 : 0.6;
      const days = (Date.now() - Date.parse(entry.createdAt)) / 86400000;
      const recencyDecay = 1 / (1 + days / 30);

      let score = 0;
      if (entry._embedding && entry._embedding.length === queryEmbedding.length) {
        // Exact cosine similarity for precise reranking over ANN candidates
        let dot = 0, magA = 0, magB = 0;
        for (let i = 0; i < queryEmbedding.length; i++) {
          dot  += queryEmbedding[i]! * entry._embedding[i]!;
          magA += queryEmbedding[i]! * queryEmbedding[i]!;
          magB += entry._embedding[i]! * entry._embedding[i]!;
        }
        const denom = Math.sqrt(magA) * Math.sqrt(magB);
        score = denom === 0 ? 0 : (dot / denom) * importanceWeight * recencyDecay;
      } else {
        // Embedding missing or mismatched — use L2 distance as a proxy score
        const d = distanceByRowid.get(row.rowid) ?? 2;
        score = (1 / (1 + d)) * importanceWeight * recencyDecay;
      }
      return { entry, score };
    });

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(({ entry }) => entry);
  } catch {
    return null; // signal caller to use brute-force fallback
  }
}

/**
 * @internal — exposed for skillbank.ts so it can get a DB connection for a
 * given memory namespace (where skills co-locate with memory).
 * @deprecated Use resolveSkillsDbPath() + openDb() in skillbank directly.
 */
export { getDb as _getDb };
