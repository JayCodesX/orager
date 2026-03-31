/**
 * WASM SQLite compatibility shim.
 *
 * Provides a synchronous API identical to better-sqlite3 backed by
 * @sqlite.org/sqlite-wasm. The WASM module is initialised once via a
 * top-level await so all subsequent calls remain synchronous from the
 * caller's perspective.
 *
 * Persistence: each database lives in WASM memory and is serialised to
 * disk after every top-level write (i.e. any write that is not nested
 * inside an open transaction). Journal-mode WAL is silently ignored
 * (in-memory databases fall back to "memory" journal mode).
 */
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
// The TypeScript types only expose init() with no args, but the underlying
// Emscripten module accepts { wasmBinary, print, printErr } at runtime.
// We cast to bypass the strict type, then use Sqlite3Static for all usage.
import type { Sqlite3Static, Database as OO1Db, PreparedStatement } from "@sqlite.org/sqlite-wasm";

// ── WASM module initialisation (runs once, top-level await) ──────────────────

const _require = createRequire(import.meta.url);
// Resolve the WASM binary relative to the package's installed location.
const _wasmPkgMain = _require.resolve("@sqlite.org/sqlite-wasm");
const _wasmBinary = readFileSync(join(dirname(_wasmPkgMain), "sqlite3.wasm"));

// Use a dynamic import + cast so we can pass the wasmBinary init option, which
// the @sqlite.org/sqlite-wasm typings don't include but the runtime accepts.
const { default: _initFn } = await import("@sqlite.org/sqlite-wasm") as unknown as {
  default: (opts: { wasmBinary: Uint8Array; print: () => void; printErr: () => void }) => Promise<Sqlite3Static>;
};
const _sqlite3 = await _initFn({
  print: () => {},
  printErr: () => {},
  wasmBinary: _wasmBinary,
});

// ── Internal types ────────────────────────────────────────────────────────────

type BindValue = string | number | null | bigint | Uint8Array | boolean | undefined;
type BindSpec  = BindValue | readonly BindValue[] | Record<string, BindValue>;

/**
 * Normalise the rest-args from the better-sqlite3 calling convention to the
 * binding spec expected by @sqlite.org/sqlite-wasm.
 *
 *  - Multiple args          → positional array
 *  - Single plain object    → named-param map with "@" prefix added to bare keys
 *  - Single value / Buffer  → single-element positional array
 *  - No args                → undefined (no binding)
 */
function normalizeArgs(args: unknown[]): BindSpec | undefined {
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
  constructor(
    private readonly _owner: WasmCompatDb,
    private readonly _db:    OO1Db,
    private readonly _stmt:  PreparedStatement,
  ) {}

  run(...args: unknown[]): RunResult {
    this._stmt.reset(true);
    const bind = normalizeArgs(args);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (bind !== undefined) this._stmt.bind(bind as any);
    this._stmt.step();
    this._stmt.reset(true);
    const changes = (this._db.selectValue("SELECT changes()") ?? 0) as number;
    this._owner._autoSave();
    return { changes };
  }

  get(...args: unknown[]): Record<string, unknown> | undefined {
    this._stmt.reset(true);
    const bind = normalizeArgs(args);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (bind !== undefined) this._stmt.bind(bind as any);
    if (!this._stmt.step()) { this._stmt.reset(true); return undefined; }
    const row = this._stmt.get({}) as Record<string, unknown>;
    this._stmt.reset(true);
    return row;
  }

  all(...args: unknown[]): Record<string, unknown>[] {
    this._stmt.reset(true);
    const bind = normalizeArgs(args);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (bind !== undefined) this._stmt.bind(bind as any);
    const rows: Record<string, unknown>[] = [];
    while (this._stmt.step()) rows.push(this._stmt.get({}) as Record<string, unknown>);
    this._stmt.reset(true);
    return rows;
  }
}

// ── Transaction wrapper type ──────────────────────────────────────────────────

type TxFn<A extends unknown[], T> = {
  (...args: A): T;
  exclusive: (...args: A) => T;
};

// ── WasmCompatDb ─────────────────────────────────────────────────────────────

export class WasmCompatDb {
  /** Incremented while inside a transaction; only persist at depth 0. */
  _txDepth = 0;

  constructor(
    private readonly _db:       OO1Db,
    private readonly _filePath: string | null,
  ) {}

  pragma(str: string): void {
    this._db.exec(`PRAGMA ${str}`);
  }

  exec(sql: string): void {
    this._db.exec(sql);
  }

  prepare(sql: string): WasmCompatStmt {
    return new WasmCompatStmt(this, this._db, this._db.prepare(sql));
  }

  transaction<A extends unknown[], T>(fn: (...args: A) => T): TxFn<A, T> {
    const self = this;
    const runTx = (qualifier: "DEFERRED" | "EXCLUSIVE", args: A): T => {
      self._txDepth++;
      let result!: T;
      try {
        result = self._db.transaction(qualifier, () => fn(...args));
      } finally {
        self._txDepth--;
      }
      self._autoSave();
      return result;
    };
    const wrapper = (...args: A): T => runTx("DEFERRED", args);
    wrapper.exclusive = (...args: A): T => runTx("EXCLUSIVE", args);
    return wrapper as TxFn<A, T>;
  }

  close(): void {
    this._persistToFile();
    this._db.close();
  }

  /** Called by WasmCompatStmt.run() after each statement execution. */
  _autoSave(): void {
    if (this._txDepth === 0) this._persistToFile();
  }

  private _persistToFile(): void {
    if (!this._filePath) return;
    const ptr = this._db.pointer;
    if (!ptr) return;
    const data = _sqlite3.capi.sqlite3_js_db_export(ptr);
    // Atomic write: write to temp file then rename. Rename is atomic on POSIX,
    // so a crash mid-write leaves the original file intact. (audit E-03)
    const tmpPath = this._filePath + `.tmp.${process.pid}`;
    writeFileSync(tmpPath, data);
    renameSync(tmpPath, this._filePath);
  }
}

// ── Public factory ────────────────────────────────────────────────────────────

/**
 * Open or create a SQLite database at `filePath`.
 *
 * The database is held in WASM memory. If the file already exists it is
 * loaded via sqlite3_deserialize; after every top-level write the current
 * state is serialised back to disk.
 *
 * Pass `{ readonly: true }` for health-check reads — no writes to disk occur.
 */
export function openWasmDb(filePath: string, opts?: { readonly?: boolean }): WasmCompatDb {
  const db = new _sqlite3.oo1.DB(":memory:", "c");

  if (existsSync(filePath)) {
    const raw = readFileSync(filePath);
    if (raw.length > 0) {
      const fileData = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
      const pData = _sqlite3.wasm.allocFromTypedArray(fileData);
      const dbPtr = db.pointer;
      if (!dbPtr) throw new Error("[wasm-sqlite] DB pointer is null after open");
      const rc = _sqlite3.capi.sqlite3_deserialize(
        dbPtr, "main", pData,
        fileData.length, fileData.length,
        _sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE,
      );
      if (rc !== 0) {
        try { db.close(); } catch { /* ignore */ }
        throw new Error(`[wasm-sqlite] sqlite3_deserialize failed (rc=${rc})`);
      }
    }
  }

  return new WasmCompatDb(db, opts?.readonly ? null : filePath);
}

export type { WasmCompatDb as WasmDatabase };
