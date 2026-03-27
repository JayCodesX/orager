import { describe, it, expect } from "vitest";
import {
  getModelCapabilities,
  modelSupportsTools,
  modelSupportsVision,
} from "../src/model-capabilities.js";

describe("getModelCapabilities", () => {
  it("GPT-4o supports vision and tools", () => {
    const caps = getModelCapabilities("openai/gpt-4o");
    expect(caps.vision).toBe(true);
    expect(caps.toolUse).toBe(true);
    expect(caps.contextTier).toBe("large");
  });

  it("GPT-4o-mini is detected as o200k family", () => {
    const caps = getModelCapabilities("openai/gpt-4o-mini");
    expect(caps.vision).toBe(true);
    expect(caps.toolUse).toBe(true);
  });

  it("Claude 3.5 supports extended thinking", () => {
    const caps = getModelCapabilities("anthropic/claude-3-5-sonnet");
    expect(caps.extendedThinking).toBe(true);
    expect(caps.vision).toBe(true);
    expect(caps.contextTier).toBe("xlarge");
  });

  it("DeepSeek R1 supports extended thinking", () => {
    const caps = getModelCapabilities("deepseek/deepseek-r1");
    expect(caps.extendedThinking).toBe(true);
    expect(caps.toolUse).toBe(true);
  });

  it("Llama 2 does not support tool use", () => {
    expect(modelSupportsTools("meta-llama/llama-2-70b")).toBe(false);
  });

  it("unknown model returns safe defaults", () => {
    const caps = getModelCapabilities("unknown/model-xyz");
    expect(caps.toolUse).toBe(true); // default true
    expect(caps.vision).toBe(false); // default false
  });

  it("modelSupportsVision returns correct values", () => {
    expect(modelSupportsVision("openai/gpt-4o")).toBe(true);
    expect(modelSupportsVision("openai/gpt-4")).toBe(false);
  });
});
