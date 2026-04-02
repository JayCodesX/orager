import { describe, it, expect, vi, beforeEach } from "vitest";
import { mocked } from "./mock-helpers.js";
import {
  cosineSimilarity,
  embedEntryIfNeeded,
  retrieveEntriesWithEmbeddings,
} from "../src/memory.js";
import type { MemoryEntry, MemoryStore } from "../src/memory.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEntry(
  overrides: Partial<MemoryEntry> & { content: string },
): MemoryEntry {
  return {
    id: crypto.randomUUID(),
    importance: 2,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeStore(entries: MemoryEntry[]): MemoryStore {
  return {
    memoryKey: "test",
    entries,
    updatedAt: new Date().toISOString(),
  };
}

// ── cosineSimilarity ──────────────────────────────────────────────────────────

describe("cosineSimilarity", () => {
  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });

  it("returns 1 for same-direction vectors (scaled)", () => {
    expect(cosineSimilarity([2, 4, 6], [1, 2, 3])).toBeCloseTo(1);
  });

  it("returns 0 for empty vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("returns 0 if either vector is zero-length (empty)", () => {
    expect(cosineSimilarity([1, 2, 3], [])).toBe(0);
    expect(cosineSimilarity([], [1, 2, 3])).toBe(0);
  });

  it("computes known value correctly", () => {
    // [1,0] and [1,1]/sqrt(2) → cosine = 1/sqrt(2) ≈ 0.7071
    const result = cosineSimilarity([1, 0], [1, 1]);
    expect(result).toBeCloseTo(1 / Math.sqrt(2), 4);
  });
});

// ── embedEntryIfNeeded ────────────────────────────────────────────────────────

describe("embedEntryIfNeeded", () => {
  it("returns a new entry without mutating the original", () => {
    const original = makeEntry({ content: "test fact" });
    const embedding = [0.1, 0.2, 0.3];
    const model = "openai/text-embedding-3-small";

    const result = embedEntryIfNeeded(original, embedding, model);

    // Original unchanged
    expect(original._embedding).toBeUndefined();
    expect(original._embeddingModel).toBeUndefined();

    // Result has fields set
    expect(result._embedding).toEqual(embedding);
    expect(result._embeddingModel).toBe(model);
  });

  it("preserves all other fields", () => {
    const original = makeEntry({ content: "keep me", importance: 3, tags: ["auth"] });
    const result = embedEntryIfNeeded(original, [0.5], "model-x");

    expect(result.content).toBe(original.content);
    expect(result.importance).toBe(original.importance);
    expect(result.tags).toEqual(original.tags);
    expect(result.id).toBe(original.id);
    expect(result.createdAt).toBe(original.createdAt);
  });
});

// ── retrieveEntriesWithEmbeddings ─────────────────────────────────────────────

describe("retrieveEntriesWithEmbeddings", () => {
  it("ranks entries with higher cosine similarity first", () => {
    // queryEmbedding = [1, 0]
    // entryA has embedding [1, 0] (perfect match)
    // entryB has embedding [0, 1] (orthogonal)
    const entryA = makeEntry({ content: "auth tokens expire", _embedding: [1, 0] });
    const entryB = makeEntry({ content: "user prefers dark mode", _embedding: [0, 1] });
    const store = makeStore([entryB, entryA]); // note: B before A

    const results = retrieveEntriesWithEmbeddings(store, [1, 0]);
    expect(results[0].id).toBe(entryA.id);
    expect(results[1].id).toBe(entryB.id);
  });

  it("entries without _embedding still participate via fallback scoring", () => {
    const withEmbedding = makeEntry({
      content: "has embedding",
      importance: 2,
      _embedding: [1, 0],
    });
    const withoutEmbedding = makeEntry({
      content: "no embedding",
      importance: 3, // higher importance
    });
    const store = makeStore([withEmbedding, withoutEmbedding]);

    const results = retrieveEntriesWithEmbeddings(store, [1, 0]);
    // Both entries should appear in results
    const ids = results.map((e) => e.id);
    expect(ids).toContain(withEmbedding.id);
    expect(ids).toContain(withoutEmbedding.id);
  });

  it("respects topK", () => {
    const entries = Array.from({ length: 20 }, (_, i) =>
      makeEntry({ content: `fact ${i}`, _embedding: [Math.random(), Math.random()] }),
    );
    const store = makeStore(entries);

    const results = retrieveEntriesWithEmbeddings(store, [1, 0], { topK: 5 });
    expect(results.length).toBeLessThanOrEqual(5);
  });

  it("filters entries below minScore", () => {
    // Two entries with orthogonal embeddings — cosine similarity will be 0 with queryVec [1,0]
    const entry = makeEntry({ content: "no match", _embedding: [0, 1] });
    const store = makeStore([entry]);

    const results = retrieveEntriesWithEmbeddings(store, [1, 0], { minScore: 0.5 });
    expect(results.length).toBe(0);
  });
});

