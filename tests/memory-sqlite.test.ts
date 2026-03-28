import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

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
