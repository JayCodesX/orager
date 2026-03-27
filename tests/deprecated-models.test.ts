import { describe, it, expect } from "vitest";
import { checkDeprecatedModel } from "../src/deprecated-models.js";

describe("checkDeprecatedModel", () => {
  it("detects gpt-3.5-turbo as deprecated", () => {
    const result = checkDeprecatedModel("openai/gpt-3.5-turbo");
    expect(result).not.toBeNull();
    expect(result!.replacement).toContain("gpt-4o-mini");
  });

  it("detects claude-2 as deprecated", () => {
    const result = checkDeprecatedModel("anthropic/claude-2");
    expect(result).not.toBeNull();
    expect(result!.replacement).toContain("haiku");
  });

  it("does not flag current models", () => {
    expect(checkDeprecatedModel("anthropic/claude-3-5-sonnet")).toBeNull();
    expect(checkDeprecatedModel("openai/gpt-4o")).toBeNull();
    expect(checkDeprecatedModel("google/gemini-2.0-flash")).toBeNull();
  });

  it("does not flag gpt-3.5-turbo-instruct (exempt)", () => {
    expect(checkDeprecatedModel("openai/gpt-3.5-turbo-instruct")).toBeNull();
  });
});
