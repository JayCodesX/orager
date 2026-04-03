/**
 * JSONL-backed session store — ADR-0008 Phase 3.
 *
 * Layout:
 *   ~/.orager/sessions/<sessionId>.jsonl   — append-only transcript (one JSON line per save)
 *   ~/.orager/sessions/index.sqlite        — metadata index, FTS, locks, checkpoints
 *
 * Write path:
 *   save() appends one JSON line (O(1) append, no lock contention) and upserts
 *   the lightweight metadata row in index.sqlite. Drops monolithic-SQLite session
 *   write pressure by ~90%: the large JSON blob never enters SQLite.
 *
 * Read path:
 *   load() reads the JSONL file and returns the last line. O(file_size) on first
 *   call per session; all callers go through the save-queue so concurrent reads
 *   are serialised by session.ts's _saveQueues anyway.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { openDb, type SqliteDatabase } from "./native-sqlite.js";
import { runMigrations, type Migration } from "./db-migrations.js";
import { CURRENT_SESSION_SCHEMA_VERSION, migrateSession } from "./session.js";
import type { SessionData, SessionSummary, PruneResult } from "./types.js";
import type { SessionStore } from "./session-store.js";

const LOCK_STALE_MS = 5 * 60 * 1000;

export class JsonlSessionStore implements SessionStore {
  private constructor(
    private readonly db: SqliteDatabase,
    private readonly sessionsDir: string,
  ) {}

  static async create(sessionsDir: string): Promise<JsonlSessionStore> {
    await fs.mkdir(sessionsDir, { recursive: true });
    const indexPath = path.join(sessionsDir, "index.sqlite");
    const db = await openDb(indexPath);
    const store = new JsonlSessionStore(db, sessionsDir);
    store._migrate();
    return store;
  }

  private _jsonlPath(sessionId: string): string {
    return path.join(this.sessionsDir, `${sessionId}.jsonl`);
  }

  // ── Schema migrations ───────────────────────────────────────────────────────

  private static readonly _migrations: Migration[] = [
    {
      version: 1,
      name: "create_sessions_base",
      sql: `
        CREATE TABLE IF NOT EXISTS sessions (
          session_id  TEXT PRIMARY KEY,
          model       TEXT NOT NULL DEFAULT '',
          created_at  TEXT NOT NULL DEFAULT '',
          updated_at  TEXT NOT NULL DEFAULT '',
          turn_count  INTEGER NOT NULL DEFAULT 0,
          cwd         TEXT NOT NULL DEFAULT '',
          trashed     INTEGER NOT NULL DEFAULT 0,
          summarized  INTEGER NOT NULL DEFAULT 0,
          context_id  TEXT NOT NULL DEFAULT 'default'
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_sessions_trashed    ON sessions(trashed);

        CREATE TABLE IF NOT EXISTS session_locks (
          session_id TEXT PRIMARY KEY,
          pid        INTEGER NOT NULL,
          locked_at  INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS session_checkpoints (
          thread_id   TEXT PRIMARY KEY,
          context_id  TEXT NOT NULL DEFAULT 'default',
          last_turn   INTEGER NOT NULL DEFAULT 0,
          summary     TEXT,
          full_state  JSON,
          updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_checkpoint_context
          ON session_checkpoints(context_id);

        CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
          session_id UNINDEXED,
          content,
          tokenize = 'porter ascii'
        );

        CREATE TRIGGER IF NOT EXISTS sessions_ai AFTER INSERT ON sessions BEGIN
          INSERT INTO sessions_fts(session_id, content)
          VALUES (new.session_id, new.model || ' ' || new.cwd);
        END;
        CREATE TRIGGER IF NOT EXISTS sessions_au AFTER UPDATE ON sessions BEGIN
          DELETE FROM sessions_fts WHERE session_id = old.session_id;
          INSERT INTO sessions_fts(session_id, content)
          VALUES (new.session_id, new.model || ' ' || new.cwd);
        END;
        CREATE TRIGGER IF NOT EXISTS sessions_ad AFTER DELETE ON sessions BEGIN
          DELETE FROM sessions_fts WHERE session_id = old.session_id;
        END;

        INSERT OR IGNORE INTO sessions_fts(session_id, content)
          SELECT session_id, model || ' ' || cwd FROM sessions;
      `,
    },
    {
      version: 2,
      name: "add_cumulative_cost_usd",
      sql: `ALTER TABLE sessions ADD COLUMN cumulative_cost_usd REAL NOT NULL DEFAULT 0`,
    },
  ];

  private _migrate(): void {
    try {
      runMigrations(this.db, JsonlSessionStore._migrations);
    } catch (err) {
      throw new Error(`JsonlSessionStore: schema migration failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── SessionStore interface ──────────────────────────────────────────────────

  async save(data: SessionData): Promise<void> {
    const { sessionId } = data;
    const line = JSON.stringify({ ...data, schemaVersion: CURRENT_SESSION_SCHEMA_VERSION }) + "\n";
    await fs.appendFile(this._jsonlPath(sessionId), line, "utf8");

    // Upsert metadata row (no full JSON blob — index only)
    this.db.prepare(`
      INSERT INTO sessions
        (session_id, model, created_at, updated_at, turn_count, cwd, trashed, summarized, cumulative_cost_usd)
      VALUES
        (@sessionId, @model, @createdAt, @updatedAt, @turnCount, @cwd, @trashed, @summarized, @cumulativeCostUsd)
      ON CONFLICT(session_id) DO UPDATE SET
        model                = excluded.model,
        updated_at           = excluded.updated_at,
        turn_count           = excluded.turn_count,
        cwd                  = excluded.cwd,
        trashed              = excluded.trashed,
        summarized           = excluded.summarized,
        cumulative_cost_usd  = excluded.cumulative_cost_usd
    `).run({
      sessionId,
      model:              data.model,
      createdAt:          data.createdAt,
      updatedAt:          data.updatedAt,
      turnCount:          data.turnCount,
      cwd:                data.cwd ?? "",
      trashed:            data.trashed ? 1 : 0,
      summarized:         data.summarized ? 1 : 0,
      cumulativeCostUsd:  data.cumulativeCostUsd ?? 0,
    });
  }

  async load(sessionId: string): Promise<SessionData | null> {
    const data = await this._readLastLine(sessionId);
    if (!data || data.trashed) return null;
    return migrateSession(data);
  }

  async loadRaw(sessionId: string): Promise<SessionData | null> {
    const data = await this._readLastLine(sessionId);
    if (!data) return null;
    return migrateSession(data);
  }

  private async _readLastLine(sessionId: string): Promise<SessionData | null> {
    try {
      const raw = await fs.readFile(this._jsonlPath(sessionId), "utf8");
      const lines = raw.split("\n").filter((l) => l.trim());
      if (lines.length === 0) return null;
      return JSON.parse(lines[lines.length - 1]!) as SessionData;
    } catch {
      return null;
    }
  }

  async delete(sessionId: string): Promise<void> {
    // Soft delete: mark trashed in index, keep file (consistent with SqliteSessionStore)
    this.db.prepare("UPDATE sessions SET trashed = 1, updated_at = ? WHERE session_id = ?")
      .run(new Date().toISOString(), sessionId);
    // Also update the JSONL file if it exists so load() reflects the trashed state
    const data = await this._readLastLine(sessionId);
    if (data) {
      const line = JSON.stringify({ ...data, trashed: true, schemaVersion: CURRENT_SESSION_SCHEMA_VERSION }) + "\n";
      await fs.appendFile(this._jsonlPath(sessionId), line, "utf8").catch(() => {});
    }
  }

  async list(opts?: { offset?: number; limit?: number }): Promise<SessionSummary[]> {
    const limit  = opts?.limit  ?? 100;
    const offset = opts?.offset ?? 0;
    const rows = this.db.prepare(
      "SELECT session_id, model, created_at, updated_at, turn_count, cwd, trashed, cumulative_cost_usd " +
      "FROM sessions ORDER BY updated_at DESC LIMIT ? OFFSET ?"
    ).all(limit, offset) as Array<{
      session_id: string; model: string; created_at: string;
      updated_at: string; turn_count: number; cwd: string; trashed: number;
      cumulative_cost_usd: number;
    }>;
    return rows.map((r) => ({
      sessionId:         r.session_id,
      model:             r.model,
      createdAt:         r.created_at,
      updatedAt:         r.updated_at,
      turnCount:         r.turn_count,
      cwd:               r.cwd,
      trashed:           r.trashed === 1,
      cumulativeCostUsd: r.cumulative_cost_usd,
    }));
  }

  async prune(olderThanMs: number): Promise<PruneResult> {
    const normalCutoff    = new Date(Date.now() - olderThanMs).toISOString();
    const compactedCutoff = new Date(Date.now() - olderThanMs * 3).toISOString();

    const victims = this.db.prepare(`
      SELECT session_id FROM sessions
      WHERE (summarized = 0 AND updated_at < ?)
         OR (summarized = 1 AND updated_at < ?)
    `).all(normalCutoff, compactedCutoff) as Array<{ session_id: string }>;

    let deleted = 0, errors = 0;
    const del = this.db.prepare("DELETE FROM sessions WHERE session_id = ?");

    for (const r of victims) {
      try {
        del.run(r.session_id);
        await fs.unlink(this._jsonlPath(r.session_id)).catch(() => {});
        deleted++;
      } catch { errors++; }
    }

    const kept = (this.db.prepare("SELECT COUNT(*) as n FROM sessions").get() as { n: number }).n;
    return { deleted, kept, errors };
  }

  async deleteTrash(): Promise<PruneResult> {
    const total   = (this.db.prepare("SELECT COUNT(*) as n FROM sessions").get() as { n: number }).n;
    const trashed = (this.db.prepare("SELECT COUNT(*) as n FROM sessions WHERE trashed=1").get() as { n: number }).n;

    const victims = this.db.prepare("SELECT session_id FROM sessions WHERE trashed = 1")
      .all() as Array<{ session_id: string }>;

    let errors = 0;
    try {
      this.db.prepare("DELETE FROM sessions WHERE trashed = 1").run();
      for (const r of victims) {
        await fs.unlink(this._jsonlPath(r.session_id)).catch(() => {});
      }
    } catch { errors++; }

    return { deleted: trashed, kept: total - trashed, errors };
  }

  async acquireLock(sessionId: string): Promise<() => Promise<void>> {
    const now = Date.now();

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
        this.db.prepare("UPDATE session_locks SET pid=?, locked_at=? WHERE session_id=?")
          .run(process.pid, nowMs, sid);
      } else {
        this.db.prepare("INSERT INTO session_locks (session_id, pid, locked_at) VALUES (?,?,?)")
          .run(sid, process.pid, nowMs);
      }
    });

    tryAcquire.exclusive(sessionId, now);

    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try { this.db.prepare("DELETE FROM session_locks WHERE session_id=?").run(sessionId); }
      catch { /* ignore */ }
    };
  }

  // ── FTS search ──────────────────────────────────────────────────────────────

  search(query: string, limit = 20): SessionSummary[] {
    const sanitized = query.replace(/["*^()[\]{}\\/]/g, " ").trim();
    if (!sanitized) return [];
    const ftsQuery = `"${sanitized.replace(/"/g, '""')}"`;

    const rows = this.db.prepare(`
      SELECT s.session_id, s.model, s.created_at, s.updated_at, s.turn_count, s.cwd, s.trashed, s.cumulative_cost_usd
      FROM sessions_fts f
      JOIN sessions s ON s.session_id = f.session_id
      WHERE sessions_fts MATCH ?
        AND s.trashed = 0
      ORDER BY rank
      LIMIT ?
    `).all(ftsQuery, limit) as Array<{
      session_id: string; model: string; created_at: string;
      updated_at: string; turn_count: number; cwd: string; trashed: number;
      cumulative_cost_usd: number;
    }>;

    return rows.map((r) => ({
      sessionId: r.session_id, model: r.model, createdAt: r.created_at,
      updatedAt: r.updated_at, turnCount: r.turn_count, cwd: r.cwd, trashed: r.trashed === 1,
      cumulativeCostUsd: r.cumulative_cost_usd,
    }));
  }

  // ── Checkpoints (mirrors SqliteSessionStore API) ────────────────────────────

  saveCheckpoint(
    threadId: string,
    contextId: string,
    lastTurn: number,
    summary: string | null,
    recentMessages: unknown[],
  ): void {
    this.db.prepare(`
      INSERT INTO session_checkpoints
        (thread_id, context_id, last_turn, summary, full_state, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(thread_id) DO UPDATE SET
        context_id = excluded.context_id,
        last_turn  = excluded.last_turn,
        summary    = COALESCE(excluded.summary, session_checkpoints.summary),
        full_state = excluded.full_state,
        updated_at = excluded.updated_at
    `).run(threadId, contextId, lastTurn, summary, JSON.stringify(recentMessages));
  }

  loadCheckpoint(threadId: string): {
    threadId: string; contextId: string; lastTurn: number;
    summary: string | null; fullState: unknown[];
  } | null {
    const row = this.db.prepare(`
      SELECT thread_id, context_id, last_turn, summary, full_state
      FROM session_checkpoints WHERE thread_id = ?
    `).get(threadId) as {
      thread_id: string; context_id: string; last_turn: number;
      summary: string | null; full_state: string;
    } | undefined;

    if (!row) return null;
    let fullState: unknown[] = [];
    try { fullState = JSON.parse(row.full_state) as unknown[]; } catch { /* ignore */ }
    return { threadId: row.thread_id, contextId: row.context_id,
             lastTurn: row.last_turn, summary: row.summary, fullState };
  }

  loadLatestCheckpointByContextId(contextId: string): {
    threadId: string; contextId: string; lastTurn: number;
    summary: string | null; fullState: unknown[];
  } | null {
    const row = this.db.prepare(`
      SELECT thread_id, context_id, last_turn, summary, full_state
      FROM session_checkpoints
      WHERE context_id = ? AND summary IS NOT NULL
      ORDER BY updated_at DESC, rowid DESC LIMIT 1
    `).get(contextId) as {
      thread_id: string; context_id: string; last_turn: number;
      summary: string | null; full_state: string;
    } | undefined;

    if (!row) return null;
    let fullState: unknown[] = [];
    try { fullState = JSON.parse(row.full_state) as unknown[]; } catch { /* ignore */ }
    return { threadId: row.thread_id, contextId: row.context_id,
             lastTurn: row.last_turn, summary: row.summary, fullState };
  }
}
