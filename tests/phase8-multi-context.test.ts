/**
 * Tests for Phase 8 — multi-context + cross-agent memory sharing.
 *
 * Covers:
 *  - searchMemoryFtsMulti: empty keys returns [], single key delegates to searchMemoryFts
 *  - searchMemoryFtsMulti: multi-key searches across both namespaces
 *  - makeRememberTool with allowedNamespaces: list merges entries from all namespaces
 *  - makeRememberTool with allowedNamespaces: add writes to primary by default
 *  - makeRememberTool with allowedNamespaces: add with valid target_namespace writes to that namespace
 *  - makeRememberTool with allowedNamespaces: add with invalid target_namespace falls back to primary
 *  - AgentLoopOptions: memoryKey accepts string[]
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── searchMemoryFtsMulti ──────────────────────────────────────────────────────

describe("searchMemoryFtsMulti", () => {
  let tmpDir: string;
  let origDbPath: string | undefined;
  let origMemDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orager-p8-fts-"));
    origDbPath = process.env["ORAGER_DB_PATH"];
    origMemDir = process.env["ORAGER_MEMORY_SQLITE_DIR"];
    process.env["ORAGER_MEMORY_SQLITE_DIR"] = tmpDir;
  });

  afterEach(async () => {
    if (origDbPath !== undefined) {
      process.env["ORAGER_DB_PATH"] = origDbPath;
    } else {
      delete process.env["ORAGER_DB_PATH"];
    }
    if (origMemDir !== undefined) {
      process.env["ORAGER_MEMORY_SQLITE_DIR"] = origMemDir;
    } else {
      delete process.env["ORAGER_MEMORY_SQLITE_DIR"];
    }
    const { _resetDbForTesting } = await import("../src/memory-sqlite.js");
    _resetDbForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array when keys list is empty", async () => {
    const dbPath = path.join(tmpDir, "fts-empty.db");
    process.env["ORAGER_DB_PATH"] = dbPath;
    const { _resetDbForTesting, searchMemoryFtsMulti } = await import("../src/memory-sqlite.js");
    _resetDbForTesting();

    const results = await searchMemoryFtsMulti([], "authentication", 10);
    expect(results).toEqual([]);
  });

  it("single-key call returns entries only from that namespace", async () => {
    const dbPath = path.join(tmpDir, "fts-single.db");
    process.env["ORAGER_DB_PATH"] = dbPath;
    const { _resetDbForTesting, addMemoryEntrySqlite, searchMemoryFtsMulti } =
      await import("../src/memory-sqlite.js");
    _resetDbForTesting();

    // ns-a has unique content; ns-b uses a different phrase so content acts as a discriminator
    await addMemoryEntrySqlite("ns-a", { content: "JWT token validation middleware", importance: 2, tags: [] });
    await addMemoryEntrySqlite("ns-b", { content: "OAuth flow redirect callback", importance: 2, tags: [] });

    // searching "JWT" in only ns-a should return ns-a entry and not the ns-b entry
    const results = await searchMemoryFtsMulti(["ns-a"], "JWT", 10);
    expect(results.length).toBe(1);
    expect(results[0].content).toContain("JWT");
  });

  it("multi-key call returns entries from all namespaces", async () => {
    const dbPath = path.join(tmpDir, "fts-multi.db");
    process.env["ORAGER_DB_PATH"] = dbPath;
    const { _resetDbForTesting, addMemoryEntrySqlite, searchMemoryFtsMulti } =
      await import("../src/memory-sqlite.js");
    _resetDbForTesting();

    await addMemoryEntrySqlite("proj-frontend", { content: "deployment uses Vercel edge network", importance: 2, tags: [] });
    await addMemoryEntrySqlite("proj-shared",   { content: "deployment pipeline triggers on main branch", importance: 2, tags: [] });
    // proj-backend is NOT in the search keys — its entry must not appear
    await addMemoryEntrySqlite("proj-backend",  { content: "deployment on AWS ECS cluster", importance: 2, tags: [] });

    const results = await searchMemoryFtsMulti(["proj-frontend", "proj-shared"], "deployment", 10);
    expect(results.length).toBe(2);

    const contents = results.map((r) => r.content);
    expect(contents.some((c) => c.includes("Vercel"))).toBe(true);
    expect(contents.some((c) => c.includes("pipeline"))).toBe(true);
    // proj-backend AWS entry must NOT appear
    expect(contents.some((c) => c.includes("AWS"))).toBe(false);
  });

  it("multi-key call excludes expired entries", async () => {
    const dbPath = path.join(tmpDir, "fts-expired.db");
    process.env["ORAGER_DB_PATH"] = dbPath;
    const { _resetDbForTesting, addMemoryEntrySqlite, searchMemoryFtsMulti } =
      await import("../src/memory-sqlite.js");
    _resetDbForTesting();

    const pastDate = new Date(Date.now() - 1000).toISOString();
    await addMemoryEntrySqlite("ns-exp", {
      content: "websocket reconnection strategy", importance: 2, tags: [],
      expiresAt: pastDate,
    });
    await addMemoryEntrySqlite("ns-exp", {
      content: "websocket heartbeat interval is 30s", importance: 2, tags: [],
    });

    const results = await searchMemoryFtsMulti(["ns-exp"], "websocket", 10);
    // Only the non-expired entry should come back
    expect(results.length).toBe(1);
    expect(results[0].content).toContain("heartbeat");
  });
});

// ── makeRememberTool with allowedNamespaces ───────────────────────────────────

describe("makeRememberTool multi-namespace", () => {
  let tmpDir: string;
  let origDbPath: string | undefined;
  let origMemDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orager-p8-tool-"));
    origDbPath = process.env["ORAGER_DB_PATH"];
    origMemDir = process.env["ORAGER_MEMORY_SQLITE_DIR"];
    process.env["ORAGER_MEMORY_SQLITE_DIR"] = tmpDir;
  });

  afterEach(async () => {
    if (origDbPath !== undefined) {
      process.env["ORAGER_DB_PATH"] = origDbPath;
    } else {
      delete process.env["ORAGER_DB_PATH"];
    }
    if (origMemDir !== undefined) {
      process.env["ORAGER_MEMORY_SQLITE_DIR"] = origMemDir;
    } else {
      delete process.env["ORAGER_MEMORY_SQLITE_DIR"];
    }
    const { _resetDbForTesting } = await import("../src/memory-sqlite.js");
    _resetDbForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("list merges entries from all allowed namespaces", async () => {
    const dbPath = path.join(tmpDir, "tool-list.db");
    process.env["ORAGER_DB_PATH"] = dbPath;
    const { _resetDbForTesting, addMemoryEntrySqlite } = await import("../src/memory-sqlite.js");
    _resetDbForTesting();

    await addMemoryEntrySqlite("primary-ns", { content: "Primary fact A", importance: 2, tags: [] });
    await addMemoryEntrySqlite("shared-ns",  { content: "Shared fact B", importance: 3, tags: ["shared"] });

    const { makeRememberTool } = await import("../src/tools/remember.js");
    const tool = makeRememberTool("primary-ns", 6000, null, undefined, ["primary-ns", "shared-ns"]);

    const result = await tool.execute({ action: "list" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Primary fact A");
    expect(result.content).toContain("Shared fact B");
  });

  it("add without target_namespace writes to primary key", async () => {
    const dbPath = path.join(tmpDir, "tool-add-default.db");
    process.env["ORAGER_DB_PATH"] = dbPath;
    const { _resetDbForTesting, getMemoryEntryCount } = await import("../src/memory-sqlite.js");
    _resetDbForTesting();

    const { makeRememberTool } = await import("../src/tools/remember.js");
    const tool = makeRememberTool("primary-ns", 6000, null, undefined, ["primary-ns", "shared-ns"]);

    const result = await tool.execute({ action: "add", content: "New fact for primary" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("primary-ns");

    expect(await getMemoryEntryCount("primary-ns")).toBe(1);
    expect(await getMemoryEntryCount("shared-ns")).toBe(0);
  });

  it("add with valid target_namespace writes to that namespace", async () => {
    const dbPath = path.join(tmpDir, "tool-add-target.db");
    process.env["ORAGER_DB_PATH"] = dbPath;
    const { _resetDbForTesting, getMemoryEntryCount } = await import("../src/memory-sqlite.js");
    _resetDbForTesting();

    const { makeRememberTool } = await import("../src/tools/remember.js");
    const tool = makeRememberTool("primary-ns", 6000, null, undefined, ["primary-ns", "shared-ns"]);

    const result = await tool.execute({
      action: "add",
      content: "Shared architecture decision",
      target_namespace: "shared-ns",
    });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("shared-ns");

    expect(await getMemoryEntryCount("shared-ns")).toBe(1);
    expect(await getMemoryEntryCount("primary-ns")).toBe(0);
  });

  it("add with unknown target_namespace silently writes to primary", async () => {
    const dbPath = path.join(tmpDir, "tool-add-unknown.db");
    process.env["ORAGER_DB_PATH"] = dbPath;
    const { _resetDbForTesting, getMemoryEntryCount } = await import("../src/memory-sqlite.js");
    _resetDbForTesting();

    const { makeRememberTool } = await import("../src/tools/remember.js");
    const tool = makeRememberTool("primary-ns", 6000, null, undefined, ["primary-ns", "shared-ns"]);

    const result = await tool.execute({
      action: "add",
      content: "Fact with unknown namespace",
      target_namespace: "totally-unknown-ns",
    });
    expect(result.isError).toBe(false);
    // Should fall back to primary
    expect(await getMemoryEntryCount("primary-ns")).toBe(1);
    expect(await getMemoryEntryCount("totally-unknown-ns")).toBe(0);
  });

  it("single-namespace tool (no allowedNamespaces) behaves identically to before", async () => {
    const dbPath = path.join(tmpDir, "tool-single.db");
    process.env["ORAGER_DB_PATH"] = dbPath;
    const { _resetDbForTesting, getMemoryEntryCount } = await import("../src/memory-sqlite.js");
    _resetDbForTesting();

    const { makeRememberTool } = await import("../src/tools/remember.js");
    const tool = makeRememberTool("solo-ns", 6000, null);

    await tool.execute({ action: "add", content: "Solo namespace fact" });
    expect(await getMemoryEntryCount("solo-ns")).toBe(1);

    const listResult = await tool.execute({ action: "list" });
    expect(listResult.content).toContain("Solo namespace fact");
  });
});

// ── AgentLoopOptions memoryKey type ──────────────────────────────────────────

describe("AgentLoopOptions memoryKey type", () => {
  it("accepts a plain string (backward compat)", () => {
    // Type-level check: if this compiles and runs without error, the type is correct.
    const opts: import("../src/types.js").AgentLoopOptions = {
      model: "gpt-4o",
      memoryKey: "my-project",
    };
    expect(opts.memoryKey).toBe("my-project");
  });

  it("accepts an array of strings (multi-context)", () => {
    const opts: import("../src/types.js").AgentLoopOptions = {
      model: "gpt-4o",
      memoryKey: ["primary-agent", "shared-context"],
    };
    expect(Array.isArray(opts.memoryKey)).toBe(true);
    expect((opts.memoryKey as string[])[0]).toBe("primary-agent");
    expect((opts.memoryKey as string[])[1]).toBe("shared-context");
  });
});
