import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { openWasmDb } from "../src/wasm-sqlite.js";

// We must import after setting ORAGER_DB_PATH, so we use dynamic imports below.
// But we also need to reset the singleton between tests.

function makeTempDbPath(): string {
  return path.join(os.tmpdir(), `orager-memory-test-${randomUUID()}.db`);
}

async function importFresh() {
  const mod = await import("../src/memory-sqlite.js");
  return mod;
}

afterEach(async () => {
  const mod = await importFresh();
  mod._resetDbForTesting();
  delete process.env["ORAGER_DB_PATH"];
});

describe("isSqliteMemoryEnabled", () => {
  it("returns false when ORAGER_DB_PATH not set", async () => {
    delete process.env["ORAGER_DB_PATH"];
    const { isSqliteMemoryEnabled } = await importFresh();
    expect(isSqliteMemoryEnabled()).toBe(false);
  });

  it("returns true when ORAGER_DB_PATH is set", async () => {
    process.env["ORAGER_DB_PATH"] = makeTempDbPath();
    const { isSqliteMemoryEnabled } = await importFresh();
    expect(isSqliteMemoryEnabled()).toBe(true);
  });
});

describe("addMemoryEntrySqlite + loadMemoryStoreSqlite", () => {
  it("inserts an entry and loadMemoryStoreSqlite returns it", async () => {
    const dbPath = makeTempDbPath();
    process.env["ORAGER_DB_PATH"] = dbPath;
    const { _resetDbForTesting, addMemoryEntrySqlite, loadMemoryStoreSqlite } = await importFresh();
    _resetDbForTesting();

    try {
      const entry = addMemoryEntrySqlite("key1", {
        content: "test content",
        importance: 2,
      });

      expect(entry.id).toBeTruthy();
      expect(entry.createdAt).toBeTruthy();
      expect(entry.content).toBe("test content");

      const store = loadMemoryStoreSqlite("key1");
      expect(store.memoryKey).toBe("key1");
      expect(store.entries).toHaveLength(1);
      expect(store.entries[0].id).toBe(entry.id);
      expect(store.entries[0].content).toBe("test content");
    } finally {
      _resetDbForTesting();
      fs.rmSync(dbPath, { force: true });
    }
  });
});

describe("removeMemoryEntrySqlite", () => {
  it("deletes an entry and verifies it is gone", async () => {
    const dbPath = makeTempDbPath();
    process.env["ORAGER_DB_PATH"] = dbPath;
    const { _resetDbForTesting, addMemoryEntrySqlite, removeMemoryEntrySqlite, loadMemoryStoreSqlite } = await importFresh();
    _resetDbForTesting();

    try {
      const entry = addMemoryEntrySqlite("key2", {
        content: "to be deleted",
        importance: 2,
      });

      const deleted = removeMemoryEntrySqlite("key2", entry.id);
      expect(deleted).toBe(true);

      const store = loadMemoryStoreSqlite("key2");
      expect(store.entries).toHaveLength(0);

      // Removing again returns false
      const deletedAgain = removeMemoryEntrySqlite("key2", entry.id);
      expect(deletedAgain).toBe(false);
    } finally {
      _resetDbForTesting();
      fs.rmSync(dbPath, { force: true });
    }
  });
});

