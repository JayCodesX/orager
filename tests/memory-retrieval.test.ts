import { describe, it, expect } from "vitest";
import {
  buildQuery,
  scoreEntry,
  retrieveEntries,
  renderRetrievedBlock,
  cosineSimilarity,
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

// ── buildQuery ────────────────────────────────────────────────────────────────

describe("buildQuery", () => {
  it("filters stop words", () => {
    const tokens = buildQuery("the quick brown fox");
    expect(tokens).not.toContain("the");
    expect(tokens).toContain("quick");
    expect(tokens).toContain("brown");
    expect(tokens).toContain("fox");
  });

  it("lowercases tokens", () => {
    const tokens = buildQuery("HELLO World");
    expect(tokens).toContain("hello");
    expect(tokens).toContain("world");
    expect(tokens).not.toContain("HELLO");
    expect(tokens).not.toContain("World");
  });

  it("deduplicates tokens", () => {
    const tokens = buildQuery("hello hello hello");
    expect(tokens.filter((t) => t === "hello").length).toBe(1);
  });

  it("filters tokens with length < 3", () => {
    const tokens = buildQuery("go do it");
    // "go" and "it" are short (2 chars or stop words); none should appear
    for (const tok of tokens) {
      expect(tok.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("splits on punctuation", () => {
    const tokens = buildQuery("hello,world.foo");
    expect(tokens).toContain("hello");
    expect(tokens).toContain("world");
    expect(tokens).toContain("foo");
  });
});

// ── scoreEntry ────────────────────────────────────────────────────────────────

describe("scoreEntry", () => {
  it("higher importance yields higher score for same query", () => {
    const queryTokens = ["authentication", "token"];
    const low = makeEntry({ content: "authentication token", importance: 1 });
    const high = makeEntry({ content: "authentication token", importance: 3 });
    expect(scoreEntry(high, queryTokens)).toBeGreaterThan(scoreEntry(low, queryTokens));
  });

  it("more term overlap yields higher score", () => {
    const queryTokens = ["authentication", "token", "expiry"];
    const partial = makeEntry({ content: "authentication only", importance: 2 });
    const full = makeEntry({
      content: "authentication token expiry",
      importance: 2,
    });
    expect(scoreEntry(full, queryTokens)).toBeGreaterThan(
      scoreEntry(partial, queryTokens),
    );
  });

  it("older entry yields lower score than identical newer entry", () => {
    const queryTokens = ["authentication"];
    const older = makeEntry({
      content: "authentication",
      importance: 2,
      createdAt: new Date(Date.now() - 60 * 86400000).toISOString(), // 60 days ago
    });
    const newer = makeEntry({
      content: "authentication",
      importance: 2,
      createdAt: new Date().toISOString(),
    });
    expect(scoreEntry(newer, queryTokens)).toBeGreaterThan(
      scoreEntry(older, queryTokens),
    );
  });

  it("returns 0 for no term overlap", () => {
    const queryTokens = ["unrelated"];
    const entry = makeEntry({ content: "something completely different", importance: 2 });
    expect(scoreEntry(entry, queryTokens)).toBe(0);
  });
});

// ── retrieveEntries ───────────────────────────────────────────────────────────

describe("retrieveEntries", () => {
  it("returns top matches in score-descending order", () => {
    const entries = [
      makeEntry({ content: "authentication token cache", importance: 2 }),
      makeEntry({ content: "unrelated entry about pizza", importance: 2 }),
      makeEntry({ content: "authentication is important", importance: 2 }),
    ];
    const store = makeStore(entries);
    const results = retrieveEntries(store, "authentication token", { topK: 3 });
    // First result should have more term overlap
    const firstContent = results[0].content;
    expect(firstContent).toContain("authentication");
  });

  it("respects topK limit", () => {
    const entries = Array.from({ length: 20 }, (_, i) =>
      makeEntry({ content: `entry number ${i} with unique content`, importance: 2 }),
    );
    const store = makeStore(entries);
    const results = retrieveEntries(store, "entry number unique content", { topK: 5 });
    expect(results.length).toBeLessThanOrEqual(5);
  });

  it("empty queryTokens falls back to importance+recency sort", () => {
    const now = new Date().toISOString();
    const older = makeEntry({
      content: "old low",
      importance: 1,
      createdAt: new Date(Date.now() - 10 * 86400000).toISOString(),
    });
    const highImportance = makeEntry({
      content: "high importance recent",
      importance: 3,
      createdAt: now,
    });
    const normal = makeEntry({
      content: "normal importance recent",
      importance: 2,
      createdAt: now,
    });
    const store = makeStore([older, normal, highImportance]);
    // Pass a string made of only stop words so queryTokens is empty
    const results = retrieveEntries(store, "the a an is it");
    expect(results[0].importance).toBe(3);
    expect(results[1].importance).toBe(2);
    expect(results[2].importance).toBe(1);
  });

  it("defaults topK to 12 when not specified", () => {
    const entries = Array.from({ length: 20 }, (_, i) =>
      makeEntry({ content: `relevant entry about authentication token ${i}`, importance: 2 }),
    );
    const store = makeStore(entries);
    const results = retrieveEntries(store, "authentication token");
    expect(results.length).toBeLessThanOrEqual(12);
  });
});

// ── renderRetrievedBlock ──────────────────────────────────────────────────────

describe("renderRetrievedBlock", () => {
  it("renumbers entries starting from [1]", () => {
    const entries = [
      makeEntry({ content: "first entry", importance: 2 }),
      makeEntry({ content: "second entry", importance: 2 }),
    ];
    const block = renderRetrievedBlock(entries);
    expect(block).toMatch(/^\[1\]/);
    expect(block).toContain("[2]");
    expect(block).not.toContain("[0]");
  });

  it("respects maxChars truncation", () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      makeEntry({ content: `entry ${i} with some longer content here`, importance: 2 }),
    );
    const block = renderRetrievedBlock(entries, 100);
    expect(block.length).toBeLessThanOrEqual(100);
  });

  it("returns empty string for empty entries", () => {
    expect(renderRetrievedBlock([])).toBe("");
  });

  it("includes entry content in output", () => {
    const entries = [makeEntry({ content: "unique test content abc", importance: 3 })];
    const block = renderRetrievedBlock(entries);
    expect(block).toContain("unique test content abc");
    expect(block).toContain("importance: 3");
  });
});

// ── cosineSimilarity ──────────────────────────────────────────────────────────

describe("cosineSimilarity", () => {
  it("returns 1.0 for identical unit vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1.0);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0);
  });

  it("returns -1 for exactly opposite vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [-1, 0, 0])).toBeCloseTo(-1.0);
  });

  it("returns 0 for empty vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("returns 0 when one vector is all-zeros (zero magnitude)", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
  });

  it("handles vectors of different lengths — trailing elements of the longer vector are ignored", () => {
    // cosineSimilarity uses Math.min(a.length, b.length) for the loop AND for magnitude.
    // [1, 0] vs [1, 0, 99]: only the first 2 elements are considered →
    // dot=1, magA=1, magB=1 → similarity = 1.0 (the trailing 99 is never seen).
    expect(cosineSimilarity([1, 0], [1, 0, 99])).toBeCloseTo(1.0);
    // Orthogonal in the shared prefix → 0 regardless of tail
    expect(cosineSimilarity([0, 1], [1, 0, 99])).toBeCloseTo(0);
  });

  it("returns 1.0 for non-unit but parallel vectors", () => {
    expect(cosineSimilarity([2, 4], [1, 2])).toBeCloseTo(1.0);
  });
});

