/**
 * Unit tests for settings.ts — loadSettings, mergeSettings,
 * and loadClaudeDesktopMcpServers.
 *
 * File I/O is mocked via tmp files so no real ~/.orager/settings.json is touched.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadSettings, mergeSettings } from "../src/settings.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

let tmpDir: string;
let settingsPath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orager-settings-test-"));
  settingsPath = path.join(tmpDir, "settings.json");
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeSettings(data: unknown): Promise<void> {
  await fs.writeFile(settingsPath, JSON.stringify(data), "utf8");
}

// ── loadSettings ──────────────────────────────────────────────────────────────

describe("loadSettings", () => {
  it("returns empty object when file does not exist", async () => {
    const settings = await loadSettings(path.join(tmpDir, "nonexistent.json"));
    expect(settings).toEqual({});
  });

  it("parses valid settings file", async () => {
    await writeSettings({ bashPolicy: { isolateEnv: true } });
    const settings = await loadSettings(settingsPath);
    expect(settings.bashPolicy?.isolateEnv).toBe(true);
  });

  it("returns empty object for malformed JSON", async () => {
    await fs.writeFile(settingsPath, "{ invalid json", "utf8");
    const settings = await loadSettings(settingsPath);
    expect(settings).toEqual({});
  });

  it("drops invalid permission values and does not throw", async () => {
    await writeSettings({
      permissions: { bash: "INVALID_VALUE", read_file: "allow" },
    });
    const settings = await loadSettings(settingsPath);
    // "INVALID_VALUE" should be dropped; "allow" is valid
    expect(settings.permissions?.bash).toBeUndefined();
    expect(settings.permissions?.read_file).toBe("allow");
  });

  it("accepts all valid permission values", async () => {
    await writeSettings({
      permissions: { bash: "allow", edit: "deny", write_file: "ask" },
    });
    const settings = await loadSettings(settingsPath);
    expect(settings.permissions?.bash).toBe("allow");
    expect(settings.permissions?.edit).toBe("deny");
    expect(settings.permissions?.write_file).toBe("ask");
  });

  it("returns cached result on second call with same mtime", async () => {
    await writeSettings({ bashPolicy: { isolateEnv: false } });
    const first = await loadSettings(settingsPath);
    // Overwrite in memory (same mtime on fast systems) — cache should return first
    const second = await loadSettings(settingsPath);
    expect(first).toBe(second); // reference equality from cache
  });
});

// ── loadSettings — key format validation ──────────────────────────────────────

describe("loadSettings — permission key validation", () => {
  it("does not throw on permission keys with unusual characters", async () => {
    // Keys with spaces, hyphens, etc. should warn but not crash
    await writeSettings({
      permissions: { "has space": "allow", "has-hyphen": "allow", "valid_key": "allow" },
    });
    // Should not throw
    await expect(loadSettings(settingsPath)).resolves.toBeDefined();
  });

  it("accepts snake_case permission keys without warning emission causing crash", async () => {
    await writeSettings({
      permissions: { bash: "allow", read_file: "deny", web_fetch: "ask" },
    });
    const settings = await loadSettings(settingsPath);
    expect(settings.permissions?.bash).toBe("allow");
  });

  it("warns about keys with spaces in them but does not delete them", async () => {
    await writeSettings({
      permissions: { "bsh tool": "allow", "valid_key": "deny" },
    });
    // Capture stderr to see if a warning is written
    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    const spy = (chunk: string | Uint8Array): boolean => {
      stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return originalWrite(chunk);
    };
    process.stderr.write = spy as typeof process.stderr.write;
    try {
      const settings = await loadSettings(settingsPath);
      // The key with a space should still be present (warn-only, not deleted)
      expect(settings.permissions?.["bsh tool"]).toBe("allow");
      // The valid key should be present too
      expect(settings.permissions?.valid_key).toBe("deny");
    } finally {
      process.stderr.write = originalWrite;
    }
    // A warning should have been written to stderr about the bad key format
    const allStderr = stderrChunks.join("");
    expect(allStderr).toMatch(/permission key.*does not look like a tool name|verify spelling/i);
  });

  it("warns about keys with hyphens but does not delete them", async () => {
    await writeSettings({
      permissions: { "has-hyphen": "allow" },
    });
    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return originalWrite(chunk);
    }) as typeof process.stderr.write;
    try {
      const settings = await loadSettings(settingsPath);
      // Key retained despite warning
      expect(settings.permissions?.["has-hyphen"]).toBe("allow");
    } finally {
      process.stderr.write = originalWrite;
    }
    expect(stderrChunks.join("")).toMatch(/permission key|verify spelling/i);
  });
});

// ── mergeSettings ─────────────────────────────────────────────────────────────

describe("mergeSettings", () => {
  it("returns runtime opts unchanged when fileSettings is empty", () => {
    const runtime = { model: "gpt-4o", bashPolicy: { isolateEnv: true } };
    const merged = mergeSettings(runtime, {});
    expect(merged).toEqual(runtime);
  });

  it("file bashPolicy fills in when runtime has no bashPolicy", () => {
    const runtime = { model: "gpt-4o" };
    const file = { bashPolicy: { isolateEnv: true, blockedCommands: ["rm -rf"] } };
    const merged = mergeSettings(runtime, file);
    expect(merged.bashPolicy?.isolateEnv).toBe(true);
  });

  it("runtime bashPolicy keys override file bashPolicy keys", () => {
    const runtime = { bashPolicy: { isolateEnv: false } };
    const file = { bashPolicy: { isolateEnv: true, blockedCommands: ["rm"] } };
    const merged = mergeSettings(runtime, file);
    // runtime override wins for isolateEnv
    expect(merged.bashPolicy?.isolateEnv).toBe(false);
    // file fills in blockedCommands that runtime didn't specify
    expect(merged.bashPolicy?.blockedCommands).toEqual(["rm"]);
  });

  it("file hooks fill in when runtime has no hooks and hooksEnabled is not false", () => {
    const runtime = { model: "gpt-4o" };
    const file = { hooks: { PreToolCall: "/bin/echo" }, hooksEnabled: true };
    const merged = mergeSettings(runtime, file);
    expect(merged.hooks?.PreToolCall).toBe("/bin/echo");
  });

  it("file hooks are suppressed when hooksEnabled is false", () => {
    const runtime = { model: "gpt-4o" };
    const file = { hooks: { PreToolCall: "/bin/echo" }, hooksEnabled: false };
    const merged = mergeSettings(runtime, file);
    expect(merged.hooks).toBeUndefined();
  });

  it("runtime hooks override file hooks", () => {
    const runtime = { hooks: { PreToolCall: "/usr/bin/custom" } };
    const file = { hooks: { PreToolCall: "/bin/echo", PostToolCall: "/bin/true" } };
    const merged = mergeSettings(runtime, file);
    expect(merged.hooks?.PreToolCall).toBe("/usr/bin/custom");
    expect(merged.hooks?.PostToolCall).toBe("/bin/true");
  });

  it("file permissions fill in requireApproval when runtime has none", () => {
    const runtime = { model: "gpt-4o" } as Record<string, unknown> & { requireApproval?: string[] | "all"; bashPolicy?: { isolateEnv?: boolean }; hooks?: Record<string, string> };
    const file = { permissions: { bash: "deny", write_file: "ask" } };
    const merged = mergeSettings(runtime, file);
    expect(Array.isArray(merged.requireApproval)).toBe(true);
    expect((merged.requireApproval as string[]).sort()).toContain("bash");
    expect((merged.requireApproval as string[]).sort()).toContain("write_file");
  });

  it("runtime requireApproval is not overwritten by file permissions", () => {
    const runtime = { requireApproval: "all" as const };
    const file = { permissions: { bash: "deny" } };
    const merged = mergeSettings(runtime, file);
    expect(merged.requireApproval).toBe("all");
  });
});
