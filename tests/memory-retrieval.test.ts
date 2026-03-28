import { describe, it, expect } from "vitest";
import {
  buildQuery,
  scoreEntry,
  retrieveEntries,
  renderRetrievedBlock,
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