// ── retrieveEntriesWithEmbeddings ─────────────────────────────────────────────

describe("retrieveEntriesWithEmbeddings", () => {
  const queryEmbedding = [1, 0, 0];

  function embeddedEntry(
    content: string,
    embedding: number[],
    overrides: Partial<MemoryEntry> = {},
  ): MemoryEntry {
    return makeEntry({ content, _embedding: embedding, ...overrides });
  }

  it("returns entries ranked by cosine similarity (highest first)", () => {
    const store = makeStore([
      embeddedEntry("low similarity", [0, 1, 0]),    // sim=0 with [1,0,0]
      embeddedEntry("perfect match",  [1, 0, 0]),    // sim=1
      embeddedEntry("partial match",  [0.9, 0.44, 0]), // high but not perfect
    ]);
    const results = retrieveEntriesWithEmbeddings(store, queryEmbedding);
    expect(results[0].content).toBe("perfect match");
    expect(results[1].content).toBe("partial match");
    expect(results[2].content).toBe("low similarity");
  });

  it("returns empty array when all entries score below minScore", () => {
    const store = makeStore([
      embeddedEntry("neg entry", [-1, 0, 0]),  // sim = -1
      embeddedEntry("ortho entry", [0, 1, 0]), // sim = 0
    ]);
    // minScore=0.5 — neither entry reaches it
    const results = retrieveEntriesWithEmbeddings(store, queryEmbedding, { minScore: 0.5 });
    expect(results).toHaveLength(0);
  });

  it("returns empty array when store has no entries", () => {
    const store = makeStore([]);
    const results = retrieveEntriesWithEmbeddings(store, queryEmbedding);
    expect(results).toHaveLength(0);
  });

  it("respects topK limit", () => {
    const store = makeStore([
      embeddedEntry("a", [1, 0, 0]),
      embeddedEntry("b", [0.9, 0.1, 0]),
      embeddedEntry("c", [0.8, 0.2, 0]),
      embeddedEntry("d", [0.7, 0.3, 0]),
    ]);
    const results = retrieveEntriesWithEmbeddings(store, queryEmbedding, { topK: 2 });
    expect(results).toHaveLength(2);
    expect(results[0].content).toBe("a");
  });

  it("entries without _embedding fall back to importance+recency scoring (scoreEntry)", () => {
    const withEmbed    = embeddedEntry("has embedding",    [1, 0, 0], { importance: 1 });
    const withoutEmbed = makeEntry({ content: "no embedding", importance: 3 }); // high importance
    const store = makeStore([withEmbed, withoutEmbed]);

    // With enough topK both appear; the no-embedding entry's score is
    // importance-based (scoreEntry with empty query) — just verify it is included
    const results = retrieveEntriesWithEmbeddings(store, queryEmbedding, { topK: 10, minScore: 0 });
    const contents = results.map((e) => e.content);
    expect(contents).toContain("has embedding");
    expect(contents).toContain("no embedding");
  });

  it("importance weight amplifies score: importance=3 > importance=1 at equal similarity", () => {
    const low  = embeddedEntry("low importance",  [1, 0, 0], { importance: 1 });
    const high = embeddedEntry("high importance", [1, 0, 0], { importance: 3 });
    const store = makeStore([low, high]);
    const results = retrieveEntriesWithEmbeddings(store, queryEmbedding, { topK: 2 });
    // Both have sim=1.0 with queryEmbedding; high importance (weight 1.5) beats low (weight 0.6)
    expect(results[0].content).toBe("high importance");
  });

  it("defaults topK to 12", () => {
    const entries = Array.from({ length: 20 }, (_, i) =>
      embeddedEntry(`entry ${i}`, [1, 0, 0]),
    );
    const results = retrieveEntriesWithEmbeddings(makeStore(entries), queryEmbedding);
    expect(results).toHaveLength(12);
  });

  it("minScore=0 (default) includes entries with zero-similarity (orthogonal vectors)", () => {
    const store = makeStore([
      embeddedEntry("orthogonal", [0, 1, 0]), // sim=0 with queryEmbedding [1,0,0]
    ]);
    // default minScore is 0.0, so score ≥ 0 passes (0 * importanceWeight * recency = 0 ≥ 0)
    const results = retrieveEntriesWithEmbeddings(store, queryEmbedding);
    expect(results).toHaveLength(1);
  });
});
