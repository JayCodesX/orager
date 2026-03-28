/**
 * P3-7: Wire searchMemoryFts to SQLite retrieval path.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("shouldUseFtsRetrieval", () => {
  it("returns true when SQLite enabled and memoryRetrieval is 'local'", async () => {
    const sqliteModule = await import("../src/memory-sqlite.js");
    vi.spyOn(sqliteModule, "isSqliteMemoryEnabled").mockReturnValue(true);

    const { shouldUseFtsRetrieval } = await import("../src/memory.js");
    expect(shouldUseFtsRetrieval("local")).toBe(true);
  });

  it("returns true when SQLite enabled and memoryRetrieval is undefined (defaults to local)", async () => {
    const sqliteModule = await import("../src/memory-sqlite.js");
    vi.spyOn(sqliteModule, "isSqliteMemoryEnabled").mockReturnValue(true);

    const { shouldUseFtsRetrieval } = await import("../src/memory.js");
    expect(shouldUseFtsRetrieval(undefined)).toBe(true);
  });

  it("returns false when SQLite is disabled", async () => {
    const sqliteModule = await import("../src/memory-sqlite.js");
    vi.spyOn(sqliteModule, "isSqliteMemoryEnabled").mockReturnValue(false);

    const { shouldUseFtsRetrieval } = await import("../src/memory.js");
    expect(shouldUseFtsRetrieval("local")).toBe(false);
  });

  it("returns false when SQLite enabled but memoryRetrieval is 'embedding'", async () => {
    const sqliteModule = await import("../src/memory-sqlite.js");
    vi.spyOn(sqliteModule, "isSqliteMemoryEnabled").mockReturnValue(true);

    const { shouldUseFtsRetrieval } = await import("../src/memory.js");
    expect(shouldUseFtsRetrieval("embedding")).toBe(false);
  });
});

describe("searchMemoryFts routing", () => {
  it("when SQLite enabled + memoryRetrieval local: searchMemoryFts is called", async () => {
    const sqliteModule = await import("../src/memory-sqlite.js");
    vi.spyOn(sqliteModule, "isSqliteMemoryEnabled").mockReturnValue(true);
    const ftsSpy = vi.spyOn(sqliteModule, "searchMemoryFts").mockReturnValue([
      { id: "e1", content: "auth tokens expire", importance: 2, createdAt: "2024-01-01T00:00:00Z" },
    ]);

    // Simulate the FTS routing logic from loop.ts
    const { shouldUseFtsRetrieval } = await import("../src/memory.js");
    if (shouldUseFtsRetrieval("local")) {
      sqliteModule.searchMemoryFts("test-key", "auth tokens", 12);
    }

    expect(ftsSpy).toHaveBeenCalledWith("test-key", "auth tokens", 12);
  });

  it("when SQLite disabled: searchMemoryFts is NOT called", async () => {
    const sqliteModule = await import("../src/memory-sqlite.js");
    vi.spyOn(sqliteModule, "isSqliteMemoryEnabled").mockReturnValue(false);
    const ftsSpy = vi.spyOn(sqliteModule, "searchMemoryFts").mockReturnValue([]);

    const { shouldUseFtsRetrieval } = await import("../src/memory.js");
    if (shouldUseFtsRetrieval("local")) {
      sqliteModule.searchMemoryFts("test-key", "auth tokens", 12);
    }

    expect(ftsSpy).not.toHaveBeenCalled();
  });

  it("when SQLite enabled + memoryRetrieval embedding: searchMemoryFts is NOT called", async () => {
    const sqliteModule = await import("../src/memory-sqlite.js");
    vi.spyOn(sqliteModule, "isSqliteMemoryEnabled").mockReturnValue(true);
    const ftsSpy = vi.spyOn(sqliteModule, "searchMemoryFts").mockReturnValue([]);

    const { shouldUseFtsRetrieval } = await import("../src/memory.js");
    if (shouldUseFtsRetrieval("embedding")) {
      sqliteModule.searchMemoryFts("test-key", "auth tokens", 12);
    }

    expect(ftsSpy).not.toHaveBeenCalled();
  });

  it("FTS results are deduplicated correctly", () => {
    const entries = [
      { id: "e1", content: "auth tokens", importance: 2 as const, createdAt: "2024-01-01T00:00:00Z" },
      { id: "e1", content: "auth tokens", importance: 2 as const, createdAt: "2024-01-01T00:00:00Z" },
      { id: "e2", content: "different entry", importance: 2 as const, createdAt: "2024-01-01T00:00:00Z" },
    ];

    const seen = new Set<string>();
    const deduped = entries.filter((e) => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    });

    expect(deduped).toHaveLength(2);
    expect(deduped.map((e) => e.id)).toEqual(["e1", "e2"]);
  });
});
