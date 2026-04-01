/**
 * Tests for parseMemoryUpdates() and MEMORY_UPDATE_INSTRUCTION — Phase 4.
 */
import { describe, it, expect } from "vitest";
import {
  parseMemoryUpdates,
  MEMORY_UPDATE_INSTRUCTION,
  MEMORY_UPDATE_MAX_CHARS,
} from "../src/loop-helpers.js";

describe("parseMemoryUpdates", () => {
  it("returns empty array when no blocks are present", () => {
    expect(parseMemoryUpdates("Hello, no memory updates here.")).toEqual([]);
  });

  it("parses a single valid block", () => {
    const text = `Done.\n<memory_update>\n{"content":"User prefers TypeScript strict mode","importance":3,"tags":["typescript"]}\n</memory_update>`;
    const result = parseMemoryUpdates(text);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("User prefers TypeScript strict mode");
    expect(result[0].importance).toBe(3);
    expect(result[0].tags).toEqual(["typescript"]);
  });

  it("parses multiple blocks in a single response", () => {
    const text = [
      "Finished.",
      `<memory_update>{"content":"Uses PostgreSQL 15","importance":2,"tags":["db"]}</memory_update>`,
      `<memory_update>{"content":"Prefers camelCase","importance":1,"tags":["style"]}</memory_update>`,
    ].join("\n");
    const result = parseMemoryUpdates(text);
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe("Uses PostgreSQL 15");
    expect(result[1].content).toBe("Prefers camelCase");
  });

  it("skips blocks with invalid JSON", () => {
    const text = `<memory_update>{not valid json}</memory_update>`;
    expect(parseMemoryUpdates(text)).toEqual([]);
  });

  it("skips blocks with empty content string", () => {
    const text = `<memory_update>{"content":"  ","importance":2,"tags":[]}</memory_update>`;
    expect(parseMemoryUpdates(text)).toEqual([]);
  });

  it("skips blocks missing the content field", () => {
    const text = `<memory_update>{"importance":2,"tags":["foo"]}</memory_update>`;
    expect(parseMemoryUpdates(text)).toEqual([]);
  });

  it("defaults importance to 2 when not a valid value", () => {
    const text = `<memory_update>{"content":"Some fact","importance":99}</memory_update>`;
    const [upd] = parseMemoryUpdates(text);
    expect(upd.importance).toBe(2);
  });

  it("defaults importance to 2 when importance is absent", () => {
    const text = `<memory_update>{"content":"Some fact"}</memory_update>`;
    const [upd] = parseMemoryUpdates(text);
    expect(upd.importance).toBe(2);
  });

  it("defaults tags to empty array when absent", () => {
    const text = `<memory_update>{"content":"Some fact","importance":1}</memory_update>`;
    const [upd] = parseMemoryUpdates(text);
    expect(upd.tags).toEqual([]);
  });

  it("coerces non-string tags to strings", () => {
    const text = `<memory_update>{"content":"Fact","tags":[1,true,"hello"]}</memory_update>`;
    const [upd] = parseMemoryUpdates(text);
    expect(upd.tags).toEqual(["1", "true", "hello"]);
  });

  it("limits tags to 10 items", () => {
    const tags = Array.from({ length: 15 }, (_, i) => `tag${i}`);
    const text = `<memory_update>{"content":"Fact","tags":${JSON.stringify(tags)}}</memory_update>`;
    const [upd] = parseMemoryUpdates(text);
    expect(upd.tags).toHaveLength(10);
  });

  it(`truncates content to ${MEMORY_UPDATE_MAX_CHARS} chars`, () => {
    const longContent = "x".repeat(MEMORY_UPDATE_MAX_CHARS + 100);
    const text = `<memory_update>{"content":"${longContent}"}</memory_update>`;
    const [upd] = parseMemoryUpdates(text);
    expect(upd.content.length).toBe(MEMORY_UPDATE_MAX_CHARS);
  });

  it("trims leading/trailing whitespace from content", () => {
    const text = `<memory_update>{"content":"  trimmed  "}</memory_update>`;
    const [upd] = parseMemoryUpdates(text);
    expect(upd.content).toBe("trimmed");
  });

  it("handles multi-line JSON inside the block", () => {
    const text = `<memory_update>\n{\n  "content": "Multi-line",\n  "importance": 3,\n  "tags": ["a","b"]\n}\n</memory_update>`;
    const [upd] = parseMemoryUpdates(text);
    expect(upd.content).toBe("Multi-line");
    expect(upd.importance).toBe(3);
    expect(upd.tags).toEqual(["a", "b"]);
  });

  it("ignores content between blocks (only extracts blocks)", () => {
    const text = `Some text <memory_update>{"content":"Fact A"}</memory_update> more text <memory_update>{"content":"Fact B"}</memory_update> end`;
    const result = parseMemoryUpdates(text);
    expect(result).toHaveLength(2);
    expect(result.map((u) => u.content)).toEqual(["Fact A", "Fact B"]);
  });
});

describe("MEMORY_UPDATE_INSTRUCTION", () => {
  it("is a non-empty string", () => {
    expect(typeof MEMORY_UPDATE_INSTRUCTION).toBe("string");
    expect(MEMORY_UPDATE_INSTRUCTION.length).toBeGreaterThan(50);
  });

  it("contains the memory_update tag name", () => {
    expect(MEMORY_UPDATE_INSTRUCTION).toContain("<memory_update>");
  });

  it("describes importance levels", () => {
    expect(MEMORY_UPDATE_INSTRUCTION).toContain("importance");
    expect(MEMORY_UPDATE_INSTRUCTION).toContain("1");
    expect(MEMORY_UPDATE_INSTRUCTION).toContain("3");
  });
});
