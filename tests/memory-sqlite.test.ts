import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { openDb } from "../src/native-sqlite.js";
import { resolveMemoryDbPath } from "../src/memory-sqlite.js";

// We must import after setting ORAGER_DB_PATH, so we use dynamic imports below.
// But we also need to reset the singleton between tests.

function makeTempDbPath(): string {
  return path.join(os.tmpdir(), `orager-memory-test-${randomUUID()}.db`);
}

function makeTempMemoryDir(): string {
  const dir = path.join(os.tmpdir(), `orager-memory-dir-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function importFresh() {
  const mod = await import("../src/memory-sqlite.js");
  return mod;
}

// Use a per-test temp directory for ORAGER_MEMORY_SQLITE_DIR so tests never
// read stale data from ~/.orager/memory/.
let _testMemDir: string;
let _savedMemDir: string | undefined;

beforeEach(() => {
  _savedMemDir = process.env["ORAGER_MEMORY_SQLITE_DIR"];
  _testMemDir = makeTempMemoryDir();
  process.env["ORAGER_MEMORY_SQLITE_DIR"] = _testMemDir;
});

afterEach(async () => {
  const mod = await importFresh();
  mod._resetDbForTesting();
  delete process.env["ORAGER_DB_PATH"];
  if (_savedMemDir !== undefined) process.env["ORAGER_MEMORY_SQLITE_DIR"] = _savedMemDir;
  else delete process.env["ORAGER_MEMORY_SQLITE_DIR"];
  fs.rmSync(_testMemDir, { recursive: true, force: true });
});

describe("isSqliteMemoryEnabled", () => {
  it("returns true by default (SQLite is now the default backend)", async () => {
    // SQLite defaults to ~/.orager/orager.db — no ORAGER_DB_PATH needed.
    delete process.env["ORAGER_DB_PATH"];
    const { isSqliteMemoryEnabled } = await importFresh();
    expect(isSqliteMemoryEnabled()).toBe(true);
  });

  it("returns true when ORAGER_DB_PATH is set to an explicit path", async () => {
    process.env["ORAGER_DB_PATH"] = makeTempDbPath();
    const { isSqliteMemoryEnabled } = await importFresh();
    expect(isSqliteMemoryEnabled()).toBe(true);
  });

  it("returns false when ORAGER_DB_PATH is set to 'none' (explicit opt-out)", async () => {
    process.env["ORAGER_DB_PATH"] = "none";
    const { isSqliteMemoryEnabled } = await importFresh();
    expect(isSqliteMemoryEnabled()).toBe(false);
  });

  it("returns false when ORAGER_DB_PATH is set to empty string (explicit opt-out)", async () => {
    process.env["ORAGER_DB_PATH"] = "";
    const { isSqliteMemoryEnabled } = await importFresh();
    expect(isSqliteMemoryEnabled()).toBe(false);
  });
});

describe("addMemoryEntrySqlite + loadMemoryStoreSqlite", () => {
  it("inserts an entry and loadMemoryStoreSqlite returns it", async () => {
    const dbPath = makeTempDbPath();
    process.env["ORAGER_DB_PATH"] = dbPath;
    const { _resetDbForTesting, addMemoryEntrySqlite, loadMemoryStoreSqlite } = await importFresh();
    _resetDbForTesting();

    try {
      const entry = await addMemoryEntrySqlite("key1", {
        content: "test content",
        importance: 2,
      });

      expect(entry.id).toBeTruthy();
      expect(entry.createdAt).toBeTruthy();
      expect(entry.content).toBe("test content");

      const store = await loadMemoryStoreSqlite("key1");
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
      const entry = await addMemoryEntrySqlite("key2", {
        content: "to be deleted",
        importance: 2,
      });

      const deleted = await removeMemoryEntrySqlite("key2", entry.id);
      expect(deleted).toBe(true);

      const store = await loadMemoryStoreSqlite("key2");
      expect(store.entries).toHaveLength(0);

      // Removing again returns false
      const deletedAgain = await removeMemoryEntrySqlite("key2", entry.id);
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
      await addMemoryEntrySqlite("keyA", { content: "entry for keyA", importance: 2 });
      await addMemoryEntrySqlite("keyB", { content: "entry for keyB", importance: 2 });

      const storeA = await loadMemoryStoreSqlite("keyA");
      expect(storeA.entries).toHaveLength(1);
      expect(storeA.entries[0].content).toBe("entry for keyA");

      const storeB = await loadMemoryStoreSqlite("keyB");
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
      await addMemoryEntrySqlite("keyC", {
        content: "expired entry",
        importance: 2,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      });

      // Add a live entry
      await addMemoryEntrySqlite("keyC", {
        content: "live entry",
        importance: 2,
      });

      const store = await loadMemoryStoreSqlite("keyC");
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
      await addMemoryEntrySqlite("keyD", { content: "TypeScript configuration is important", importance: 2 });
      await addMemoryEntrySqlite("keyD", { content: "User prefers dark mode", importance: 2 });

      const results = await searchMemoryFts("keyD", "TypeScript configuration");
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
      await addMemoryEntrySqlite("keyE", { content: "unique phrase only in keyE", importance: 2 });
      await addMemoryEntrySqlite("keyF", { content: "different content for keyF", importance: 2 });

      const results = await searchMemoryFts("keyF", "unique phrase only in keyE");
      expect(results).toHaveLength(0);
    } finally {
      _resetDbForTesting();
      fs.rmSync(dbPath, { force: true });
    }
  });
});

describe("_migrate — JSON text embedding → Float32 BLOB conversion", () => {
  it("converts a JSON text embedding to binary BLOB on the next DB open", async () => {
    process.env["ORAGER_DB_PATH"] = makeTempDbPath();
    const { _resetDbForTesting, addMemoryEntrySqlite, loadMemoryStoreSqlite } = await importFresh();
    _resetDbForTesting();

    // Create schema + insert a real entry via the module
    const entry = await addMemoryEntrySqlite("keyMig", { content: "migration test content", importance: 2 });
    _resetDbForTesting(); // closes DB and flushes to file

    // Use the actual per-namespace DB path (not ORAGER_DB_PATH)
    const actualDbPath = resolveMemoryDbPath("keyMig");

    // Directly overwrite the embedding column with a JSON text string (legacy format)
    const embeddingJson = JSON.stringify([1.0, 2.0, 3.0]);
    const dbRaw = await openDb(actualDbPath);
    dbRaw.prepare("UPDATE memory_entries SET embedding = ? WHERE id = ?").run(embeddingJson, entry.id);
    dbRaw.close();

    // Confirm the embedding is stored as TEXT before migration
    const dbBefore = await openDb(actualDbPath, { readonly: true });
    const before = dbBefore.prepare(
      "SELECT typeof(embedding) as t FROM memory_entries WHERE id = ?",
    ).get(entry.id) as { t: string };
    dbBefore.close();
    expect(before.t).toBe("text");

    // Re-open via memory-sqlite module — _migrate() converts TEXT → BLOB
    _resetDbForTesting();
    await loadMemoryStoreSqlite("keyMig");
    _resetDbForTesting(); // flush, close

    // Confirm the embedding is now stored as BLOB
    const dbAfter = await openDb(actualDbPath, { readonly: true });
    const after = dbAfter.prepare(
      "SELECT typeof(embedding) as t FROM memory_entries WHERE id = ?",
    ).get(entry.id) as { t: string };
    dbAfter.close();
    expect(after.t).toBe("blob");
  });

  it("silently skips rows with malformed JSON — entry is preserved, embedding stays as text", async () => {
    process.env["ORAGER_DB_PATH"] = makeTempDbPath();
    const { _resetDbForTesting, addMemoryEntrySqlite, loadMemoryStoreSqlite } = await importFresh();
    _resetDbForTesting();

    const entry = await addMemoryEntrySqlite("keyMigBad", { content: "malformed embedding test", importance: 2 });
    _resetDbForTesting();

    // Use the actual per-namespace DB path
    const actualDbPath = resolveMemoryDbPath("keyMigBad");

    // Inject invalid JSON as the embedding TEXT value
    const dbRaw = await openDb(actualDbPath);
    dbRaw.prepare("UPDATE memory_entries SET embedding = ? WHERE id = ?").run("not-valid-json!!", entry.id);
    dbRaw.close();

    // loadMemoryStoreSqlite must NOT throw despite the bad JSON
    _resetDbForTesting();
    await expect(loadMemoryStoreSqlite("keyMigBad")).resolves.toBeDefined();
    _resetDbForTesting();

    // The row is still present (catch swallowed parse error; UPDATE was skipped)
    const dbAfter = await openDb(actualDbPath, { readonly: true });
    const row = dbAfter.prepare(
      "SELECT id, typeof(embedding) as t FROM memory_entries WHERE id = ?",
    ).get(entry.id) as { id: string; t: string } | undefined;
    dbAfter.close();

    expect(row).toBeDefined();
    expect(row!.id).toBe(entry.id);
    // The malformed row could not be converted — it stays as text
    expect(row!.t).toBe("text");
  });

  it("is a no-op when no rows have text embeddings — zero-row query exits early", async () => {
    const dbPath = makeTempDbPath();
    process.env["ORAGER_DB_PATH"] = dbPath;
    const { _resetDbForTesting, addMemoryEntrySqlite, loadMemoryStoreSqlite } = await importFresh();
    _resetDbForTesting();

    try {
      // Insert entries with no embedding at all
      await addMemoryEntrySqlite("keyMigNone", { content: "no embedding here", importance: 2 });
      _resetDbForTesting();

      // Should open cleanly and return entries unchanged
      _resetDbForTesting();
      const store = await loadMemoryStoreSqlite("keyMigNone");
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
      const entry = await addMemoryEntrySqlite("keyG", {
        content: "persistent memory fact",
        tags: ["important"],
        importance: 3,
      });

      // Reset singleton to force a fresh DB connection
      _resetDbForTesting();

      // Reload — path still set, same DB file
      const store = await loadMemoryStoreSqlite("keyG");
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

describe("loadMasterContext + upsertMasterContext", () => {
  it("returns null when no master context has been set", async () => {
    const dbPath = makeTempDbPath();
    process.env["ORAGER_DB_PATH"] = dbPath;
    const { _resetDbForTesting, loadMasterContext } = await importFresh();
    _resetDbForTesting();

    try {
      const ctx = await loadMasterContext("my-project");
      expect(ctx).toBeNull();
    } finally {
      _resetDbForTesting();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("saves and retrieves master context", async () => {
    const dbPath = makeTempDbPath();
    process.env["ORAGER_DB_PATH"] = dbPath;
    const { _resetDbForTesting, loadMasterContext, upsertMasterContext } = await importFresh();
    _resetDbForTesting();

    try {
      await upsertMasterContext("my-project", "B2B analytics SaaS targeting mid-market finance teams.");
      const ctx = await loadMasterContext("my-project");
      expect(ctx).toBe("B2B analytics SaaS targeting mid-market finance teams.");
    } finally {
      _resetDbForTesting();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("upsert replaces previous master context — only one row active at a time", async () => {
    const dbPath = makeTempDbPath();
    process.env["ORAGER_DB_PATH"] = dbPath;
    const { _resetDbForTesting, loadMasterContext, upsertMasterContext } = await importFresh();
    _resetDbForTesting();

    try {
      await upsertMasterContext("proj", "Version 1");
      await upsertMasterContext("proj", "Version 2 — updated goals");
      const ctx = await loadMasterContext("proj");
      expect(ctx).toBe("Version 2 — updated goals");
    } finally {
      _resetDbForTesting();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("master context is scoped to context_id — different contexts are isolated", async () => {
    const dbPath = makeTempDbPath();
    process.env["ORAGER_DB_PATH"] = dbPath;
    const { _resetDbForTesting, loadMasterContext, upsertMasterContext } = await importFresh();
    _resetDbForTesting();

    try {
      await upsertMasterContext("project-a", "Context for project A");
      await upsertMasterContext("project-b", "Context for project B");

      expect(await loadMasterContext("project-a")).toBe("Context for project A");
      expect(await loadMasterContext("project-b")).toBe("Context for project B");
      expect(await loadMasterContext("project-c")).toBeNull();
    } finally {
      _resetDbForTesting();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("truncates content that exceeds MASTER_CONTEXT_MAX_CHARS", async () => {
    const dbPath = makeTempDbPath();
    process.env["ORAGER_DB_PATH"] = dbPath;
    const { _resetDbForTesting, loadMasterContext, upsertMasterContext, MASTER_CONTEXT_MAX_CHARS } = await importFresh();
    _resetDbForTesting();

    try {
      const oversized = "x".repeat((MASTER_CONTEXT_MAX_CHARS as number) + 500);
      await upsertMasterContext("proj", oversized);
      const ctx = await loadMasterContext("proj");
      expect(ctx?.length).toBe(MASTER_CONTEXT_MAX_CHARS as number);
    } finally {
      _resetDbForTesting();
      fs.rmSync(dbPath, { force: true });
    }
  });
});
