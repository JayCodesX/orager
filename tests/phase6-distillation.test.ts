/**
 * Tests for Phase 6 — embeddings fallback + long-term distillation.
 *
 * Covers:
 *  - DISTILL_ENTRY_THRESHOLD / DISTILL_BATCH_SIZE are sane positive integers
 *  - distillMemoryEntries: parses valid JSON array from LLM response
 *  - distillMemoryEntries: strips markdown fences from LLM response
 *  - distillMemoryEntries: returns empty array on parse failure / non-array / empty input
 *  - distillMemoryEntries: clamps / defaults importance values
 *  - distillMemoryEntries: skips items with missing/empty content
 *  - getMemoryEntryCount: 0 for empty namespace, correct count, excludes expired entries
 *  - getEntriesForDistillation: ordering, importance<3 filter, limit
 *  - deleteMemoryEntriesByIds: deletes exactly specified IDs; no-ops on empty array
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mocked } from "./mock-helpers.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Mock openrouter so distillMemoryEntries doesn't hit the network ───────────

vi.mock("../src/openrouter.js", () => ({
  callOpenRouter: vi.fn(),
  callDirect: vi.fn(),
  shouldUseDirect: vi.fn().mockReturnValue(false),
  callEmbeddings: vi.fn(),
  fetchGenerationMeta: vi.fn(),
}));

// ── Distillation constants ────────────────────────────────────────────────────

describe("Phase 6 constants", () => {
  it("DISTILL_ENTRY_THRESHOLD is a positive integer", async () => {
    const { DISTILL_ENTRY_THRESHOLD } = await import("../src/loop-helpers.js");
    expect(typeof DISTILL_ENTRY_THRESHOLD).toBe("number");
    expect(Number.isInteger(DISTILL_ENTRY_THRESHOLD)).toBe(true);
    expect(DISTILL_ENTRY_THRESHOLD).toBeGreaterThan(0);
  });

  it("DISTILL_BATCH_SIZE is a positive integer less than DISTILL_ENTRY_THRESHOLD", async () => {
    const { DISTILL_BATCH_SIZE, DISTILL_ENTRY_THRESHOLD } = await import("../src/loop-helpers.js");
    expect(Number.isInteger(DISTILL_BATCH_SIZE)).toBe(true);
    expect(DISTILL_BATCH_SIZE).toBeGreaterThan(0);
    expect(DISTILL_BATCH_SIZE).toBeLessThan(DISTILL_ENTRY_THRESHOLD);
  });
});

// ── distillMemoryEntries (unit — mocked callOpenRouter) ───────────────────────

describe("distillMemoryEntries", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const SAMPLE_ENTRIES = [
    { id: "1", content: "Auth uses JWT", tags: ["auth"], createdAt: "2025-01-01T00:00:00Z", importance: 2 as const },
    { id: "2", content: "DB is Postgres", tags: ["db"],  createdAt: "2025-01-01T00:00:00Z", importance: 1 as const },
  ];

  it("returns empty array when entries input is empty", async () => {
    const { distillMemoryEntries } = await import("../src/loop-helpers.js");
    const result = await distillMemoryEntries([], "key", "model");
    expect(result).toEqual([]);
  });

  it("parses a valid JSON array from the LLM response", async () => {
    const { callOpenRouter } = await import("../src/openrouter.js");
    mocked(callOpenRouter).mockResolvedValue({
      content: '[{"content":"Auth uses JWT RS256","importance":2,"tags":["auth","jwt"]},{"content":"DB is Postgres 16","importance":1,"tags":["db"]}]',
      toolCalls: [],
      finishReason: "stop",
    } as never);

    const { distillMemoryEntries } = await import("../src/loop-helpers.js");
    const result = await distillMemoryEntries(SAMPLE_ENTRIES, "key", "model");
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe("Auth uses JWT RS256");
    expect(result[0].importance).toBe(2);
    expect(result[0].tags).toEqual(["auth", "jwt"]);
    expect(result[1].importance).toBe(1);
  });

  it("strips markdown code fences before parsing", async () => {
    const { callOpenRouter } = await import("../src/openrouter.js");
    mocked(callOpenRouter).mockResolvedValue({
      content: '```json\n[{"content":"Single fact","importance":2,"tags":[]}]\n```',
      toolCalls: [],
      finishReason: "stop",
    } as never);

    const { distillMemoryEntries } = await import("../src/loop-helpers.js");
    const result = await distillMemoryEntries(SAMPLE_ENTRIES, "key", "model");
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("Single fact");
  });

  it("returns empty array when LLM returns non-array JSON", async () => {
    const { callOpenRouter } = await import("../src/openrouter.js");
    mocked(callOpenRouter).mockResolvedValue({
      content: '{"content":"not an array"}',
      toolCalls: [],
      finishReason: "stop",
    } as never);

    const { distillMemoryEntries } = await import("../src/loop-helpers.js");
    const result = await distillMemoryEntries(SAMPLE_ENTRIES, "key", "model");
    expect(result).toEqual([]);
  });

  it("returns empty array when LLM returns malformed JSON", async () => {
    const { callOpenRouter } = await import("../src/openrouter.js");
    mocked(callOpenRouter).mockResolvedValue({
      content: "not json at all",
      toolCalls: [],
      finishReason: "stop",
    } as never);

    const { distillMemoryEntries } = await import("../src/loop-helpers.js");
    const result = await distillMemoryEntries(SAMPLE_ENTRIES, "key", "model");
    expect(result).toEqual([]);
  });

  it("clamps out-of-range importance to 2 and defaults missing importance to 2", async () => {
    const { callOpenRouter } = await import("../src/openrouter.js");
    mocked(callOpenRouter).mockResolvedValue({
      content: '[{"content":"Fact A","importance":99,"tags":[]},{"content":"Fact B","tags":[]}]',
      toolCalls: [],
      finishReason: "stop",
    } as never);

    const { distillMemoryEntries } = await import("../src/loop-helpers.js");
    const result = await distillMemoryEntries(SAMPLE_ENTRIES, "key", "model");
    expect(result[0].importance).toBe(2);
    expect(result[1].importance).toBe(2);
  });

  it("skips items with missing or empty content field", async () => {
    const { callOpenRouter } = await import("../src/openrouter.js");
    mocked(callOpenRouter).mockResolvedValue({
      content: '[{"content":"","importance":2,"tags":[]},{"importance":2,"tags":[]},{"content":"Valid","importance":2,"tags":[]}]',
      toolCalls: [],
      finishReason: "stop",
    } as never);

    const { distillMemoryEntries } = await import("../src/loop-helpers.js");
    const result = await distillMemoryEntries(SAMPLE_ENTRIES, "key", "model");
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("Valid");
  });
});

// ── SQLite distillation helpers ───────────────────────────────────────────────

describe("distillation SQLite helpers", () => {
  let tmpDir: string;
  // memory-sqlite uses ORAGER_MEMORY_SQLITE_DIR (not ORAGER_DB_PATH) via resolveMemoryDir()
  let origMemorySqliteDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orager-p6-"));
    origMemorySqliteDir = process.env["ORAGER_MEMORY_SQLITE_DIR"];
  });

  afterEach(async () => {
    if (origMemorySqliteDir !== undefined) {
      process.env["ORAGER_MEMORY_SQLITE_DIR"] = origMemorySqliteDir;
    } else {
      delete process.env["ORAGER_MEMORY_SQLITE_DIR"];
    }
    const { _resetDbForTesting } = await import("../src/memory-sqlite.js");
    _resetDbForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Point per-namespace memory files at the temp dir so tests never touch
  // ~/.orager/memory/. Each namespace gets its own file: tmpDir/<ns>.sqlite.
  async function openTestDb() {
    process.env["ORAGER_MEMORY_SQLITE_DIR"] = tmpDir;
    const { _resetDbForTesting, loadMemoryStoreSqlite } = await import("../src/memory-sqlite.js");
    _resetDbForTesting();
    // Trigger schema creation for the sentinel namespace
    await loadMemoryStoreSqlite("__init__");
  }

  it("getMemoryEntryCount returns 0 for an empty namespace", async () => {
    await openTestDb();
    const { getMemoryEntryCount } = await import("../src/memory-sqlite.js");
    expect(await getMemoryEntryCount("ctx-empty")).toBe(0);
  });

  it("getMemoryEntryCount counts only non-expired regular entries", async () => {
    await openTestDb();
    const { addMemoryEntrySqlite, getMemoryEntryCount } = await import("../src/memory-sqlite.js");
    const past = new Date(Date.now() - 1000).toISOString();
    await addMemoryEntrySqlite("ctx-count", { content: "Active 1", importance: 2, tags: [] });
    await addMemoryEntrySqlite("ctx-count", { content: "Active 2", importance: 1, tags: [] });
    await addMemoryEntrySqlite("ctx-count", { content: "Expired", importance: 2, tags: [], expiresAt: past });
    expect(await getMemoryEntryCount("ctx-count")).toBe(2);
  });

  it("getEntriesForDistillation excludes importance=3 entries and orders by importance ASC", async () => {
    await openTestDb();
    const { addMemoryEntrySqlite, getEntriesForDistillation } = await import("../src/memory-sqlite.js");
    await addMemoryEntrySqlite("ctx-dist", { content: "High", importance: 3, tags: [] });
    await addMemoryEntrySqlite("ctx-dist", { content: "Normal", importance: 2, tags: [] });
    await addMemoryEntrySqlite("ctx-dist", { content: "Low", importance: 1, tags: [] });

    const entries = await getEntriesForDistillation("ctx-dist", 10);
    expect(entries.every((e) => e.importance < 3)).toBe(true);
    expect(entries[0].importance).toBe(1);
    expect(entries).toHaveLength(2);
  });

  it("getEntriesForDistillation respects the limit", async () => {
    await openTestDb();
    const { addMemoryEntrySqlite, getEntriesForDistillation } = await import("../src/memory-sqlite.js");
    for (let i = 0; i < 10; i++) {
      await addMemoryEntrySqlite("ctx-lim", { content: `Fact ${i}`, importance: 2, tags: [] });
    }
    const entries = await getEntriesForDistillation("ctx-lim", 4);
    expect(entries).toHaveLength(4);
  });

  it("deleteMemoryEntriesByIds removes only the specified entries", async () => {
    await openTestDb();
    const { addMemoryEntrySqlite, deleteMemoryEntriesByIds, loadMemoryStoreSqlite } =
      await import("../src/memory-sqlite.js");
    const e1 = await addMemoryEntrySqlite("ctx-del", { content: "Keep", importance: 2, tags: [] });
    const e2 = await addMemoryEntrySqlite("ctx-del", { content: "Delete", importance: 1, tags: [] });

    await deleteMemoryEntriesByIds([e2.id]);

    const store = await loadMemoryStoreSqlite("ctx-del");
    expect(store.entries).toHaveLength(1);
    expect(store.entries[0].id).toBe(e1.id);
  });

  it("deleteMemoryEntriesByIds is a no-op for an empty array", async () => {
    await openTestDb();
    const { addMemoryEntrySqlite, deleteMemoryEntriesByIds, loadMemoryStoreSqlite } =
      await import("../src/memory-sqlite.js");
    await addMemoryEntrySqlite("ctx-noop", { content: "Safe", importance: 2, tags: [] });
    await deleteMemoryEntriesByIds([]);
    const store = await loadMemoryStoreSqlite("ctx-noop");
    expect(store.entries).toHaveLength(1);
  });
});
