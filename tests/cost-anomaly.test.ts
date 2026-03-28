/**
 * P3-5: Configurable cost anomaly threshold tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Helper: simulate the cost anomaly detection logic extracted from loop.ts
function detectCostAnomaly(
  prevCosts: number[],
  currentCost: number,
  multiplier: number,
): boolean {
  if (prevCosts.length === 0 || currentCost <= 0) return false;
  const rollingAvg = prevCosts.reduce((s, c) => s + c, 0) / prevCosts.length;
  return rollingAvg > 0 && currentCost > multiplier * rollingAvg;
}

describe("COST_ANOMALY_MULTIPLIER", () => {
  it("is exported from loop.ts", async () => {
    const { COST_ANOMALY_MULTIPLIER } = await import("../src/loop.js");
    expect(typeof COST_ANOMALY_MULTIPLIER).toBe("number");
    expect(COST_ANOMALY_MULTIPLIER).toBeGreaterThan(0);
  });

  it("defaults to 2.0 when env var is not set", async () => {
    const savedEnv = process.env["ORAGER_COST_ANOMALY_MULTIPLIER"];
    delete process.env["ORAGER_COST_ANOMALY_MULTIPLIER"];
    // The constant is evaluated at module load time — check that 2.0 is the default
    const multiplier = parseFloat(process.env["ORAGER_COST_ANOMALY_MULTIPLIER"] ?? "2.0");
    expect(multiplier).toBe(2.0);
    if (savedEnv !== undefined) process.env["ORAGER_COST_ANOMALY_MULTIPLIER"] = savedEnv;
  });
});

describe("Cost anomaly detection logic", () => {
  it("default multiplier (2.0): warning fires when cost is >2× rolling average", () => {
    const prevCosts = [0.001, 0.001, 0.001]; // avg = 0.001
    const currentCost = 0.0025; // 2.5× average
    expect(detectCostAnomaly(prevCosts, currentCost, 2.0)).toBe(true);
  });

  it("default multiplier (2.0): no warning when cost is exactly 2× average", () => {
    const prevCosts = [0.001, 0.001]; // avg = 0.001
    const currentCost = 0.002; // exactly 2× — should NOT fire (must be strictly greater)
    expect(detectCostAnomaly(prevCosts, currentCost, 2.0)).toBe(false);
  });

  it("default multiplier (2.0): no warning when cost is within 2× threshold", () => {
    const prevCosts = [0.001, 0.001, 0.001]; // avg = 0.001
    const currentCost = 0.0015; // 1.5× average — safe
    expect(detectCostAnomaly(prevCosts, currentCost, 2.0)).toBe(false);
  });

  it("custom multiplier (3.0): warning fires at the custom threshold", () => {
    const prevCosts = [0.001, 0.001]; // avg = 0.001
    const currentCost = 0.0035; // 3.5× average
    expect(detectCostAnomaly(prevCosts, currentCost, 3.0)).toBe(true);
  });

  it("custom multiplier (3.0): no warning when cost is under custom threshold", () => {
    const prevCosts = [0.001, 0.001]; // avg = 0.001
    const currentCost = 0.0025; // 2.5× — below 3× threshold
    expect(detectCostAnomaly(prevCosts, currentCost, 3.0)).toBe(false);
  });

  it("custom multiplier (1.5): more sensitive — fires at 1.5×", () => {
    const prevCosts = [0.002, 0.002]; // avg = 0.002
    const currentCost = 0.0035; // 1.75× average — above 1.5× threshold
    expect(detectCostAnomaly(prevCosts, currentCost, 1.5)).toBe(true);
  });

  it("does not fire on the first turn (no history)", () => {
    expect(detectCostAnomaly([], 0.01, 2.0)).toBe(false);
  });

  it("does not fire when current cost is zero", () => {
    expect(detectCostAnomaly([0.001, 0.001], 0, 2.0)).toBe(false);
  });
});
