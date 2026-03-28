import { describe, it, expect } from "vitest";
import { isModelContextCacheWarm } from "../src/loop-helpers.js";

describe("isModelContextCacheWarm — exported for daemon prewarm guard", () => {
  it("returns a boolean (cache state depends on prior fetchModelContextLengths calls)", () => {
    expect(typeof isModelContextCacheWarm()).toBe("boolean");
  });

  it("returns false when never fetched (initial module state)", () => {
    // In a fresh test module, modelCacheFetchedAt starts at 0
    // so the function should return false
    expect(isModelContextCacheWarm()).toBe(false);
  });
});
