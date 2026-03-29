/**
 * Persistence round-trip tests for WASM SQLite (src/wasm-sqlite.ts).
 *
 * These tests exercise the serialize/deserialize cycle directly:
 *   openWasmDb(path) → write → close()/_autoSave → openWasmDb(same path) → read
 *
 * The existing memory-sqlite.test.ts verifies the memory store API but resets
 * the module singleton in the same process, which doesn't exercise whether
 * _persistToFile() (sqlite3_js_db_export + writeFileSync) + sqlite3_deserialize
 * correctly round-trips data across two independent openWasmDb() calls.
 */
import { describe, it, expect } from "vitest";
import { openWasmDb } from "../src/wasm-sqlite.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

function makeTempDbPath(): string {
  return path.join(os.tmpdir(), `wasm-persist-${crypto.randomUUID()}.db`);
}

describe("WASM SQLite — serialize/deserialize persistence round-trip", () => {
  it("data written and close()d survives a second openWasmDb() call", () => {
    const dbPath = makeTempDbPath();
    try {
      // ── Phase 1: write ────────────────────────────────────────────────────
      const db1 = openWasmDb(dbPath);
      db1.exec("CREATE TABLE items (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
      db1.prepare("INSERT INTO items VALUES (?, ?)").run("a", "hello");
      db1.prepare("INSERT INTO items VALUES (?, ?)").run("b", "world");
      db1.close(); // triggers _persistToFile → sqlite3_js_db_export → writeFileSync

      // ── Phase 2: read from a new DB instance ─────────────────────────────
      const db2 = openWasmDb(dbPath); // readFileSync + sqlite3_deserialize
      const rows = db2.prepare("SELECT id, value FROM items ORDER BY id").all();
      db2.close();

      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual({ id: "a", value: "hello" });
      expect(rows[1]).toEqual({ id: "b", value: "world" });
    } finally {
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("file is written to disk (non-empty) after inserting a row", () => {
    const dbPath = makeTempDbPath();
    try {
      const db = openWasmDb(dbPath);
      db.exec("CREATE TABLE t (x INTEGER)");
      db.prepare("INSERT INTO t VALUES (?)").run(42);
      db.close();

      const stat = fs.statSync(dbPath);
      expect(stat.size).toBeGreaterThan(0);
    } finally {
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("transaction data persists across close + reopen", () => {
    const dbPath = makeTempDbPath();
    try {
      const db1 = openWasmDb(dbPath);
      db1.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, msg TEXT)");

      const insert = db1.prepare("INSERT INTO t VALUES (?, ?)");
      const doInsert = db1.transaction((rows: Array<[number, string]>) => {
        for (const [id, msg] of rows) insert.run(id, msg);
      });
      doInsert([[1, "first"], [2, "second"], [3, "third"]]);
      db1.close();

      const db2 = openWasmDb(dbPath);
      const count = db2.prepare("SELECT COUNT(*) as c FROM t").get() as { c: number };
      const last = db2.prepare("SELECT msg FROM t WHERE id = 3").get() as { msg: string } | undefined;
      db2.close();

      expect(count.c).toBe(3);
      expect(last?.msg).toBe("third");
    } finally {
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("_autoSave writes the file after each top-level statement (without close())", () => {
    const dbPath = makeTempDbPath();
    let db: ReturnType<typeof openWasmDb> | undefined;
    try {
      db = openWasmDb(dbPath);
      db.exec("CREATE TABLE t (v TEXT)");
      db.prepare("INSERT INTO t VALUES (?)").run("auto-saved");
      // Do NOT call close() — _autoSave should have flushed after INSERT

      const stat = fs.statSync(dbPath);
      expect(stat.size).toBeGreaterThan(0);

      // Open a second instance to verify the data is present on disk
      const db2 = openWasmDb(dbPath);
      const row = db2.prepare("SELECT v FROM t").get() as { v: string } | undefined;
      db2.close();

      expect(row?.v).toBe("auto-saved");
    } finally {
      try { db?.close(); } catch { /* ignore */ }
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("multiple rows survive across three sequential open/close cycles", () => {
    const dbPath = makeTempDbPath();
    try {
      // Write first batch
      const db1 = openWasmDb(dbPath);
      db1.exec("CREATE TABLE log (ts INTEGER, msg TEXT)");
      db1.prepare("INSERT INTO log VALUES (?, ?)").run(1, "alpha");
      db1.close();

      // Append second batch
      const db2 = openWasmDb(dbPath);
      db2.prepare("INSERT INTO log VALUES (?, ?)").run(2, "beta");
      db2.close();

      // Read all
      const db3 = openWasmDb(dbPath);
      const rows = db3.prepare("SELECT ts, msg FROM log ORDER BY ts").all() as Array<{ ts: number; msg: string }>;
      db3.close();

      expect(rows).toHaveLength(2);
      expect(rows[0].msg).toBe("alpha");
      expect(rows[1].msg).toBe("beta");
    } finally {
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("readonly mode reads persisted data without modifying the file", () => {
    const dbPath = makeTempDbPath();
    try {
      // Create DB and persist
      const dbW = openWasmDb(dbPath);
      dbW.exec("CREATE TABLE t (v TEXT)");
      dbW.prepare("INSERT INTO t VALUES (?)").run("original");
      dbW.close();
      const sizeBefore = fs.statSync(dbPath).size;

      // Open readonly — read value, no writes
      const dbRo = openWasmDb(dbPath, { readonly: true });
      const row = dbRo.prepare("SELECT v FROM t").get() as { v: string } | undefined;
      dbRo.close();
      const sizeAfter = fs.statSync(dbPath).size;

      expect(row?.v).toBe("original");
      // File size must not change — readonly path passes null filePath to WasmCompatDb
      expect(sizeAfter).toBe(sizeBefore);
    } finally {
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("opening a non-existent path produces a fresh empty database", () => {
    const dbPath = makeTempDbPath();
    // Guarantee the file does NOT exist before opening
    expect(fs.existsSync(dbPath)).toBe(false);
    try {
      const db = openWasmDb(dbPath);
      db.exec("CREATE TABLE t (x INTEGER)");
      const row = db.prepare("SELECT COUNT(*) as c FROM t").get() as { c: number };
      db.close();
      expect(row.c).toBe(0);
    } finally {
      fs.rmSync(dbPath, { force: true });
    }
  });
});
