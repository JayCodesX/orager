import { describe, it, expect } from "vitest";
import { varyPrompt, makeStuckMessage } from "../src/prompt-variation.js";

describe("varyPrompt", () => {
  it("returns a string containing the original prompt", () => {
    const result = varyPrompt("do the thing", 0);
    expect(result).toContain("do the thing");
  });

  it("adds a hint on top of the original prompt", () => {
    const original = "my task";
    const result = varyPrompt(original, 0);
    expect(result.length).toBeGreaterThan(original.length);
    expect(result).toContain("[Hint:");
  });

  it("cycles through templates: attempt N and N+5 produce identical results", () => {
    const TEMPLATE_COUNT = 5; // must match VARIATION_TEMPLATES.length
    const original = "test prompt";
    for (let i = 0; i < TEMPLATE_COUNT; i++) {
      expect(varyPrompt(original, i)).toBe(varyPrompt(original, i + TEMPLATE_COUNT));
    }
  });

  it("produces different hints for different attempt numbers (within a cycle)", () => {
    const original = "test";
    const hint0 = varyPrompt(original, 0);
    const hint1 = varyPrompt(original, 1);
    expect(hint0).not.toBe(hint1);
  });
});

describe("makeStuckMessage", () => {
  it("includes the streak count", () => {
    const msg = makeStuckMessage(4, 0);
    expect(msg).toContain("4 consecutive turns");
  });

  it("includes a hint from the hints array", () => {
    const msg = makeStuckMessage(1, 0);
    expect(msg).toContain("[System notice]");
    expect(msg.length).toBeGreaterThan(50);
  });

  it("cycles through hints: attempt N and N+5 produce identical results", () => {
    const HINT_COUNT = 5; // must match hints.length in makeStuckMessage
    for (let i = 0; i < HINT_COUNT; i++) {
      expect(makeStuckMessage(3, i)).toBe(makeStuckMessage(3, i + HINT_COUNT));
    }
  });

  it("produces different hints for different attempt numbers (within a cycle)", () => {
    const msg0 = makeStuckMessage(3, 0);
    const msg1 = makeStuckMessage(3, 1);
    expect(msg0).not.toBe(msg1);
  });
});
