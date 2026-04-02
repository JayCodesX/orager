/**
 * Tests for openWasmDb error paths in src/native-sqlite.ts.
 *
 * With bun:sqlite the behaviour differs from the WASM driver:
 *  - Corrupt file  → openWasmDb throws immediately (WAL pragma fails on open)
 *  - Empty file    → treated as a fresh DB → fully usable
 *  - Non-existent  → created fresh → fully usable
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { openWasmDb } from "../src/native-sqlite.js";

function tmpPath(suffix: string): string {
  return path.join(os.tmpdir(), `native-err-test-${randomUUID()}-${suffix}`);
}

describe("openWasmDb (native) — error paths", () => {
  it("corrupt file: openWasmDb throws (WAL pragma fails on first SQL op)", async () => {
    const filePath = tmpPath("corrupt.db");
    fs.writeFileSync(filePath, Buffer.from("this is not a sqlite3 database - corrupted content!"));
    try {
      // bun:sqlite detects corruption when running the startup WAL pragmas
      await expect(openWasmDb(filePath)).rejects.toThrow(/not a database|NOTADB|malformed|corrupt/i);
    } finally {
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
