/**
 * Tests for openDb error paths in src/native-sqlite.ts.
 *
 * With bun:sqlite the behaviour differs from the WASM driver:
 *  - Corrupt file  → openDb throws immediately (WAL pragma fails on open)
 *  - Empty file    → treated as a fresh DB → fully usable
 *  - Non-existent  → created fresh → fully usable
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { openDb } from "../src/native-sqlite.js";

function tmpPath(suffix: string): string {
  return path.join(os.tmpdir(), `native-err-test-${randomUUID()}-${suffix}`);
}

describe("openDb (native) — error paths", () => {
  it("corrupt file: openDb throws (WAL pragma fails on first SQL op)", async () => {
    const filePath = tmpPath("corrupt.db");
    fs.writeFileSync(filePath, Buffer.from("this is not a sqlite3 database - corrupted content!"));
    try {
      // bun:sqlite detects corruption when running the startup WAL pragmas
      await expect(openDb(filePath)).rejects.toThrow(/not a database|NOTADB|malformed|corrupt/i);
    } finally {
      fs.rmSync(filePath, { force: true });
    }
  });

  it("empty file: deserialization is skipped and the returned DB is fully functional", async () => {
    const filePath = tmpPath("empty.db");
    fs.writeFileSync(filePath, Buffer.alloc(0));
    let db;
    try {
      db = await openDb(filePath);
      // A working DB must be returned — basic SQL must execute without error
      expect(() => db.exec("SELECT 1")).not.toThrow();
    } finally {
      try { db?.close(); } catch { /* ignore */ }
      fs.rmSync(filePath, { force: true });
    }
  });

  it("non-existent file: opens a fresh in-memory DB that is fully functional", async () => {
    const filePath = tmpPath("nonexistent.db");
    fs.rmSync(filePath, { force: true }); // ensure it really doesn't exist
    let db;
    try {
      db = await openDb(filePath);
      expect(() => db.exec("SELECT 1")).not.toThrow();
    } finally {
      try { db?.close(); } catch { /* ignore */ }
      // Clean up the persisted file that close() may have written
      fs.rmSync(filePath, { force: true });
    }
  });
});
