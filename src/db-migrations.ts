/**
 * Centralised SQLite migration runner.
 *
 * Replaces the scattered ALTER TABLE checks in memory-sqlite.ts,
 * session-jsonl-store.ts, and skillbank.ts with a versioned, tracked system.
 *
 * Each database file gets its own `_schema_migrations` table that records
 * which migrations have been applied. Migrations run in version order inside
 * a single transaction — all succeed or none do.
 *
 * Usage:
 *   import { runMigrations } from "./db-migrations.js";
 *   runMigrations(db, MEMORY_MIGRATIONS);
 */

import type { SqliteDatabase } from "./native-sqlite.js";

export interface Migration {
  /** Monotonically increasing integer — never reuse or reorder. */
  version: number;
  /** Human-readable description shown in logs. */
  name: string;
  /** SQL to execute (can be multiple statements separated by semicolons). */
  sql: string;
}

/**
 * Apply pending migrations to `db`.
 * Creates `_schema_migrations` if it does not exist, then runs any
 * migrations whose version is not yet recorded, in order.
 */
export function runMigrations(db: SqliteDatabase, migrations: Migration[]): void {
  // Ensure the tracking table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS _schema_migrations (
      version     INTEGER PRIMARY KEY,
      name        TEXT    NOT NULL,
      applied_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Fetch already-applied versions
  const applied = new Set<number>(
    (db.prepare("SELECT version FROM _schema_migrations").all() as { version: number }[])
      .map((r) => r.version),
  );

  // Sort by version ascending (defensive — callers should already be sorted)
  const pending = migrations
    .filter((m) => !applied.has(m.version))
    .sort((a, b) => a.version - b.version);

  if (pending.length === 0) return;

  const insertMigration = db.prepare(
    "INSERT INTO _schema_migrations (version, name) VALUES (?, ?)",
  );

  for (const migration of pending) {
    try {
      // Run each migration + record it atomically
      db.exec("BEGIN");
      db.exec(migration.sql);
      insertMigration.run(migration.version, migration.name);
      db.exec("COMMIT");
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch { /* ignore rollback error */ }
      throw new Error(
        `db-migrations: migration v${migration.version} "${migration.name}" failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
