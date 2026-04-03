/**
 * Persistence round-trip tests for native SQLite (src/native-sqlite.ts).
 *
 * These tests exercise the open/write/close/reopen cycle:
 *   openDb(path) → write → close() → openDb(same path) → read
 *
 * bun:sqlite writes are synchronous and immediately durable — no debounce,
 * no serialize/deserialize cycle, real WAL mode.
 */
import { describe, it, expect } from "vitest";
import { openDb } from "../src/native-sqlite.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

function makeTempDbPath(): string {
  return path.join(os.tmpdir(), `wasm-persist-${crypto.randomUUID()}.db`);
}

describe("native SQLite — persistence round-trip", () => {
  it("data written and close()d survives a second openDb() call", async () => {
    const dbPath = makeTempDbPath();
    try {
      // ── Phase 1: write ────────────────────────────────────────────────────
      const db1 = await openDb(dbPath);
      db1.exec("CREATE TABLE items (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
      db1.prepare("INSERT INTO items VALUES (?, ?)").run("a", "hello");
      db1.prepare("INSERT INTO items VALUES (?, ?)").run("b", "world");
      db1.close(); // bun:sqlite writes are already durable; close() runs PRAGMA optimize

      // ── Phase 2: read from a new DB instance ─────────────────────────────
      const db2 = await openDb(dbPath);
      const rows = db2.prepare("SELECT id, value FROM items ORDER BY id").all();
      db2.close();

      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual({ id: "a", value: "hello" });
      expect(rows[1]).toEqual({ id: "b", value: "world" });
    } finally {
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("file is written to disk (non-empty) after inserting a row", async () => {
    const dbPath = makeTempDbPath();
    try {
      const db = await openDb(dbPath);
      db.exec("CREATE TABLE t (x INTEGER)");
      db.prepare("INSERT INTO t VALUES (?)").run(42);
      db.close();

      const stat = fs.statSync(dbPath);
      expect(stat.size).toBeGreaterThan(0);
    } finally {
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("transaction data persists across close + reopen", async () => {
    const dbPath = makeTempDbPath();
    try {
      const db1 = await openDb(dbPath);
      db1.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, msg TEXT)");

      const insert = db1.prepare("INSERT INTO t VALUES (?, ?)");
      const doInsert = db1.transaction((rows: Array<[number, string]>) => {
        for (const [id, msg] of rows) insert.run(id, msg);
      });
      doInsert([[1, "first"], [2, "second"], [3, "third"]]);
      db1.close();

      const db2 = await openDb(dbPath);
      const count = db2.prepare("SELECT COUNT(*) as c FROM t").get() as { c: number };
      const last = db2.prepare("SELECT msg FROM t WHERE id = 3").get() as { msg: string } | undefined;
      db2.close();

      expect(count.c).toBe(3);
      expect(last?.msg).toBe("third");
    } finally {
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("data is durable after writes without close() (native driver writes synchronously)", async () => {
    const dbPath = makeTempDbPath();
    let db: Awaited<ReturnType<typeof openDb>> | undefined;
    try {
      db = await openDb(dbPath);
      db.exec("CREATE TABLE t (v TEXT)");
      db.prepare("INSERT INTO t VALUES (?)").run("persisted");
      // flush() is a no-op in the native driver — data is already on disk
      await db.flush();

      const stat = fs.statSync(dbPath);
      expect(stat.size).toBeGreaterThan(0);

      // Open a second instance to verify the data is present on disk
      const db2 = await openDb(dbPath);
      const row = db2.prepare("SELECT v FROM t").get() as { v: string } | undefined;
      db2.close();

      expect(row?.v).toBe("persisted");
    } finally {
      try { db?.close(); } catch { /* ignore */ }
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("multiple rows survive across three sequential open/close cycles", async () => {
    const dbPath = makeTempDbPath();
    try {
      // Write first batch
      const db1 = await openDb(dbPath);
      db1.exec("CREATE TABLE log (ts INTEGER, msg TEXT)");
      db1.prepare("INSERT INTO log VALUES (?, ?)").run(1, "alpha");
      db1.close();

      // Append second batch
      const db2 = await openDb(dbPath);
      db2.prepare("INSERT INTO log VALUES (?, ?)").run(2, "beta");
      db2.close();

      // Read all
      const db3 = await openDb(dbPath);
      const rows = db3.prepare("SELECT ts, msg FROM log ORDER BY ts").all() as Array<{ ts: number; msg: string }>;
      db3.close();

      expect(rows).toHaveLength(2);
      expect(rows[0].msg).toBe("alpha");
      expect(rows[1].msg).toBe("beta");
    } finally {
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("readonly mode reads persisted data without modifying the file", async () => {
    const dbPath = makeTempDbPath();
    try {
      // Create DB and persist
      const dbW = await openDb(dbPath);
      dbW.exec("CREATE TABLE t (v TEXT)");
      dbW.prepare("INSERT INTO t VALUES (?)").run("original");
      dbW.close();
      const sizeBefore = fs.statSync(dbPath).size;

      // Open readonly — read value, no writes
      const dbRo = await openDb(dbPath, { readonly: true });
      const row = dbRo.prepare("SELECT v FROM t").get() as { v: string } | undefined;
      dbRo.close();
      const sizeAfter = fs.statSync(dbPath).size;

      expect(row?.v).toBe("original");
      // File size must not change — readonly mode does not write
      expect(sizeAfter).toBe(sizeBefore);
    } finally {
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("opening a non-existent path produces a fresh empty database", async () => {
    const dbPath = makeTempDbPath();
    // Guarantee the file does NOT exist before opening
    expect(fs.existsSync(dbPath)).toBe(false);
    try {
      const db = await openDb(dbPath);
      db.exec("CREATE TABLE t (x INTEGER)");
      const row = db.prepare("SELECT COUNT(*) as c FROM t").get() as { c: number };
      db.close();
      expect(row.c).toBe(0);
    } finally {
      fs.rmSync(dbPath, { force: true });
    }
  });
});
