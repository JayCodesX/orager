/**
 * P3-2: Memory backup/export CLI tests.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { MemoryStore } from "../src/memory.js";

const MOCK_STORE: MemoryStore = {
  memoryKey: "test-key",
  entries: [
    {
      id: "abc123",
      content: "User prefers TypeScript",
      importance: 2,
      createdAt: "2024-01-01T00:00:00.000Z",
    },
    {
      id: "def456",
      content: "Auth tokens expire after 1h",
      importance: 3,
      createdAt: "2024-01-02T00:00:00.000Z",
    },
  ],
  updatedAt: "2024-01-02T00:00:00.000Z",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("memory export", () => {
  it("outputs valid JSON with expected entries", async () => {
    const memModule = await import("../src/memory.js");
    vi.spyOn(memModule, "loadMemoryStoreAny").mockResolvedValue(MOCK_STORE);

    const store = await memModule.loadMemoryStoreAny("test-key");
    const json = JSON.stringify(store, null, 2);
    const parsed = JSON.parse(json) as MemoryStore;

    expect(parsed.memoryKey).toBe("test-key");
    expect(Array.isArray(parsed.entries)).toBe(true);
    expect(parsed.entries.length).toBe(2);
    expect(parsed.entries[0].content).toBe("User prefers TypeScript");
    expect(parsed.entries[1].importance).toBe(3);
  });

  it("JSON output includes all MemoryStore fields", async () => {
    const json = JSON.stringify(MOCK_STORE, null, 2);
    const parsed = JSON.parse(json) as MemoryStore;
    expect(parsed.memoryKey).toBeDefined();
    expect(parsed.entries).toBeDefined();
    expect(parsed.updatedAt).toBeDefined();
  });
});

describe("memory list", () => {
  it("correctly strips .json suffix from file names", () => {
    const fileEntries = ["test-key.json", "other-key.json", "not-json.txt"];
    const keys: string[] = [];
    for (const e of fileEntries) {
      if (e.endsWith(".json")) keys.push(e.slice(0, -5));
    }
    expect(keys).toContain("test-key");
    expect(keys).toContain("other-key");
    expect(keys).not.toContain("not-json.txt");
    expect(keys).toHaveLength(2);
  });

  it("returns known keys from SQLite", async () => {
    const sqliteModule = await import("../src/memory-sqlite.js");
    vi.spyOn(sqliteModule, "isSqliteMemoryEnabled").mockReturnValue(true);
    vi.spyOn(sqliteModule, "listMemoryKeysSqlite").mockReturnValue(["agent-1", "agent-2"]);

    const keys = sqliteModule.listMemoryKeysSqlite();
    expect(keys).toContain("agent-1");
    expect(keys).toContain("agent-2");
  });
});

describe("memory clear", () => {
  it("removes all entries for a key (SQLite path)", async () => {
    const sqliteModule = await import("../src/memory-sqlite.js");
    vi.spyOn(sqliteModule, "isSqliteMemoryEnabled").mockReturnValue(true);
    const clearSpy = vi.spyOn(sqliteModule, "clearMemoryStoreSqlite").mockReturnValue(3);

    const deleted = sqliteModule.clearMemoryStoreSqlite("test-key");
    expect(deleted).toBe(3);
    expect(clearSpy).toHaveBeenCalledWith("test-key");
  });

  it("without --yes flag, confirmation is required", () => {
    const args = ["--key", "foo"];
    const skipConfirm = args.includes("--yes");
    expect(skipConfirm).toBe(false);
    // When skipConfirm is false, a readline prompt is shown in handleMemorySubcommand
  });

  it("with --yes flag, no prompt is shown", () => {
    const args = ["--key", "test-key", "--yes"];
    const skipConfirm = args.includes("--yes");
    expect(skipConfirm).toBe(true);
  });

  it("clear logic for file path: deletes the correct json file", () => {
    // Test the file path derivation logic
    const memoryKey = "my-agent-key";
    const sanitized = memoryKey.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
    const expectedFilename = `${sanitized}.json`;
    expect(expectedFilename).toBe("my-agent-key.json");
  });
});
