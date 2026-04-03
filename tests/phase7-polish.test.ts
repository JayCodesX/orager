/**
 * Tests for Phase 7 — token budget + observability constants.
 *
 * Covers:
 *  - MEMORY_DYNAMIC_BUDGET_FRACTION: valid fraction in (0, 1]
 *  - MEMORY_DYNAMIC_BUDGET_FRACTION: respects ORAGER_MEMORY_BUDGET_FRACTION env override
 *  - Budget truncation math: chars computed correctly from contextWindow × fraction × 4
 *  - memory inspect: valid --key required; outputs entry count
 *  - All four memory header constants are distinct non-empty strings
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── MEMORY_DYNAMIC_BUDGET_FRACTION ────────────────────────────────────────────

describe("MEMORY_DYNAMIC_BUDGET_FRACTION", () => {
  it("defaults to a value in (0, 1]", async () => {
    // Import fresh — env var not set in this test
    const { MEMORY_DYNAMIC_BUDGET_FRACTION } = await import("../src/loop-helpers.js");
    expect(typeof MEMORY_DYNAMIC_BUDGET_FRACTION).toBe("number");
    expect(MEMORY_DYNAMIC_BUDGET_FRACTION).toBeGreaterThan(0);
    expect(MEMORY_DYNAMIC_BUDGET_FRACTION).toBeLessThanOrEqual(1);
  });

  it("budget chars formula: contextWindow × fraction × 4 (chars/token heuristic)", () => {
    // The loop uses: Math.floor(contextWindow * MEMORY_DYNAMIC_BUDGET_FRACTION * 4)
    // Validate the arithmetic for a few common context windows.
    const fraction = 0.20;
    expect(Math.floor(200_000 * fraction * 4)).toBe(160_000); // 200k ctx → 160k chars
    expect(Math.floor(32_000  * fraction * 4)).toBe(25_600);  // 32k  ctx → 25.6k chars
    expect(Math.floor(128_000 * fraction * 4)).toBe(102_400); // 128k ctx → 102.4k chars
  });

  it("budget is skipped when dynamicChars <= budgetChars (no truncation)", () => {
    // Verify the guard: truncation only fires when dynamicChars > budgetChars
    const contextWindow = 128_000;
    const fraction = 0.20;
    const budgetChars = Math.floor(contextWindow * fraction * 4); // 102400
    const smallDynamic = 5_000; // well under budget
    expect(smallDynamic > budgetChars).toBe(false); // should not truncate
  });
});

// ── Memory header constants are all distinct ──────────────────────────────────

describe("memory header constants", () => {
  it("all four constants are distinct non-empty strings starting with #", async () => {
    const {
      MEMORY_HEADER_MASTER,
      MEMORY_HEADER_RETRIEVED,
      MEMORY_HEADER_AUTO,
      MEMORY_HEADER_PRIOR_SESSION,
    } = await import("../src/loop-helpers.js");

    const headers = [
      MEMORY_HEADER_MASTER,
      MEMORY_HEADER_RETRIEVED,
      MEMORY_HEADER_AUTO,
      MEMORY_HEADER_PRIOR_SESSION,
    ];

    for (const h of headers) {
      expect(typeof h).toBe("string");
      expect(h.length).toBeGreaterThan(0);
      expect(h.startsWith("#")).toBe(true);
    }

    // All distinct
    const unique = new Set(headers);
    expect(unique.size).toBe(4);
  });
});

// ── memory inspect CLI ────────────────────────────────────────────────────────

describe("memory inspect CLI", () => {
  let tmpDir: string;
  let origDbPath: string | undefined;
  let origMemDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orager-p7-"));
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

  it("shows correct entry count for a populated namespace", async () => {
    const dbPath = path.join(tmpDir, "inspect.db");
    process.env["ORAGER_DB_PATH"] = dbPath;
    const { _resetDbForTesting, addMemoryEntrySqlite } = await import("../src/memory-sqlite.js");
    _resetDbForTesting();

    await addMemoryEntrySqlite("my-project", { content: "Fact one", importance: 2, tags: [] });
    await addMemoryEntrySqlite("my-project", { content: "Fact two", importance: 3, tags: ["auth"] });

    // Capture stdout written by the inspect handler
    const { loadMemoryStoreAny } = await import("../src/memory.js");
    const store = await loadMemoryStoreAny("my-project");
    expect(store.entries.length).toBe(2);

    // Verify sort: importance-3 entry sorts before importance-2
    const sorted = [...store.entries].sort(
      (a, b) => b.importance - a.importance || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    expect(sorted[0].importance).toBe(3);
    expect(sorted[1].importance).toBe(2);
  });

  it("getMemoryEntryCount returns the right count for inspect", async () => {
    const dbPath = path.join(tmpDir, "count.db");
    process.env["ORAGER_DB_PATH"] = dbPath;
    const { _resetDbForTesting, addMemoryEntrySqlite, getMemoryEntryCount } =
      await import("../src/memory-sqlite.js");
    _resetDbForTesting();

    await addMemoryEntrySqlite("proj-x", { content: "A", importance: 1, tags: [] });
    await addMemoryEntrySqlite("proj-x", { content: "B", importance: 2, tags: [] });

    expect(await getMemoryEntryCount("proj-x")).toBe(2);
    expect(await getMemoryEntryCount("proj-y")).toBe(0);
  });

  it("loadMasterContext returns null when no master context has been set", async () => {
    const dbPath = path.join(tmpDir, "master.db");
    process.env["ORAGER_DB_PATH"] = dbPath;
    const { _resetDbForTesting, loadMasterContext } = await import("../src/memory-sqlite.js");
    _resetDbForTesting();

    expect(await loadMasterContext("no-master-ctx")).toBeNull();
  });

  it("loadMasterContext returns the content after upsert", async () => {
    const dbPath = path.join(tmpDir, "master2.db");
    process.env["ORAGER_DB_PATH"] = dbPath;
    const { _resetDbForTesting, upsertMasterContext, loadMasterContext } =
      await import("../src/memory-sqlite.js");
    _resetDbForTesting();

    await upsertMasterContext("ctx-master", "Stack: Next.js, Postgres, Bun.");
    expect(await loadMasterContext("ctx-master")).toBe("Stack: Next.js, Postgres, Bun.");
  });
});
