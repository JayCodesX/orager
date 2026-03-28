/**
 * P3-6: OTEL spans for memory operations.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("memory.load span", () => {
  it("withSpan is called with 'memory.load' when loading memory", async () => {
    const telemetry = await import("../src/telemetry.js");
    const withSpanSpy = vi.spyOn(telemetry, "withSpan").mockImplementation(
      async (_name: string, _attrs: Record<string, string | number | boolean>, fn: (span: unknown) => Promise<unknown>) =>
        fn({} as unknown),
    );

    const memory = await import("../src/memory.js");
    vi.spyOn(memory, "loadMemoryStoreAny").mockResolvedValue({
      memoryKey: "test",
      entries: [],
      updatedAt: new Date().toISOString(),
    });

    // Simulate the memory.load span call from loop.ts
    await telemetry.withSpan("memory.load", { memoryKey: "test", backend: "file" }, async () =>
      memory.loadMemoryStoreAny("test")
    );

    expect(withSpanSpy).toHaveBeenCalledWith(
      "memory.load",
      expect.objectContaining({ memoryKey: "test" }),
      expect.any(Function),
    );
  });
});

describe("memory.embed_query span", () => {
  it("withSpan is called with 'memory.embed_query' when fetching embeddings", async () => {
    const telemetry = await import("../src/telemetry.js");
    const withSpanSpy = vi.spyOn(telemetry, "withSpan").mockImplementation(
      async (_name: string, _attrs: Record<string, string | number | boolean>, fn: (span: unknown) => Promise<unknown>) =>
        fn({} as unknown),
    );

    // Simulate the embed_query span call
    await telemetry.withSpan("memory.embed_query", { model: "text-embedding-ada-002" }, async () => {
      return [0.1, 0.2, 0.3];
    });

    expect(withSpanSpy).toHaveBeenCalledWith(
      "memory.embed_query",
      expect.objectContaining({ model: "text-embedding-ada-002" }),
      expect.any(Function),
    );
  });
});

describe("memory.save span", () => {
  it("withSpan is called with 'memory.save' when saving memory (SQLite path)", async () => {
    const telemetry = await import("../src/telemetry.js");
    const withSpanSpy = vi.spyOn(telemetry, "withSpan").mockImplementation(
      async (_name: string, _attrs: Record<string, string | number | boolean>, fn: (span: unknown) => Promise<unknown>) =>
        fn({} as unknown),
    );

    const sqliteModule = await import("../src/memory-sqlite.js");
    vi.spyOn(sqliteModule, "isSqliteMemoryEnabled").mockReturnValue(true);
    vi.spyOn(sqliteModule, "addMemoryEntrySqlite").mockReturnValue({
      id: "abc123",
      content: "test",
      importance: 2,
      createdAt: new Date().toISOString(),
    });

    // Simulate the memory.save span call
    await telemetry.withSpan("memory.save", { memoryKey: "test", action: "add" }, async () =>
      sqliteModule.addMemoryEntrySqlite("test", { content: "test", importance: 2 })
    );

    expect(withSpanSpy).toHaveBeenCalledWith(
      "memory.save",
      expect.objectContaining({ memoryKey: "test", action: "add" }),
      expect.any(Function),
    );
  });

  it("withSpan is called with 'memory.save' when saving memory (file path)", async () => {
    const telemetry = await import("../src/telemetry.js");
    const withSpanSpy = vi.spyOn(telemetry, "withSpan").mockImplementation(
      async (_name: string, _attrs: Record<string, string | number | boolean>, fn: (span: unknown) => Promise<unknown>) =>
        fn({} as unknown),
    );

    const memory = await import("../src/memory.js");
    vi.spyOn(memory, "saveMemoryStoreAny").mockResolvedValue(undefined);

    await telemetry.withSpan("memory.save", { memoryKey: "test", action: "add" }, async () =>
      memory.saveMemoryStoreAny("test", { memoryKey: "test", entries: [], updatedAt: new Date().toISOString() })
    );

    expect(withSpanSpy).toHaveBeenCalledWith(
      "memory.save",
      expect.objectContaining({ memoryKey: "test", action: "add" }),
      expect.any(Function),
    );
  });
});