// ── makeRememberTool with embeddingOpts ───────────────────────────────────────

vi.mock("../src/openrouter.js", () => ({
  callOpenRouter: vi.fn(),
  callDirect: vi.fn(),
  shouldUseDirect: vi.fn().mockReturnValue(false),
  fetchGenerationMeta: vi.fn().mockResolvedValue(null),
  callEmbeddings: vi.fn(),
}));

import { callEmbeddings } from "../src/openrouter.js";
import { makeRememberTool } from "../src/tools/remember.js";
import { loadMemoryStoreAny } from "../src/memory.js";

describe("makeRememberTool with embeddingOpts", () => {
  // Use a unique key per test to avoid in-memory store cache collisions between tests
  let testKey: string;

  beforeEach(async () => {
    testKey = `test-embeddings-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    vi.clearAllMocks();
  });

  it("saves entry with _embedding set on successful callEmbeddings", async () => {
    const mockEmbedding = [0.1, 0.2, 0.3];
    mocked(callEmbeddings).mockResolvedValueOnce([mockEmbedding]);

    const tool = makeRememberTool(testKey, 6000, {
      apiKey: "test-api-key",
      model: "openai/text-embedding-3-small",
    });

    const result = await tool.execute({
      action: "add",
      content: "User prefers TypeScript",
    });

    expect(result.isError).toBe(false);

    // Verify the entry was saved with the embedding
    const store = await loadMemoryStoreAny(testKey);
    expect(store.entries.length).toBe(1);
    // SQLite stores embeddings as Float32 BLOB; compare within float32 precision
    const saved = store.entries[0]._embedding;
    expect(saved).toBeDefined();
    expect(saved!.length).toBe(mockEmbedding.length);
    for (let i = 0; i < mockEmbedding.length; i++) {
      expect(saved![i]).toBeCloseTo(mockEmbedding[i]!, 5);
    }
    expect(store.entries[0]._embeddingModel).toBe("openai/text-embedding-3-small");

    expect(callEmbeddings).toHaveBeenCalledWith(
      "test-api-key",
      "openai/text-embedding-3-small",
      ["User prefers TypeScript"],
    );
  });

  it("saves entry without _embedding when callEmbeddings fails", async () => {
    mocked(callEmbeddings).mockRejectedValueOnce(new Error("API error"));

    const tool = makeRememberTool(testKey, 6000, {
      apiKey: "test-api-key",
      model: "openai/text-embedding-3-small",
    });

    const result = await tool.execute({
      action: "add",
      content: "Codebase uses pnpm for package management",
    });

    // Should still succeed — embedding failure is non-fatal
    expect(result.isError).toBe(false);

    const store = await loadMemoryStoreAny(testKey);
    expect(store.entries.length).toBe(1);
    expect(store.entries[0]._embedding).toBeUndefined();
    expect(store.entries[0].content).toBe("Codebase uses pnpm for package management");
  });
});
