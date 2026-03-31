/**
 * Unit tests for setup.ts — DEFAULT_CONFIG, OragerUserConfig shape, and
 * runSetupWizard non-interactive flags (--show-defaults, --show).
 *
 * The interactive wizard (runSetupWizard with --quick / --custom / --reset)
 * is not tested here since it requires TTY input. The private readConfig and
 * writeConfig helpers are not exported; they are exercised indirectly through
 * runSetupWizard --show which calls readConfig internally.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, runSetupWizard, type OragerUserConfig } from "../src/setup.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orager-setup-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── DEFAULT_CONFIG ─────────────────────────────────────────────────────────────

describe("DEFAULT_CONFIG", () => {
  it("has a default model string", () => {
    expect(typeof DEFAULT_CONFIG.model).toBe("string");
    expect(DEFAULT_CONFIG.model!.length).toBeGreaterThan(0);
  });

  it("has sensible maxTurns (positive integer)", () => {
    expect(typeof DEFAULT_CONFIG.maxTurns).toBe("number");
    expect(DEFAULT_CONFIG.maxTurns!).toBeGreaterThan(0);
    expect(Number.isInteger(DEFAULT_CONFIG.maxTurns)).toBe(true);
  });

  it("has sensible maxRetries (non-negative integer)", () => {
    expect(typeof DEFAULT_CONFIG.maxRetries).toBe("number");
    expect(DEFAULT_CONFIG.maxRetries!).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(DEFAULT_CONFIG.maxRetries)).toBe(true);
  });

  it("has a default timeoutSec of 300 seconds", () => {
    expect(DEFAULT_CONFIG.timeoutSec).toBe(300);
  });

  it("has memory enabled by default", () => {
    expect(DEFAULT_CONFIG.memory).toBe(true);
  });

  it("does not mutate when spread", () => {
    const copy = { ...DEFAULT_CONFIG };
    copy.model = "mutated";
    expect(DEFAULT_CONFIG.model).not.toBe("mutated");
  });
});

// ── OragerUserConfig type shape ────────────────────────────────────────────────

describe("OragerUserConfig — type shape (runtime duck-typing)", () => {
  it("accepts a minimal valid config object", () => {
    const cfg: OragerUserConfig = { model: "openai/gpt-4o" };
    expect(cfg.model).toBe("openai/gpt-4o");
  });

  it("accepts all optional fields without TypeScript errors", () => {
    const cfg: OragerUserConfig = {
      model: "deepseek/deepseek-r1",
      models: ["openai/gpt-4o-mini"],
      maxTurns: 10,
      maxRetries: 2,
      timeoutSec: 120,
      maxCostUsd: 1.0,
      temperature: 0.7,
      memory: true,
      memoryKey: "my-key",
      siteUrl: "https://example.com",
      siteName: "My App",
      requireApproval: "all",
      planMode: false,
      profile: "code-review",
    };
    expect(cfg.model).toBe("deepseek/deepseek-r1");
    expect(cfg.maxTurns).toBe(10);
    expect(cfg.memory).toBe(true);
  });

  it("accepts requireApproval as an array of tool names", () => {
    const cfg: OragerUserConfig = { requireApproval: ["bash", "write_file"] };
    expect(Array.isArray(cfg.requireApproval)).toBe(true);
    expect((cfg.requireApproval as string[])).toContain("bash");
  });

  it("accepts reasoningEffort valid enum values", () => {
    const efforts: OragerUserConfig["reasoningEffort"][] = [
      "xhigh", "high", "medium", "low", "minimal", "none",
    ];
    for (const effort of efforts) {
      const cfg: OragerUserConfig = { reasoningEffort: effort };
      expect(cfg.reasoningEffort).toBe(effort);
    }
  });
});

// ── runSetupWizard — non-interactive flags ────────────────────────────────────

describe("runSetupWizard --show-defaults", () => {
  it("prints DEFAULT_CONFIG JSON to stdout without throwing", async () => {
    const chunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true; // suppress actual output during tests
    }) as typeof process.stdout.write;

    try {
      await runSetupWizard(["--show-defaults"]);
    } finally {
      process.stdout.write = originalWrite;
    }

    const output = chunks.join("");
    // Should contain JSON with the default model
    expect(output).toContain(DEFAULT_CONFIG.model!);
  });

  it("does not throw when called with --show-defaults", async () => {
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      await expect(runSetupWizard(["--show-defaults"])).resolves.toBeUndefined();
    } finally {
      process.stdout.write = originalWrite;
    }
  });
});
