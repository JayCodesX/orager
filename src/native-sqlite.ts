/**
 * Native SQLite driver using bun:sqlite (ADR-0008 §Component 1).
 *
 * Replaced the former @sqlite.org/sqlite-wasm driver. All persistence
 * (memory, sessions, skills, OMLS) goes through this module.
 *
 * Advantages over the removed WASM driver:
 *  - Zero cold-start overhead (no WASM parse, no sqlite3_deserialize)
 *  - Real WAL mode — unlimited concurrent readers, serialised writers that queue
 *  - No silent data loss — bun:sqlite writes are synchronous and durable
 *  - No 50ms debounce window — every write is immediately on disk
 *  - No ~1.25 MB WASM blob in the compiled binary
 */
import { Database, type Statement } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// ── WAL pragmas (ADR-0008) ────────────────────────────────────────────────────

const STARTUP_PRAGMAS = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
PRAGMA auto_vacuum = INCREMENTAL;
PRAGMA mmap_size = 134217728;
`;

// ── Internal types ────────────────────────────────────────────────────────────

type BindValue = string | number | null | bigint | Uint8Array | boolean | undefined;
type BindArgs  = BindValue | readonly BindValue[] | Record<string, BindValue>;

/**
 * Normalise calling-convention args to bun:sqlite's expected binding format.
 *
 *  - Multiple args          → positional array
 *  - Single plain object    → named-param map with "@" prefix on bare keys
 *  - Single value / Buffer  → single-element positional array
 *  - No args                → undefined (no binding)
 *
 * This preserves compatibility with all existing call sites that use
 * `stmt.run({ key: val })` or `stmt.run(val1, val2)`.
 */
function normalizeArgs(args: unknown[]): BindArgs | undefined {
  if (args.length === 0) return undefined;
  if (args.length > 1)   return args as BindValue[];

  const a = args[0];
  if (
    a !== null &&
    typeof a === "object" &&
    !Array.isArray(a) &&
    !(a instanceof Uint8Array) &&
    !(a instanceof ArrayBuffer)
  ) {
    const out: Record<string, BindValue> = {};
    for (const [k, v] of Object.entries(a as Record<string, unknown>)) {
      const key = k[0] === "@" || k[0] === ":" || k[0] === "$" ? k : `@${k}`;
      out[key] = v as BindValue;
    }
    return out;
  }

  return [a as BindValue];
}

// ── RunResult ─────────────────────────────────────────────────────────────────

export interface RunResult { changes: number }

// ── SqliteStmt ────────────────────────────────────────────────────────────

export class SqliteStmt {
  constructor(private readonly _stmt: Statement) {}

  run(...args: unknown[]): RunResult {
    const bind = normalizeArgs(args);
    // bun:sqlite Statement.run() returns { changes, lastInsertRowid }
    type BunRunResult = { changes: number; lastInsertRowid: number | bigint };
    let result: BunRunResult;
    if (bind === undefined) {
      result = this._stmt.run() as BunRunResult;
    } else if (Array.isArray(bind)) {
      result = this._stmt.run(...(bind as BindValue[])) as BunRunResult;
    } else {
      result = this._stmt.run(bind as Record<string, BindValue>) as BunRunResult;
    }
    return { changes: result?.changes ?? 0 };
  }

  get(...args: unknown[]): Record<string, unknown> | undefined {
    const bind = normalizeArgs(args);
    if (bind === undefined) return this._stmt.get() as Record<string, unknown> | undefined;
    if (Array.isArray(bind)) return this._stmt.get(...(bind as BindValue[])) as Record<string, unknown> | undefined;
    return this._stmt.get(bind as Record<string, BindValue>) as Record<string, unknown> | undefined;
  }

  all(...args: unknown[]): Record<string, unknown>[] {
    const bind = normalizeArgs(args);
    if (bind === undefined) return this._stmt.all() as Record<string, unknown>[];
    if (Array.isArray(bind)) return this._stmt.all(...(bind as BindValue[])) as Record<string, unknown>[];
    return this._stmt.all(bind as Record<string, BindValue>) as Record<string, unknown>[];
  }
}

// ── Transaction wrapper type ──────────────────────────────────────────────────

type TxFn<A extends unknown[], T> = {
  (...args: A): T;
  exclusive: (...args: A) => T;
};

// ── SqliteDb ─────────────────────────────────────────────────────────────

export class SqliteDb {
  /** No-op: kept for API compatibility with wasm-sqlite.ts callers. */
  _txDepth = 0;

  /** No-op: native driver writes are always durable. */
  public lastSaveError: Error | null = null;

  constructor(private readonly _db: Database) {}

  pragma(str: string): void {
    this._db.run(`PRAGMA ${str}`);
  }

  exec(sql: string): void {
    this._db.exec(sql);
  }

  prepare(sql: string): SqliteStmt {
    return new SqliteStmt(this._db.prepare(sql));
  }

  transaction<A extends unknown[], T>(fn: (...args: A) => T): TxFn<A, T> {
    const wrapped = this._db.transaction(fn);
    const wrapper = (...args: A): T => wrapped(...args);
    // bun:sqlite transactions don't expose separate EXCLUSIVE mode via the
    // transaction() API — all writes are serialised by WAL anyway. Map
    // .exclusive() to the same deferred transaction for compatibility.
    wrapper.exclusive = (...args: A): T => wrapped(...args);
    return wrapper as TxFn<A, T>;
  }

  close(): void {
    try { this._db.exec("PRAGMA optimize"); } catch { /* best effort */ }
    this._db.close();
  }

  /**
   * Load a SQLite extension (e.g. sqlite-vec) by path.
   * Passes through to bun:sqlite Database.loadExtension().
   */
  loadExtension(path: string): void {
    this._db.loadExtension(path);
  }

  /** No-op: native driver writes are always immediately durable. */
  _autoSave(): void {}

  /** No-op: no debounced write queue to flush. */
  async flush(): Promise<void> {}
}

// ── Public factory ────────────────────────────────────────────────────────────

/**
 * Open or create a SQLite database at `filePath` using bun:sqlite.
 *
 * The function is async for historical API compatibility — bun:sqlite opens synchronously.
 * WAL mode and all ADR-0008 pragmas are applied on every open.
 * Pass `{ readonly: true }` for health-check reads.
 */
export async function openDb(filePath: string, opts?: { readonly?: boolean }): Promise<SqliteDb> {
  if (opts?.readonly) {
    // Readonly opens: use SQLITE_OPEN_READONLY — no WAL pragmas needed (read-only can't set journal_mode)
    const db = new Database(filePath, { readonly: true });
    return new SqliteDb(db);
  }
  mkdirSync(dirname(filePath), { recursive: true });
  const db = new Database(filePath, { create: true, readwrite: true });
  db.exec(STARTUP_PRAGMAS);
  const compat = new SqliteDb(db);
  tryLoadSqliteVec(compat);
  return compat;
}

// ── sqlite-vec extension ──────────────────────────────────────────────────────

/** True once sqlite-vec has been successfully loaded into at least one DB. */
let _sqliteVecAvailable: boolean | null = null;

/**
 * Try to load the sqlite-vec extension into an open database.
 * Sets _sqliteVecAvailable on first attempt (succeeds or fails once, cached).
 *
 * Graceful degradation: if sqlite-vec is not installed or cannot be loaded,
 * the call is a no-op and callers fall back to JS-side cosine similarity.
 *
 * ADR-0008 §Component 4.
 */
function tryLoadSqliteVec(db: SqliteDb): void {
  if (_sqliteVecAvailable === false) return; // already failed — don't retry
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqliteVec = require("sqlite-vec") as { load: (db: SqliteDb) => void };
    sqliteVec.load(db);
    _sqliteVecAvailable = true;
  } catch {
    _sqliteVecAvailable = false;
    // Non-fatal: JS cosine similarity is used as fallback.
  }
}

/** Returns true when sqlite-vec loaded successfully (available for this process). */
export function isSqliteVecAvailable(): boolean {
  return _sqliteVecAvailable === true;
}

/** Primary type alias for an open SQLite database handle. */
export type { SqliteDb as SqliteDatabase };
