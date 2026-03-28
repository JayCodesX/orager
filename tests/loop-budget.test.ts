/**
 * Unit tests for computeToolBudgetTimeout — the per-tool deadline function
 * extracted from runAgentLoop to enable isolated testing.
 */
import { describe, it, expect } from "vitest";
import { computeToolBudgetTimeout } from "../src/loop.js";

describe("computeToolBudgetTimeout — no timeoutSec", () => {
  it("returns undefined when timeoutSec is not set and no explicit toolTimeout", () => {
    const result = computeToolBudgetTimeout({
      toolName: "bash",
      toolTimeouts: undefined,
      timeoutSec: undefined,
      elapsedMs: 0,
    });
    expect(result).toBeUndefined();
  });

  it("returns the explicit toolTimeout unchanged when no run-level timeoutSec", () => {
    const result = computeToolBudgetTimeout({
      toolName: "bash",
      toolTimeouts: { bash: 30_000 },
      timeoutSec: undefined,
      elapsedMs: 0,
    });
    expect(result).toBe(30_000);
  });

  it("returns undefined for a tool not in toolTimeouts when no timeoutSec", () => {
    const result = computeToolBudgetTimeout({
      toolName: "web_fetch",
      toolTimeouts: { bash: 30_000 },
      timeoutSec: undefined,
      elapsedMs: 0,
    });
    expect(result).toBeUndefined();
  });
});

// ── T7: budget-derived timeout when no explicit toolTimeout ───────────────────

describe("computeToolBudgetTimeout — T7: budget-derived timeout (no explicit toolTimeouts)", () => {
  it("returns 80% of remaining budget when timeoutSec is set and no explicit entry", () => {
    // 100s run, 0s elapsed → remaining = 100_000ms → budgetCap = floor(100000 * 0.8) = 80_000
    const result = computeToolBudgetTimeout({
      toolName: "bash",
      toolTimeouts: undefined,
      timeoutSec: 100,
      elapsedMs: 0,
    });
    expect(result).toBe(80_000);
  });

  it("accounts for elapsed time in the remaining budget calculation", () => {
    // 100s run, 50s elapsed → remaining = 50_000ms → budgetCap = floor(50000 * 0.8) = 40_000
    const result = computeToolBudgetTimeout({
      toolName: "bash",
      toolTimeouts: undefined,
      timeoutSec: 100,
      elapsedMs: 50_000,
    });
    expect(result).toBe(40_000);
  });

  it("enforces minimum of 5s even with very small remaining budget", () => {
    // 10s run, 9.9s elapsed → remaining = 100ms → 80% = 80ms — but min is 5_000
    const result = computeToolBudgetTimeout({
      toolName: "bash",
      toolTimeouts: undefined,
      timeoutSec: 10,
      elapsedMs: 9_900,
    });
    expect(result).toBe(5_000);
  });

  it("enforces maximum of 5 minutes (300_000ms) per tool from the budget", () => {
    // 1 hour run, 0 elapsed → 80% of 3_600_000 = 2_880_000 — but capped at 300_000
    const result = computeToolBudgetTimeout({
      toolName: "bash",
      toolTimeouts: undefined,
      timeoutSec: 3_600,
      elapsedMs: 0,
    });
    expect(result).toBe(300_000);
  });

  it("returns 1ms (exhaust signal) when budget is already spent", () => {
    // 10s run, 11s elapsed → remaining < 0 → returns 1
    const result = computeToolBudgetTimeout({
      toolName: "bash",
      toolTimeouts: undefined,
      timeoutSec: 10,
      elapsedMs: 11_000,
    });
    expect(result).toBe(1);
  });
});

// ── T8: explicit toolTimeout is capped at remaining budget ────────────────────

describe("computeToolBudgetTimeout — T8: explicit toolTimeout capped at remaining budget", () => {
  it("uses explicit timeout when it is less than the budget cap", () => {
    // 100s run, 0s elapsed → budgetCap = 80_000ms
    // Explicit: 20_000ms (less than budget cap) → returns 20_000
    const result = computeToolBudgetTimeout({
      toolName: "bash",
      toolTimeouts: { bash: 20_000 },
      timeoutSec: 100,
      elapsedMs: 0,
    });
    expect(result).toBe(20_000);
  });

  it("caps explicit timeout at budgetCap when explicit > budget", () => {
    // 60s run, 50s elapsed → remaining = 10_000ms → budgetCap = 8_000ms
    // Explicit: 30_000ms (far exceeds budget cap) → returns 8_000 (the cap)
    const result = computeToolBudgetTimeout({
      toolName: "bash",
      toolTimeouts: { bash: 30_000 },
      timeoutSec: 60,
      elapsedMs: 50_000,
    });
    expect(result).toBe(8_000);
  });

  it("caps at minimum 5_000 even when explicit < 5_000 would have been chosen by budget", () => {
    // 10s run, 9.9s elapsed → remaining = 100ms → budgetCap = 5_000 (minimum)
    // Explicit: 1_000ms (under budgetCap of 5_000, but budget says 5_000)
    // min(1_000, 5_000) = 1_000
    const result = computeToolBudgetTimeout({
      toolName: "bash",
      toolTimeouts: { bash: 1_000 },
      timeoutSec: 10,
      elapsedMs: 9_900,
    });
    expect(result).toBe(1_000); // explicit wins because it's lower than the min-enforced budgetCap
  });

  it("different tools get independent timeouts from the budget", () => {
    const timeoutSec = 100;
    const elapsedMs = 0;

    const bashTimeout = computeToolBudgetTimeout({
      toolName: "bash",
      toolTimeouts: { bash: 10_000, web_fetch: 20_000 },
      timeoutSec,
      elapsedMs,
    });
    const fetchTimeout = computeToolBudgetTimeout({
      toolName: "web_fetch",
      toolTimeouts: { bash: 10_000, web_fetch: 20_000 },
      timeoutSec,
      elapsedMs,
    });

    expect(bashTimeout).toBe(10_000);  // explicit < budgetCap (80_000)
    expect(fetchTimeout).toBe(20_000); // explicit < budgetCap (80_000)
  });
});

describe("computeToolBudgetTimeout — startMs/nowMs alternative (A3)", () => {
  it("accepts startMs + nowMs instead of elapsedMs", () => {
    // startMs=0, nowMs=50_000 → elapsedMs=50_000; 100s run → remaining=50s → 80%=40_000
    const result = computeToolBudgetTimeout({
      toolName: "bash",
      timeoutSec: 100,
      startMs: 0,
      nowMs: 50_000,
    });
    expect(result).toBe(40_000);
  });

  it("elapsedMs takes precedence over startMs when both are provided", () => {
    // elapsedMs=0, but startMs=0/nowMs=50_000 would give 40_000 — elapsedMs=0 wins → 80_000
    const result = computeToolBudgetTimeout({
      toolName: "bash",
      timeoutSec: 100,
      elapsedMs: 0,
      startMs: 0,
      nowMs: 50_000,
    });
    expect(result).toBe(80_000);
  });
});