describe("loadMemoryStoreSqlite isolation", () => {
  it("returns entries only for the correct memoryKey, not other keys", async () => {
    const dbPath = makeTempDbPath();
    process.env["ORAGER_DB_PATH"] = dbPath;
    const { _resetDbForTesting, addMemoryEntrySqlite, loadMemoryStoreSqlite } = await importFresh();
    _resetDbForTesting();

    try {
      addMemoryEntrySqlite("keyA", { content: "entry for keyA", importance: 2 });
      addMemoryEntrySqlite("keyB", { content: "entry for keyB", importance: 2 });

      const storeA = loadMemoryStoreSqlite("keyA");
      expect(storeA.entries).toHaveLength(1);
      expect(storeA.entries[0].content).toBe("entry for keyA");

      const storeB = loadMemoryStoreSqlite("keyB");
      expect(storeB.entries).toHaveLength(1);
      expect(storeB.entries[0].content).toBe("entry for keyB");
    } finally {
      _resetDbForTesting();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("prunes expired entries automatically on load", async () => {
    const dbPath = makeTempDbPath();
    process.env["ORAGER_DB_PATH"] = dbPath;
    const { _resetDbForTesting, addMemoryEntrySqlite, loadMemoryStoreSqlite } = await importFresh();
    _resetDbForTesting();

    try {
      // Add an already-expired entry
      addMemoryEntrySqlite("keyC", {
        content: "expired entry",
        importance: 2,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      });

      // Add a live entry
      addMemoryEntrySqlite("keyC", {
        content: "live entry",
        importance: 2,
      });

      const store = loadMemoryStoreSqlite("keyC");
      expect(store.entries).toHaveLength(1);
      expect(store.entries[0].content).toBe("live entry");
    } finally {
      _resetDbForTesting();
      fs.rmSync(dbPath, { force: true });
    }
  });
});

describe("searchMemoryFts", () => {
  it("returns entries matching query terms", async () => {
    const dbPath = makeTempDbPath();
    process.env["ORAGER_DB_PATH"] = dbPath;
    const { _resetDbForTesting, addMemoryEntrySqlite, searchMemoryFts } = await importFresh();
    _resetDbForTesting();

    try {
      addMemoryEntrySqlite("keyD", { content: "TypeScript configuration is important", importance: 2 });
      addMemoryEntrySqlite("keyD", { content: "User prefers dark mode", importance: 2 });

      const results = searchMemoryFts("keyD", "TypeScript configuration");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toContain("TypeScript");
    } finally {
      _resetDbForTesting();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("does not return entries for a different memoryKey", async () => {
    const dbPath = makeTempDbPath();
    process.env["ORAGER_DB_PATH"] = dbPath;
    const { _resetDbForTesting, addMemoryEntrySqlite, searchMemoryFts } = await importFresh();
    _resetDbForTesting();

    try {
      addMemoryEntrySqlite("keyE", { content: "unique phrase only in keyE", importance: 2 });
      addMemoryEntrySqlite("keyF", { content: "different content for keyF", importance: 2 });

      const results = searchMemoryFts("keyF", "unique phrase only in keyE");
      expect(results).toHaveLength(0);
    } finally {
      _resetDbForTesting();
      fs.rmSync(dbPath, { force: true });
    }
  });
});

describe("_migrate — JSON text embedding → Float32 BLOB conversion", () => {
  it("converts a JSON text embedding to binary BLOB on the next DB open", async () => {
    const dbPath = makeTempDbPath();
    process.env["ORAGER_DB_PATH"] = dbPath;
    const { _resetDbForTesting, addMemoryEntrySqlite, loadMemoryStoreSqlite } = await importFresh();
    _resetDbForTesting();

    try {
      // Create schema + insert a real entry via the module
      const entry = addMemoryEntrySqlite("keyMig", { content: "migration test content", importance: 2 });
      _resetDbForTesting(); // closes DB and flushes to file

      // Directly overwrite the embedding column with a JSON text string (legacy format)
      const embeddingJson = JSON.stringify([1.0, 2.0, 3.0]);
      const dbRaw = openWasmDb(dbPath);
      dbRaw.prepare("UPDATE memory_entries SET embedding = ? WHERE id = ?").run(embeddingJson, entry.id);
      dbRaw.close();

      // Confirm the embedding is stored as TEXT before migration
      const dbBefore = openWasmDb(dbPath, { readonly: true });
      const before = dbBefore.prepare(
        "SELECT typeof(embedding) as t FROM memory_entries WHERE id = ?",
      ).get(entry.id) as { t: string };
      dbBefore.close();
      expect(before.t).toBe("text");

      // Re-open via memory-sqlite module — _migrate() converts TEXT → BLOB
      _resetDbForTesting();
      loadMemoryStoreSqlite("keyMig");
      _resetDbForTesting(); // flush, close

      // Confirm the embedding is now stored as BLOB
      const dbAfter = openWasmDb(dbPath, { readonly: true });
      const after = dbAfter.prepare(
        "SELECT typeof(embedding) as t FROM memory_entries WHERE id = ?",
      ).get(entry.id) as { t: string };
      dbAfter.close();
      expect(after.t).toBe("blob");
    } finally {
      _resetDbForTesting();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("silently skips rows with malformed JSON — entry is preserved, embedding stays as text", async () => {
    const dbPath = makeTempDbPath();
    process.env["ORAGER_DB_PATH"] = dbPath;
    const { _resetDbForTesting, addMemoryEntrySqlite, loadMemoryStoreSqlite } = await importFresh();
    _resetDbForTesting();

    try {
      const entry = addMemoryEntrySqlite("keyMigBad", { content: "malformed embedding test", importance: 2 });
      _resetDbForTesting();

      // Inject invalid JSON as the embedding TEXT value
      const dbRaw = openWasmDb(dbPath);
      dbRaw.prepare("UPDATE memory_entries SET embedding = ? WHERE id = ?").run("not-valid-json!!", entry.id);
      dbRaw.close();

      // loadMemoryStoreSqlite must NOT throw despite the bad JSON
      _resetDbForTesting();
      expect(() => loadMemoryStoreSqlite("keyMigBad")).not.toThrow();
      _resetDbForTesting();

      // The row is still present (catch swallowed parse error; UPDATE was skipped)
      const dbAfter = openWasmDb(dbPath, { readonly: true });
      const row = dbAfter.prepare(
        "SELECT id, typeof(embedding) as t FROM memory_entries WHERE id = ?",
      ).get(entry.id) as { id: string; t: string } | undefined;
      dbAfter.close();

      expect(row).toBeDefined();
      expect(row!.id).toBe(entry.id);
      // The malformed row could not be converted — it stays as text
      expect(row!.t).toBe("text");
    } finally {
      _resetDbForTesting();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("is a no-op when no rows have text embeddings — zero-row query exits early", async () => {
    const dbPath = makeTempDbPath();
    process.env["ORAGER_DB_PATH"] = dbPath;
    const { _resetDbForTesting, addMemoryEntrySqlite, loadMemoryStoreSqlite } = await importFresh();
    _resetDbForTesting();

    try {
      // Insert entries with no embedding at all
      addMemoryEntrySqlite("keyMigNone", { content: "no embedding here", importance: 2 });
      _resetDbForTesting();

      // Should open cleanly and return entries unchanged
      _resetDbForTesting();
      const store = loadMemoryStoreSqlite("keyMigNone");
      expect(store.entries).toHaveLength(1);
      expect(store.entries[0].content).toBe("no embedding here");
    } finally {
      _resetDbForTesting();
      fs.rmSync(dbPath, { force: true });
    }
  });
});

describe("full round-trip", () => {
  it("add via addMemoryEntrySqlite, verify persists across fresh loadMemoryStoreSqlite call", async () => {
    const dbPath = makeTempDbPath();
    process.env["ORAGER_DB_PATH"] = dbPath;
    const { _resetDbForTesting, addMemoryEntrySqlite, loadMemoryStoreSqlite } = await importFresh();
    _resetDbForTesting();

    try {
      const entry = addMemoryEntrySqlite("keyG", {
        content: "persistent memory fact",
        tags: ["important"],
        importance: 3,
      });

      // Reset singleton to force a fresh DB connection
      _resetDbForTesting();

      // Reload — path still set, same DB file
      const store = loadMemoryStoreSqlite("keyG");
      expect(store.entries).toHaveLength(1);
      expect(store.entries[0].id).toBe(entry.id);
      expect(store.entries[0].content).toBe("persistent memory fact");
      expect(store.entries[0].importance).toBe(3);
      expect(store.entries[0].tags).toEqual(["important"]);
    } finally {
      _resetDbForTesting();
      fs.rmSync(dbPath, { force: true });
    }
  });
});
