/**
 * Tests for loadConfigFile — verifies that ConfigFileSchema fields are
 * correctly parsed from JSON and converted to argv tokens / result fields.
 *
 * Covers:
 *   - B2: agentApiKey, memoryRetrieval, memoryEmbeddingModel
 *   - (M1 daemon fields removed — daemon section dropped per ADR-0003)
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
