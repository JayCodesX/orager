import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteSessionStore } from "../src/session-sqlite.js";

describe("file-based session store", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orager-sessions-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("saves and loads a session", async () => {
    const dbPath = path.join(tmpDir, "test.db");
    const store = await SqliteSessionStore.create(dbPath);

    const data = {
      sessionId: "test-123",
      model: "gpt-4o",
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      turnCount: 0,
      cwd: "/tmp",
    };

    await store.save(data);
    const loaded = await store.load("test-123");
    expect(loaded).not.toBeNull();
    expect(loaded!.sessionId).toBe("test-123");
    expect(loaded!.model).toBe("gpt-4o");
  });

  it("returns null for non-existent session", async () => {
    const store = await SqliteSessionStore.create(path.join(tmpDir, "test2.db"));
    const result = await store.load("does-not-exist");
    expect(result).toBeNull();
  });

  it("trashed sessions are hidden from load but visible to loadRaw", async () => {
    const store = await SqliteSessionStore.create(path.join(tmpDir, "test3.db"));

    const data = {
      sessionId: "trashed-456",
      model: "gpt-4o",
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      turnCount: 0,
      cwd: "/tmp",
      trashed: true as const,
    };

    await store.save(data);
    expect(await store.load("trashed-456")).toBeNull();
    expect(await store.loadRaw("trashed-456")).not.toBeNull();
  });

  it("lists sessions sorted by updatedAt desc", async () => {
    const store = await SqliteSessionStore.create(path.join(tmpDir, "test4.db"));

    const base = { messages: [], turnCount: 0, cwd: "/tmp" };
    await store.save({ ...base, sessionId: "a", model: "m", createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z" });
    await store.save({ ...base, sessionId: "b", model: "m", createdAt: "2024-01-02T00:00:00Z", updatedAt: "2024-01-02T00:00:00Z" });
    await store.save({ ...base, sessionId: "c", model: "m", createdAt: "2024-01-03T00:00:00Z", updatedAt: "2024-01-03T00:00:00Z" });

    const list = await store.list();
    expect(list[0].sessionId).toBe("c");
    expect(list[2].sessionId).toBe("a");
  });

  it("advisory lock prevents concurrent resume", async () => {
    const store = await SqliteSessionStore.create(path.join(tmpDir, "test5.db"));

    const release = await store.acquireLock("lock-test");
    await expect(store.acquireLock("lock-test")).rejects.toThrow(/already being resumed/);
    await release();
    // After release, should be acquirable again
    const release2 = await store.acquireLock("lock-test");
    await release2();
  });

  it("prunes sessions older than threshold", async () => {
    const store = await SqliteSessionStore.create(path.join(tmpDir, "test6.db"));

    const old = new Date(Date.now() - 10000).toISOString();
    const recent = new Date().toISOString();
    const base = { messages: [], turnCount: 0, cwd: "/tmp", model: "m", createdAt: old };

    await store.save({ ...base, sessionId: "old-1", updatedAt: old });
    await store.save({ ...base, sessionId: "old-2", updatedAt: old });
    await store.save({ ...base, sessionId: "new-1", updatedAt: recent });

    const result = await store.prune(5000); // older than 5 seconds
    expect(result.deleted).toBe(2);
    expect(await store.load("new-1")).not.toBeNull();
    expect(await store.load("old-1")).toBeNull();
  });
});
