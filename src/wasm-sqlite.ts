/**
 * WASM SQLite compatibility shim.
 *
 * Provides a synchronous API identical to better-sqlite3 backed by
 * @sqlite.org/sqlite-wasm. The WASM module is initialised lazily on the
 * first call to openWasmDb(); all subsequent calls remain synchronous
 * from the caller's perspective.
 *
 * Persistence: each database lives in WASM memory and is serialised to
 * disk after every top-level write (i.e. any write that is not nested
 * inside an open transaction). Journal-mode WAL is silently ignored
 * (in-memory databases fall back to "memory" journal mode).
 */
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
// The TypeScript types only expose init() with no args, but the underlying
// Emscripten module accepts { wasmBinary, print, printErr } at runtime.
// We cast to bypass the strict type, then use Sqlite3Static for all usage.
import type { Sqlite3Static, Database as OO1Db, PreparedStatement } from "@sqlite.org/sqlite-wasm";

// ── WASM module initialisation (lazy, runs once on first use) ────────────────

let _sqlite3: Sqlite3Static | null = null;
let _initPromise: Promise<Sqlite3Static> | null = null;

async function _doInit(): Promise<Sqlite3Static> {
  const _require = createRequire(import.meta.url);
  const _wasmPkgMain = _require.resolve("@sqlite.org/sqlite-wasm");
  const _wasmBinary = readFileSync(join(dirname(_wasmPkgMain), "sqlite3.wasm"));

  const { default: _initFn } = await import("@sqlite.org/sqlite-wasm") as unknown as {
    default: (opts: { wasmBinary: Uint8Array; print: () => void; printErr: () => void }) => Promise<Sqlite3Static>;
  };
  return _initFn({
    print: () => {},
    printErr: () => {},
    wasmBinary: _wasmBinary,
  });
}

async function ensureInit(): Promise<Sqlite3Static> {
  if (_sqlite3) return _sqlite3;
  if (!_initPromise) _initPromise = _doInit();
  _sqlite3 = await _initPromise;
  _initPromise = null;
  return _sqlite3;
}

function _getSqlite3(): Sqlite3Static {
  if (!_sqlite3) throw new Error("[wasm-sqlite] not initialised — call openWasmDb() first");
  return _sqlite3;
}

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

  /** Debounce timer for async persistence (audit E-15). */
  private _saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Tracks in-flight async write so close() can await it. */
  private _saving: Promise<void> | null = null;
  /** Debounce interval in ms — coalesces rapid writes. */
  private static readonly SAVE_DEBOUNCE_MS = 100;

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
    // Flush any pending debounced write synchronously on close.
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    this._persistToFileSync();
    this._db.close();
  }

  /** Called by WasmCompatStmt.run() after each statement execution. */
  _autoSave(): void {
    if (this._txDepth === 0) this._scheduleSave();
  }

  /**
   * M-05: Flush any pending debounced write immediately.
   * Returns a promise that resolves when the write completes.
   * Use before critical checkpoints where data loss is unacceptable.
   */
  async flush(): Promise<void> {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
      this._persistToFileAsync();
    }
    // Wait for any in-flight write to complete
    if (this._saving) await this._saving;
  }

  /**
   * Debounced async persistence (audit E-15/B-13).
   * Serialises the DB to a byte array synchronously (cheap — WASM memcpy),
   * then writes to disk asynchronously so the event loop isn't blocked.
   * Rapid successive writes are coalesced by the debounce timer.
   */
  private _scheduleSave(): void {
    if (!this._filePath) return;
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._persistToFileAsync();
    }, WasmCompatDb.SAVE_DEBOUNCE_MS);
  }

  /** N-10: Last save error, exposed for health checks. Null when healthy. */
  public lastSaveError: Error | null = null;

  private _persistToFileAsync(): void {
    if (!this._filePath) return;
    const ptr = this._db.pointer;
    if (!ptr) return;
    // Snapshot is synchronous (WASM memory copy) — fast.
    const data = _getSqlite3().capi.sqlite3_js_db_export(ptr);
    const tmpPath = this._filePath + `.tmp.${process.pid}`;
    this._saving = writeFile(tmpPath, data)
      .then(() => rename(tmpPath, this._filePath!))
      .then(() => { this.lastSaveError = null; })
      .catch((err) => {
        this.lastSaveError = err instanceof Error ? err : new Error(String(err));
        process.stderr.write(`[wasm-sqlite] async persist failed: ${err}\n`);
      })
      .finally(() => { this._saving = null; });
  }

  /** Synchronous fallback used only by close(). */
  private _persistToFileSync(): void {
    if (!this._filePath) return;
    const ptr = this._db.pointer;
    if (!ptr) return;
    const data = _getSqlite3().capi.sqlite3_js_db_export(ptr);
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
export async function openWasmDb(filePath: string, opts?: { readonly?: boolean }): Promise<WasmCompatDb> {
  const sqlite3 = await ensureInit();
  const db = new sqlite3.oo1.DB(":memory:", "c");

  if (existsSync(filePath)) {
    const raw = readFileSync(filePath);
    if (raw.length > 0) {
      const fileData = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
      const pData = sqlite3.wasm.allocFromTypedArray(fileData);
      const dbPtr = db.pointer;
      if (!dbPtr) throw new Error("[wasm-sqlite] DB pointer is null after open");
      const rc = sqlite3.capi.sqlite3_deserialize(
        dbPtr, "main", pData,
        fileData.length, fileData.length,
        sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE,
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
