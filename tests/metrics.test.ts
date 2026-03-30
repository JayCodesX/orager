/**
 * Tests for src/metrics.ts — 6 named OTel instruments.
 *
 * The @opentelemetry/api metrics are no-ops when no MeterProvider is registered,
 * so we test the public API contract (no throws, correct argument types) rather
 * than asserting on exported values.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  recordTokens,
  recordToolCall,
  recordSession,
  _resetInstrumentsForTesting,
} from "../src/metrics.js";

beforeEach(() => {
  // Reset lazy instrument cache between tests so each test gets fresh handles.
  _resetInstrumentsForTesting();
});

describe("recordTokens", () => {
  it("accepts positive token counts and a model string without throwing", () => {
    expect(() => recordTokens(1000, 200, "openai/gpt-4o")).not.toThrow();
  });

  it("accepts zero token counts", () => {
    expect(() => recordTokens(0, 0, "anthropic/claude-3-haiku")).not.toThrow();
  });

  it("can be called multiple times for the same model", () => {
    expect(() => {
      recordTokens(500, 100, "deepseek/deepseek-chat-v3-2");
      recordTokens(700, 150, "deepseek/deepseek-chat-v3-2");
    }).not.toThrow();
  });

  it("accepts different model names independently", () => {
    expect(() => {
      recordTokens(100, 20, "openai/gpt-4o");
      recordTokens(200, 50, "anthropic/claude-3-5-sonnet");
      recordTokens(300, 80, "google/gemini-2.0-flash");
    }).not.toThrow();
  });
});

describe("recordToolCall", () => {
  it("records a successful tool call without throwing", () => {
    expect(() => recordToolCall("bash", false)).not.toThrow();
  });

  it("records a failed tool call without throwing", () => {
    expect(() => recordToolCall("write_file", true)).not.toThrow();
  });

  it("handles common tool names", () => {
    const tools = ["bash", "read_file", "write_file", "edit_file", "glob", "grep", "web_fetch"];
    expect(() => {
      for (const tool of tools) recordToolCall(tool, false);
    }).not.toThrow();
  });

  it("can be called in rapid succession", () => {
    expect(() => {
      for (let i = 0; i < 50; i++) recordToolCall("bash", i % 3 === 0);
    }).not.toThrow();
  });
});

describe("recordSession", () => {
  it("records a successful session without throwing", () => {
    expect(() => recordSession(12_000, 5, "success")).not.toThrow();
  });

  it("records all known result subtypes", () => {
    const subtypes = [
      "success",
      "error_max_turns",
      "error_max_cost",
      "error",
      "error_circuit_open",
      "interrupted",
      "error_cancelled",
      "error_tool_budget",
      "error_loop_abort",
    ];
    expect(() => {
      for (const subtype of subtypes) recordSession(5000, 3, subtype);
    }).not.toThrow();
  });

  it("accepts zero duration and zero turns", () => {
    expect(() => recordSession(0, 0, "success")).not.toThrow();
  });

  it("accepts very large durations", () => {
    // 1 hour session
    expect(() => recordSession(3_600_000, 200, "success")).not.toThrow();
  });
});

describe("instrument lazy initialisation", () => {
  it("initialises instruments on first call and reuses them on subsequent calls", () => {
    // First call creates instruments
    expect(() => recordTokens(100, 20, "openai/gpt-4o")).not.toThrow();
    // Second call uses cached handles — should not throw
    expect(() => recordTokens(200, 40, "openai/gpt-4o")).not.toThrow();
  });

  it("re-initialises cleanly after _resetInstrumentsForTesting()", () => {
    recordTokens(100, 20, "openai/gpt-4o");
    _resetInstrumentsForTesting();
    // Should not throw when re-creating after reset
    expect(() => recordTokens(50, 10, "openai/gpt-4o")).not.toThrow();
  });
});
