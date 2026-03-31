/**
 * Tests for openWasmDb error paths in src/wasm-sqlite.ts.
 *
 * Key discovery: sqlite3_deserialize always returns rc=0 (SQLITE_OK) even for
 * corrupt/invalid file content.  The error surfaces on the first SQL operation
 * as SQLITE_NOTADB (result code 26).  The rc !== 0 branch in openWasmDb is
 * therefore dead code in practice, but the DB returned for a corrupt file is
 * unusable and throws on first use.
 *
 * Coverage:
 *  1. Corrupt file  → openWasmDb succeeds; first SQL op throws SQLITE_NOTADB
 *  2. Empty file    → deserialization skipped → DB is fully usable
 *  3. Non-existent  → creates fresh in-memory DB → DB is fully usable
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { openWasmDb } from "../src/wasm-sqlite.js";

function tmpPath(suffix: string): string {
  return path.join(os.tmpdir(), `wasm-err-test-${randomUUID()}-${suffix}`);
}

describe("openWasmDb — error paths", () => {
  it("corrupt file: openWasmDb itself does not throw, but first SQL operation throws SQLITE_NOTADB", async () => {
    const filePath = tmpPath("corrupt.db");
    fs.writeFileSync(filePath, Buffer.from("this is not a sqlite3 database - corrupted content!"));
    let db;
    try {
      // openWasmDb does NOT throw — sqlite3_deserialize returns SQLITE_OK (rc=0) for any bytes
      db = await openWasmDb(filePath);

      // But the returned DB is unusable — the first SQL op reveals the corruption
      expect(() => db!.exec("SELECT 1")).toThrow(/SQLITE_NOTADB|file is not a database/i);
    } finally {
      try { db?.close(); } catch { /* ignore — close on a corrupt DB may also throw */ }
      fs.rmSync(filePath, { force: true });
    }
  });

  it("empty file: deserialization is skipped and the returned DB is fully functional", async () => {
    const filePath = tmpPath("empty.db");
    fs.writeFileSync(filePath, Buffer.alloc(0));
    let db;
    try {
      db = await openWasmDb(filePath);
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
      db = await openWasmDb(filePath);
      expect(() => db.exec("SELECT 1")).not.toThrow();
    } finally {
      try { db?.close(); } catch { /* ignore */ }
      // Clean up the persisted file that close() may have written
      fs.rmSync(filePath, { force: true });
    }
  });
});
