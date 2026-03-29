/**
 * Tests for loadConfigFile — verifies that ConfigFileSchema fields are
 * correctly parsed from JSON and converted to argv tokens / result fields.
 *
 * Covers:
 *   - B2: agentApiKey, memoryRetrieval, memoryEmbeddingModel
 *   - M1: daemonPort, daemonMaxConcurrent, daemonIdleTimeout
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfigFile } from "../src/index.js";

// ── helpers ───────────────────────────────────────────────────────────────────

async function writeTmpConfig(cfg: Record<string, unknown>): Promise<string> {
  const p = path.join(os.tmpdir(), `.orager-test-cfg-${process.pid}-${Date.now()}.json`);
  await fs.writeFile(p, JSON.stringify(cfg), { mode: 0o600 });
  return p;
}

// ── B2: agentApiKey ───────────────────────────────────────────────────────────

describe("loadConfigFile — agentApiKey (B2)", () => {
  it("parses agentApiKey and returns it in the result", async () => {
    const p = await writeTmpConfig({ agentApiKey: "sk-agent-123" });
    const result = await loadConfigFile(p);
    expect(result.agentApiKey).toBe("sk-agent-123");
  });

  it("trims whitespace from agentApiKey", async () => {
    const p = await writeTmpConfig({ agentApiKey: "  sk-agent-trimmed  " });
    const result = await loadConfigFile(p);
    expect(result.agentApiKey).toBe("sk-agent-trimmed");
  });

  it("omits agentApiKey when value is empty string", async () => {
    const p = await writeTmpConfig({ agentApiKey: "" });
    const result = await loadConfigFile(p);
    expect(result.agentApiKey).toBeUndefined();
  });

  it("omits agentApiKey when value is whitespace only", async () => {
    const p = await writeTmpConfig({ agentApiKey: "   " });
    const result = await loadConfigFile(p);
    expect(result.agentApiKey).toBeUndefined();
  });
});

// ── B2: memoryRetrieval ───────────────────────────────────────────────────────

describe("loadConfigFile — memoryRetrieval (B2)", () => {
  it("parses memoryRetrieval: 'embedding'", async () => {
    const p = await writeTmpConfig({ memoryRetrieval: "embedding" });
    const result = await loadConfigFile(p);
    expect(result.memoryRetrieval).toBe("embedding");
  });

  it("parses memoryRetrieval: 'local'", async () => {
    const p = await writeTmpConfig({ memoryRetrieval: "local" });
    const result = await loadConfigFile(p);
    expect(result.memoryRetrieval).toBe("local");
  });

  it("omits memoryRetrieval when value is an unknown string", async () => {
    const p = await writeTmpConfig({ memoryRetrieval: "fts" });
    const result = await loadConfigFile(p);
    expect(result.memoryRetrieval).toBeUndefined();
  });

  it("omits memoryRetrieval when absent", async () => {
    const p = await writeTmpConfig({});
    const result = await loadConfigFile(p);
    expect(result.memoryRetrieval).toBeUndefined();
  });
});

// ── B2: memoryEmbeddingModel ──────────────────────────────────────────────────

describe("loadConfigFile — memoryEmbeddingModel (B2)", () => {
  it("parses memoryEmbeddingModel", async () => {
    const p = await writeTmpConfig({ memoryEmbeddingModel: "openai/text-embedding-3-small" });
    const result = await loadConfigFile(p);
    expect(result.memoryEmbeddingModel).toBe("openai/text-embedding-3-small");
  });

  it("trims whitespace from memoryEmbeddingModel", async () => {
    const p = await writeTmpConfig({ memoryEmbeddingModel: "  openai/text-embedding-3-small  " });
    const result = await loadConfigFile(p);
    expect(result.memoryEmbeddingModel).toBe("openai/text-embedding-3-small");
  });

  it("omits memoryEmbeddingModel when value is empty string", async () => {
    const p = await writeTmpConfig({ memoryEmbeddingModel: "" });
    const result = await loadConfigFile(p);
    expect(result.memoryEmbeddingModel).toBeUndefined();
  });

  it("all three B2 fields survive a round-trip together", async () => {
    const p = await writeTmpConfig({
      agentApiKey: "sk-agent-xyz",
      memoryRetrieval: "embedding",
      memoryEmbeddingModel: "openai/text-embedding-3-small",
    });
    const result = await loadConfigFile(p);
    expect(result.agentApiKey).toBe("sk-agent-xyz");
    expect(result.memoryRetrieval).toBe("embedding");
    expect(result.memoryEmbeddingModel).toBe("openai/text-embedding-3-small");
  });
});

// ── M1: daemonPort ────────────────────────────────────────────────────────────

describe("loadConfigFile — daemonPort (M1)", () => {
  it("converts daemonPort to --port argv token", async () => {
    const p = await writeTmpConfig({ daemonPort: 4000 });
    const result = await loadConfigFile(p);
    const portIdx = result.args.indexOf("--port");
    expect(portIdx).toBeGreaterThanOrEqual(0);
    expect(result.args[portIdx + 1]).toBe("4000");
  });

  it("omits --port when daemonPort is 0", async () => {
    const p = await writeTmpConfig({ daemonPort: 0 });
    const result = await loadConfigFile(p);
    expect(result.args).not.toContain("--port");
  });

  it("omits --port when daemonPort is negative", async () => {
    const p = await writeTmpConfig({ daemonPort: -1 });
    const result = await loadConfigFile(p);
    expect(result.args).not.toContain("--port");
  });

  it("omits --port when daemonPort is absent", async () => {
    const p = await writeTmpConfig({});
    const result = await loadConfigFile(p);
    expect(result.args).not.toContain("--port");
  });
});

// ── M1: daemonMaxConcurrent ───────────────────────────────────────────────────

describe("loadConfigFile — daemonMaxConcurrent (M1)", () => {
  it("converts daemonMaxConcurrent to --max-concurrent argv token", async () => {
    const p = await writeTmpConfig({ daemonMaxConcurrent: 5 });
    const result = await loadConfigFile(p);
    const idx = result.args.indexOf("--max-concurrent");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(result.args[idx + 1]).toBe("5");
  });

  it("omits --max-concurrent when daemonMaxConcurrent is 0", async () => {
    const p = await writeTmpConfig({ daemonMaxConcurrent: 0 });
    const result = await loadConfigFile(p);
    expect(result.args).not.toContain("--max-concurrent");
  });
});

// ── M1: daemonIdleTimeout ─────────────────────────────────────────────────────

describe("loadConfigFile — daemonIdleTimeout (M1)", () => {
  it("converts '30m' to --idle-timeout argv token", async () => {
    const p = await writeTmpConfig({ daemonIdleTimeout: "30m" });
    const result = await loadConfigFile(p);
    const idx = result.args.indexOf("--idle-timeout");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(result.args[idx + 1]).toBe("30m");
  });

  it("converts '2h' to --idle-timeout argv token", async () => {
    const p = await writeTmpConfig({ daemonIdleTimeout: "2h" });
    const result = await loadConfigFile(p);
    const idx = result.args.indexOf("--idle-timeout");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(result.args[idx + 1]).toBe("2h");
  });

  it("converts '1.5h' to --idle-timeout argv token", async () => {
    const p = await writeTmpConfig({ daemonIdleTimeout: "1.5h" });
    const result = await loadConfigFile(p);
    const idx = result.args.indexOf("--idle-timeout");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(result.args[idx + 1]).toBe("1.5h");
  });

  it("converts '30s' to --idle-timeout argv token", async () => {
    const p = await writeTmpConfig({ daemonIdleTimeout: "30s" });
    const result = await loadConfigFile(p);
    const idx = result.args.indexOf("--idle-timeout");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(result.args[idx + 1]).toBe("30s");
  });

  it("omits --idle-timeout when format is invalid (bare number)", async () => {
    const p = await writeTmpConfig({ daemonIdleTimeout: "30" });
    const result = await loadConfigFile(p);
    expect(result.args).not.toContain("--idle-timeout");
  });

  it("omits --idle-timeout when absent", async () => {
    const p = await writeTmpConfig({});
    const result = await loadConfigFile(p);
    expect(result.args).not.toContain("--idle-timeout");
  });

  it("all three M1 daemon fields convert to correct argv together", async () => {
    const p = await writeTmpConfig({
      daemonPort: 4567,
      daemonMaxConcurrent: 8,
      daemonIdleTimeout: "1h",
    });
    const result = await loadConfigFile(p);
    const portIdx = result.args.indexOf("--port");
    const concIdx = result.args.indexOf("--max-concurrent");
    const idleIdx = result.args.indexOf("--idle-timeout");
    expect(result.args[portIdx + 1]).toBe("4567");
    expect(result.args[concIdx + 1]).toBe("8");
    expect(result.args[idleIdx + 1]).toBe("1h");
  });
});

// ── loadConfigFile — error handling ──────────────────────────────────────────

describe("loadConfigFile — error handling", () => {
  it("throws a descriptive error for a missing file", async () => {
    await expect(
      loadConfigFile("/tmp/orager-nonexistent-config-file.json"),
    ).rejects.toThrow(/Cannot read --config-file/);
  });

  it("throws a descriptive error for invalid JSON", async () => {
    const p = path.join(os.tmpdir(), `.orager-test-badjson-${process.pid}.json`);
    await fs.writeFile(p, "{ not valid json", { mode: 0o600 });
    await expect(loadConfigFile(p)).rejects.toThrow(/invalid JSON/);
  });

  it("deletes the config file immediately after reading", async () => {
    const p = await writeTmpConfig({ model: "openai/gpt-4o" });
    await loadConfigFile(p);
    await expect(fs.access(p)).rejects.toThrow(); // file should be gone
  });
});
