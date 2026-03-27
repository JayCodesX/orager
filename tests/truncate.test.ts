import { describe, it, expect } from "vitest";
import { truncateContent } from "../src/truncate.js";

describe("truncateContent", () => {
  it("returns content unchanged when within limit", () => {
    const s = "hello world";
    expect(truncateContent(s, 100)).toBe(s);
  });

  it("truncates plain text at last newline", () => {
    const content = "line one\nline two\nline three";
    const result = truncateContent(content, 20);
    expect(result).toContain("line one\nline two");
    expect(result).toContain("[truncated");
  });

  it("truncates JSON arrays to fewer elements", () => {
    const arr = Array.from({ length: 100 }, (_, i) => ({ id: i, value: "test" }));
    const content = JSON.stringify(arr);
    const result = truncateContent(content, 200);
    expect(result).toContain("[truncated");
    const parsed = JSON.parse(result.split("\n[truncated")[0]);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeLessThan(100);
  });

  it("truncates JSON object string values", () => {
    const obj = { key: "a".repeat(1000), other: "short" };
    const content = JSON.stringify(obj);
    const result = truncateContent(content, 300);
    expect(result).toContain("[truncated");
    // Should still be parseable JSON
    const jsonPart = result.split("\n[truncated")[0];
    expect(() => JSON.parse(jsonPart)).not.toThrow();
  });

  it("falls back to raw slice for malformed JSON", () => {
    const content = "{not valid json" + "x".repeat(200);
    const result = truncateContent(content, 50);
    expect(result.length).toBeLessThanOrEqual(50 + 100); // allow for notice
    expect(result).toContain("[truncated");
  });
});
