/**
 * Native SQLite driver using bun:sqlite.
 *
 * Drop-in replacement for wasm-sqlite.ts. Provides the same synchronous API
 * (WasmCompatDb / WasmCompatStmt / openWasmDb / WasmDatabase) so all callers
 * can migrate by changing a single import line.
 *
 * Advantages over the WASM driver:
 *  - Zero cold-start overhead (no WASM parse, no sqlite3_deserialize)
 *  - Real WAL mode — unlimited concurrent readers, serialised writers that queue
 *  - No silent data loss — bun:sqlite writes are synchronous and durable
 *  - No 50ms debounce window — every write is immediately on disk
 *  - No ~1.25 MB WASM blob in the compiled binary
 *
 * ADR-0008 §Component 1.
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

// ── WasmCompatStmt ────────────────────────────────────────────────────────────

export class WasmCompatStmt {
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

// ── WasmCompatDb ─────────────────────────────────────────────────────────────

export class WasmCompatDb {
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

  prepare(sql: string): WasmCompatStmt {
    return new WasmCompatStmt(this._db.prepare(sql));
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

  /** No-op: native driver writes are always immediately durable. */
  _autoSave(): void {}

  /** No-op: no debounced write queue to flush. */
  async flush(): Promise<void> {}
}

// ── Public factory ────────────────────────────────────────────────────────────

/**
 * Open or create a SQLite database at `filePath` using bun:sqlite.
 *
 * This is a drop-in replacement for `openWasmDb`. The function is async for
 * API compatibility only — bun:sqlite opens synchronously.
 *
 * WAL mode and all ADR-0008 pragmas are applied on every open.
 * Pass `{ readonly: true }` for health-check reads.
 */
export async function openWasmDb(filePath: string, opts?: { readonly?: boolean }): Promise<WasmCompatDb> {
  if (opts?.readonly) {
    // Readonly opens: use SQLITE_OPEN_READONLY — no WAL pragmas needed (read-only can't set journal_mode)
    const db = new Database(filePath, { readonly: true });
    return new WasmCompatDb(db);
  }
  mkdirSync(dirname(filePath), { recursive: true });
  const db = new Database(filePath, { create: true, readwrite: true });
  db.exec(STARTUP_PRAGMAS);
  return new WasmCompatDb(db);
}

// Type alias for backward compatibility — all callers importing WasmDatabase
// from wasm-sqlite.ts will work without changes.
export type { WasmCompatDb as WasmDatabase };
