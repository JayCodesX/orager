/**
 * SQLite-backed session store using better-sqlite3 (synchronous API).
 *
 * Activated when ORAGER_DB_PATH env var is set.
 * Schema: sessions table (indexed columns + full JSON data column)
 *         session_locks table (advisory locking)
 *
 * WAL mode is enabled for better concurrent read performance.
 */
import Database from "better-sqlite3";
import type { Database as DB } from "better-sqlite3";
import type { SessionData, SessionSummary, PruneResult } from "./types.js";
import type { SessionStore } from "./session-store.js";
import { CURRENT_SESSION_SCHEMA_VERSION, migrateSession } from "./session.js";

const LOCK_STALE_MS = 5 * 60 * 1000;

export class SqliteSessionStore implements SessionStore {
  private readonly db: DB;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("synchronous = NORMAL");
    this._migrate();
  }

  private _migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id  TEXT PRIMARY KEY,
        model       TEXT NOT NULL DEFAULT '',
        created_at  TEXT NOT NULL DEFAULT '',
        updated_at  TEXT NOT NULL DEFAULT '',
        turn_count  INTEGER NOT NULL DEFAULT 0,
        cwd         TEXT NOT NULL DEFAULT '',
        trashed     INTEGER NOT NULL DEFAULT 0,
        summarized  INTEGER NOT NULL DEFAULT 0,
        data        TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sessions_trashed    ON sessions(trashed);

      CREATE TABLE IF NOT EXISTS session_locks (
        session_id TEXT PRIMARY KEY,
        pid        INTEGER NOT NULL,
        locked_at  INTEGER NOT NULL
      );
    `);
    // FTS5 virtual table for full-text search over session summaries
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
        session_id UNINDEXED,
        content,
        tokenize = 'porter ascii'
      );
    `);
  }

  async save(data: SessionData): Promise<void> {
    this.db.prepare(`
      INSERT INTO sessions
        (session_id, model, created_at, updated_at, turn_count, cwd, trashed, summarized, data)
      VALUES
        (@sessionId, @model, @createdAt, @updatedAt, @turnCount, @cwd, @trashed, @summarized, @data)
      ON CONFLICT(session_id) DO UPDATE SET
        model      = excluded.model,
        updated_at = excluded.updated_at,
        turn_count = excluded.turn_count,
        cwd        = excluded.cwd,
        trashed    = excluded.trashed,
        summarized = excluded.summarized,
        data       = excluded.data
    `).run({
      sessionId:  data.sessionId,
      model:      data.model,
      createdAt:  data.createdAt,
      updatedAt:  data.updatedAt,
      turnCount:  data.turnCount,
      cwd:        data.cwd ?? "",
      trashed:    data.trashed ? 1 : 0,
      summarized: data.summarized ? 1 : 0,
      data:       JSON.stringify({ ...data, schemaVersion: CURRENT_SESSION_SCHEMA_VERSION }),
    });
  }

  async load(sessionId: string): Promise<SessionData | null> {
    const row = this.db
      .prepare("SELECT data FROM sessions WHERE session_id = ? AND trashed = 0")
      .get(sessionId) as { data: string } | undefined;
    if (!row) return null;
    try { return migrateSession(JSON.parse(row.data) as SessionData); } catch { return null; }
  }

  async loadRaw(sessionId: string): Promise<SessionData | null> {
    const row = this.db
      .prepare("SELECT data FROM sessions WHERE session_id = ?")
      .get(sessionId) as { data: string } | undefined;
    if (!row) return null;
    try { return migrateSession(JSON.parse(row.data) as SessionData); } catch { return null; }
  }

  async delete(sessionId: string): Promise<void> {
    this.db.prepare("DELETE FROM sessions WHERE session_id = ?").run(sessionId);
  }

  async list(_opts?: { offset?: number; limit?: number }): Promise<SessionSummary[]> {
    const rows = this.db.prepare(
      "SELECT session_id, model, created_at, updated_at, turn_count, cwd, trashed " +
      "FROM sessions ORDER BY updated_at DESC"
    ).all() as Array<{
      session_id: string; model: string; created_at: string;
      updated_at: string; turn_count: number; cwd: string; trashed: number;
    }>;
    return rows.map((r) => ({
      sessionId:  r.session_id,
      model:      r.model,
      createdAt:  r.created_at,
      updatedAt:  r.updated_at,
      turnCount:  r.turn_count,
      cwd:        r.cwd,
      trashed:    r.trashed === 1,
    }));
  }

  async prune(olderThanMs: number): Promise<PruneResult> {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const victims = this.db
      .prepare("SELECT session_id FROM sessions WHERE updated_at < ?")
      .all(cutoff) as Array<{ session_id: string }>;
    let deleted = 0, errors = 0;
    const del = this.db.prepare("DELETE FROM sessions WHERE session_id = ?");
    for (const r of victims) {
      try { del.run(r.session_id); deleted++; } catch { errors++; }
    }
    const kept = (this.db.prepare("SELECT COUNT(*) as n FROM sessions").get() as { n: number }).n;
    return { deleted, kept, errors };
  }

  async deleteTrash(): Promise<PruneResult> {
    const total = (this.db.prepare("SELECT COUNT(*) as n FROM sessions").get() as { n: number }).n;
    const trashed = (this.db.prepare("SELECT COUNT(*) as n FROM sessions WHERE trashed=1").get() as { n: number }).n;
    let errors = 0;
    try { this.db.prepare("DELETE FROM sessions WHERE trashed = 1").run(); }
    catch { errors++; }
    return { deleted: trashed, kept: total - trashed, errors };
  }

  search(query: string, limit = 20): SessionSummary[] {
    // Sanitize query for FTS5: strip operator characters and wrap as a phrase
    // so the input is treated as a literal string search, not a query expression.
    // FTS5 operators that need escaping: " * ^ ( ) [ ] { }
    const sanitized = query.replace(/["*^()[\]{}]/g, " ").trim();
    if (!sanitized) return [];
    // Wrap in double-quotes to produce a phrase search; escape any remaining quotes
    const ftsQuery = `"${sanitized.replace(/"/g, '""')}"`;

    // Update FTS index from sessions table
    this.db.exec(`
      INSERT OR REPLACE INTO sessions_fts(session_id, content)
      SELECT session_id, model || ' ' || cwd || ' ' || substr(data, 1, 2000)
      FROM sessions
      WHERE trashed = 0
    `);
    const rows = this.db.prepare(`
      SELECT s.session_id, s.model, s.created_at, s.updated_at, s.turn_count, s.cwd, s.trashed
      FROM sessions_fts f
      JOIN sessions s ON s.session_id = f.session_id
      WHERE sessions_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(ftsQuery, limit) as Array<{
      session_id: string; model: string; created_at: string;
      updated_at: string; turn_count: number; cwd: string; trashed: number;
    }>;
    return rows.map((r) => ({
      sessionId: r.session_id, model: r.model, createdAt: r.created_at,
      updatedAt: r.updated_at, turnCount: r.turn_count, cwd: r.cwd, trashed: r.trashed === 1,
    }));
  }

  async acquireLock(sessionId: string): Promise<() => Promise<void>> {
    const now = Date.now();

    // Wrap SELECT + INSERT/UPDATE in an exclusive transaction to prevent the
    // TOCTOU race where two processes both see no lock and both INSERT.
    const tryAcquire = this.db.transaction((sid: string, nowMs: number) => {
      const existing = this.db
        .prepare("SELECT pid, locked_at FROM session_locks WHERE session_id = ?")
        .get(sid) as { pid: number; locked_at: number } | undefined;

      if (existing) {
        const age = nowMs - existing.locked_at;
        if (age < LOCK_STALE_MS) {
          throw Object.assign(
            new Error(
              `Session ${sid} is already being resumed by PID ${existing.pid}. ` +
              `Clears automatically in ${Math.ceil((LOCK_STALE_MS - age) / 1000)}s.`,
            ),
            { code: "SESSION_LOCKED" },
          );
        }
        // Stale lock — overwrite atomically
        this.db.prepare(
          "UPDATE session_locks SET pid=?, locked_at=? WHERE session_id=?"
        ).run(process.pid, nowMs, sid);
      } else {
        this.db.prepare(
          "INSERT INTO session_locks (session_id, pid, locked_at) VALUES (?,?,?)"
        ).run(sid, process.pid, nowMs);
      }
    });

    // .exclusive() issues BEGIN EXCLUSIVE — only one writer can hold this at a time
    tryAcquire.exclusive(sessionId, now);

    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try { this.db.prepare("DELETE FROM session_locks WHERE session_id=?").run(sessionId); }
      catch { /* ignore */ }
    };
  }
}
