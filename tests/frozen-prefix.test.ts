/**
 * frozen-prefix.test.ts
 *
 * Tests for the two-block system message split introduced in Phase 3 of the
 * hierarchical memory system.  Verifies that applyAnthropicCacheControl
 * correctly handles the frozenSystemPromptLength parameter.
 */
import { describe, it, expect } from "vitest";
import { applyAnthropicCacheControl } from "../src/openrouter.js";
import type { Message } from "../src/types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function sysMsg(content: string): Message {
  return { role: "system", content };
}

function assistantMsg(content: string): Message {
  return { role: "assistant", content };
}

function userMsg(content: string): Message {
  return { role: "user", content };
}

// Use 3+ messages so breakpoint 3 (prior-turn) does not overwrite the system message.
// With [sys, assistant, user], priorIdx = 1 (the assistant message), leaving sys intact.

// ── Two-block split behaviour ─────────────────────────────────────────────────

describe("applyAnthropicCacheControl — frozenSystemPromptLength two-block split", () => {
  const frozenText  = "Frozen base instructions. ";
  const dynamicText = "Dynamic memory suffix.";
  const fullContent = frozenText + dynamicText;
  const model = "anthropic/claude-3-5-sonnet";
  // 3-message array so the prior-turn breakpoint hits the assistant message, not system
  const messages: Message[] = [sysMsg(fullContent), assistantMsg("previous turn"), userMsg("hello")];

  it("splits system message into two blocks when frozenSystemPromptLength is valid", () => {
    const { messages: out } = applyAnthropicCacheControl(
      model,
      messages,
      undefined,
      frozenText.length,
    );

    const sysContent = out[0].content as unknown as Array<{
      type: string;
      text: string;
      cache_control?: { type: string };
    }>;

    expect(Array.isArray(sysContent)).toBe(true);
    expect(sysContent).toHaveLength(2);

    // Block 0: frozen prefix with cache_control
    expect(sysContent[0].text).toBe(frozenText);
    expect(sysContent[0].cache_control).toEqual({ type: "ephemeral" });

    // Block 1: dynamic suffix without cache_control
    expect(sysContent[1].text).toBe(dynamicText);
    expect(sysContent[1].cache_control).toBeUndefined();
  });

  it("falls back to single-block when frozenSystemPromptLength >= content length", () => {
    const { messages: out } = applyAnthropicCacheControl(
      model,
      messages,
      undefined,
      fullContent.length, // exactly equal → no split
    );

    const sysContent = out[0].content as unknown as Array<{
      type: string;
      text: string;
      cache_control?: { type: string };
    }>;

    // Single-block behaviour: withCacheControl wraps the string in a 1-element array
    expect(Array.isArray(sysContent)).toBe(true);
    expect(sysContent).toHaveLength(1);
    expect(sysContent[0].text).toBe(fullContent);
    expect(sysContent[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("falls back to single-block when frozenSystemPromptLength is 0", () => {
    const { messages: out } = applyAnthropicCacheControl(
      model,
      messages,
      undefined,
      0,
    );

    const sysContent = out[0].content as unknown as Array<{
      type: string;
      text: string;
      cache_control?: { type: string };
    }>;

    expect(Array.isArray(sysContent)).toBe(true);
    expect(sysContent).toHaveLength(1);
    expect(sysContent[0].text).toBe(fullContent);
    expect(sysContent[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("falls back to single-block when frozenSystemPromptLength is undefined", () => {
    const { messages: out } = applyAnthropicCacheControl(
      model,
      messages,
      undefined,
      undefined,
    );

    const sysContent = out[0].content as unknown as Array<{
      type: string;
      text: string;
      cache_control?: { type: string };
    }>;

    expect(Array.isArray(sysContent)).toBe(true);
    expect(sysContent).toHaveLength(1);
    expect(sysContent[0].text).toBe(fullContent);
    expect(sysContent[0].cache_control).toEqual({ type: "ephemeral" });
  });
});

// ── Non-Anthropic models are unaffected ──────────────────────────────────────

describe("applyAnthropicCacheControl — non-Anthropic models", () => {
  it("returns messages unchanged for openai/* models", () => {
    const messages: Message[] = [sysMsg("frozen part" + "dynamic part"), userMsg("hi")];
    const { messages: out } = applyAnthropicCacheControl(
      "openai/gpt-4o",
      messages,
      undefined,
      11, // "frozen part".length
    );

    // Non-Anthropic: messages returned as-is (string content, no split)
    expect(out[0].content).toBe("frozen partdynamic part");
  });

  it("returns messages unchanged for deepseek/* models", () => {
    const messages: Message[] = [sysMsg("system content"), userMsg("hi")];
    const { messages: out } = applyAnthropicCacheControl(
      "deepseek/deepseek-chat-v3-2",
      messages,
      undefined,
      6,
    );

    expect(out[0].content).toBe("system content");
  });
});

// ── Header constants ──────────────────────────────────────────────────────────

describe("memory section header constants", () => {
  it("MEMORY_HEADER_MASTER matches expected value", async () => {
    const { MEMORY_HEADER_MASTER } = await import("../src/loop-helpers.js");
    expect(MEMORY_HEADER_MASTER).toBe("## Persistent Product Context");
  });

  it("MEMORY_HEADER_RETRIEVED matches expected value", async () => {
    const { MEMORY_HEADER_RETRIEVED } = await import("../src/loop-helpers.js");
    expect(MEMORY_HEADER_RETRIEVED).toBe("## Your persistent memory");
  });

  it("MEMORY_HEADER_AUTO matches expected value", async () => {
    const { MEMORY_HEADER_AUTO } = await import("../src/loop-helpers.js");
    expect(MEMORY_HEADER_AUTO).toBe("# Persistent memory");
  });
});
