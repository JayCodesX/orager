/**
 * Tests for the expanded hook system (10-event, URL + command targets).
 *
 * Uses tmp scripts and a local HTTP server (via `Bun.serve`) to verify
 * shell-command hooks and URL hooks without network access.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  fireHooks,
  runHook,
  isHookUrlSafe,
} from "../src/hooks.js";
import type { HookPayload, HookEvent } from "../src/hooks.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function tmpScript(content: string): Promise<string> {
  const f = path.join(os.tmpdir(), `hook-test-${Math.random().toString(36).slice(2)}.sh`);
  await fs.writeFile(f, content, { mode: 0o755 });
  return f;
}

function basePayload(event: HookEvent): HookPayload {
  return { event, sessionId: "test-session", ts: new Date().toISOString() };
}

// ── isHookUrlSafe ─────────────────────────────────────────────────────────────

describe("isHookUrlSafe", () => {
  it("allows public HTTPS URLs", async () => {
    await expect(isHookUrlSafe("https://hooks.slack.com/services/abc")).resolves.toBe(true);
    await expect(isHookUrlSafe("https://example.com/webhook")).resolves.toBe(true);
  });

  it("allows public HTTP URLs", async () => {
    // Use a public IP directly to avoid DNS resolution dependency
    await expect(isHookUrlSafe("http://8.8.8.8/hook")).resolves.toBe(true);
  });

  it("blocks localhost IPs directly", async () => {
    await expect(isHookUrlSafe("http://127.0.0.1/hook")).resolves.toBe(false);
    await expect(isHookUrlSafe("http://[::1]/hook")).resolves.toBe(false);
    await expect(isHookUrlSafe("http://0.0.0.0/hook")).resolves.toBe(false);
  });

  it("blocks localhost hostname via DNS resolution", async () => {
    await expect(isHookUrlSafe("http://localhost/hook")).resolves.toBe(false);
  });

  it("blocks RFC-1918 private ranges", async () => {
    await expect(isHookUrlSafe("http://10.0.0.1/hook")).resolves.toBe(false);
    await expect(isHookUrlSafe("http://192.168.1.1/hook")).resolves.toBe(false);
    await expect(isHookUrlSafe("http://172.16.0.1/hook")).resolves.toBe(false);
    await expect(isHookUrlSafe("http://172.31.255.255/hook")).resolves.toBe(false);
  });

  it("allows 172.x outside the private range", async () => {
    await expect(isHookUrlSafe("http://172.32.0.1/hook")).resolves.toBe(true);
    await expect(isHookUrlSafe("http://172.15.0.1/hook")).resolves.toBe(true);
  });

  it("blocks non-http/https protocols", async () => {
    await expect(isHookUrlSafe("ftp://example.com/hook")).resolves.toBe(false);
    await expect(isHookUrlSafe("file:///etc/passwd")).resolves.toBe(false);
  });

  it("returns false for invalid URLs", async () => {
    await expect(isHookUrlSafe("not-a-url")).resolves.toBe(false);
    await expect(isHookUrlSafe("")).resolves.toBe(false);
  });
});

// ── fireHooks — command target ────────────────────────────────────────────────

describe("fireHooks — command (string) target", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orager-hooks-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("runs the command and resolves { ok: true } on success", async () => {
    const markerFile = path.join(tmpDir, "ran.txt");
    const result = await fireHooks(
      "SessionStart",
      `touch ${markerFile}`,
      basePayload("SessionStart"),
    );
    expect(result.ok).toBe(true);
    await expect(fs.stat(markerFile)).resolves.toBeTruthy();
  });

  it("passes ORAGER_HOOK_EVENT and ORAGER_SESSION_ID env vars", async () => {
    const outFile = path.join(tmpDir, "env.txt");
    await fireHooks(
      "PreToolCall",
      `echo "$ORAGER_HOOK_EVENT $ORAGER_SESSION_ID" > ${outFile}`,
      { ...basePayload("PreToolCall"), toolName: "bash" },
    );
    const content = (await fs.readFile(outFile, "utf8")).trim();
    expect(content).toBe("PreToolCall test-session");
  });

  it("passes ORAGER_TOOL_NAME for tool events", async () => {
    const outFile = path.join(tmpDir, "tool.txt");
    await fireHooks(
      "PreToolCall",
      `echo "$ORAGER_TOOL_NAME" > ${outFile}`,
      { ...basePayload("PreToolCall"), toolName: "write_file" },
    );
    const content = (await fs.readFile(outFile, "utf8")).trim();
    expect(content).toBe("write_file");
  });

  it("passes ORAGER_TURN for LLM events", async () => {
    const outFile = path.join(tmpDir, "turn.txt");
    await fireHooks(
      "PreLLMRequest",
      `echo "$ORAGER_TURN" > ${outFile}`,
      { ...basePayload("PreLLMRequest"), turn: 3, model: "openai/gpt-4o" },
    );
    const content = (await fs.readFile(outFile, "utf8")).trim();
    expect(content).toBe("3");
  });

  it("passes ORAGER_MODEL for LLM events", async () => {
    const outFile = path.join(tmpDir, "model.txt");
    await fireHooks(
      "PostLLMResponse",
      `echo "$ORAGER_MODEL" > ${outFile}`,
      { ...basePayload("PostLLMResponse"), model: "openai/gpt-4o", turn: 0 },
    );
    const content = (await fs.readFile(outFile, "utf8")).trim();
    expect(content).toBe("openai/gpt-4o");
  });

  it("passes ORAGER_SUBTYPE and ORAGER_TOTAL_COST for Stop events", async () => {
    const outFile = path.join(tmpDir, "stop.txt");
    await fireHooks(
      "Stop",
      `echo "$ORAGER_SUBTYPE $ORAGER_TOTAL_COST" > ${outFile}`,
      { ...basePayload("Stop"), subtype: "success", totalCostUsd: 0.0042, turn: 5 },
    );
    const content = (await fs.readFile(outFile, "utf8")).trim();
    expect(content).toBe("success 0.0042");
  });

  it("returns { ok: false } when the command exits non-zero (default warn mode)", async () => {
    const logs: string[] = [];
    const result = await fireHooks(
      "SessionStop",
      "exit 1",
      basePayload("SessionStop"),
      { errorMode: "warn" },
      (msg) => logs.push(msg),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(logs.some((l) => l.includes("WARNING"))).toBe(true);
  });

  it("returns { ok: false } but emits no log in ignore mode", async () => {
    const logs: string[] = [];
    const result = await fireHooks(
      "SessionStop",
      "exit 1",
      basePayload("SessionStop"),
      { errorMode: "ignore" },
      (msg) => logs.push(msg),
    );
    expect(result.ok).toBe(false);
    expect(logs).toHaveLength(0);
  });

  it("respects hookTimeoutMs and returns error on timeout", async () => {
    const result = await fireHooks(
      "PreToolCall",
      "sleep 10",
      basePayload("PreToolCall"),
      { timeoutMs: 100, errorMode: "ignore" },
    );
    expect(result.ok).toBe(false);
  });
});

// ── fireHooks — URL target ────────────────────────────────────────────────────

describe("fireHooks — URL target (SSRF guard)", () => {
  it("returns { ok: false } when URL is a private IP", async () => {
    const logs: string[] = [];
    const result = await fireHooks(
      "Stop",
      { url: "http://192.168.1.100/hook" },
      basePayload("Stop"),
      { errorMode: "ignore" },
      (msg) => logs.push(msg),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/blocked/i);
  });

  it("returns { ok: false } when URL is localhost", async () => {
    const result = await fireHooks(
      "Stop",
      { url: "http://localhost/hook" },
      basePayload("Stop"),
      { errorMode: "ignore" },
    );
    expect(result.ok).toBe(false);
  });
});

// ── fireHooks — array target ──────────────────────────────────────────────────

describe("fireHooks — array target", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orager-hooks-arr-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("fires all targets in the array", async () => {
    const file1 = path.join(tmpDir, "a.txt");
    const file2 = path.join(tmpDir, "b.txt");
    const result = await fireHooks(
      "SessionStart",
      [`touch ${file1}`, `touch ${file2}`],
      basePayload("SessionStart"),
    );
    expect(result.ok).toBe(true);
    await expect(fs.stat(file1)).resolves.toBeTruthy();
    await expect(fs.stat(file2)).resolves.toBeTruthy();
  });

  it("continues running remaining targets after one fails and returns first error", async () => {
    const file2 = path.join(tmpDir, "second.txt");
    const result = await fireHooks(
      "SessionStart",
      ["exit 1", `touch ${file2}`],
      basePayload("SessionStart"),
      { errorMode: "ignore" },
    );
    // First error is captured
    expect(result.ok).toBe(false);
    // Second target still ran
    await expect(fs.stat(file2)).resolves.toBeTruthy();
  });

  it("mixes command and URL targets — SSRF-blocked URL does not stop command", async () => {
    const markerFile = path.join(tmpDir, "mixed.txt");
    const result = await fireHooks(
      "Stop",
      [{ url: "http://10.0.0.1/hook" }, `touch ${markerFile}`],
      basePayload("Stop"),
      { errorMode: "ignore" },
    );
    // URL failed (SSRF)
    expect(result.ok).toBe(false);
    // Command still ran
    await expect(fs.stat(markerFile)).resolves.toBeTruthy();
  });
});

// ── HookEvent type coverage ───────────────────────────────────────────────────

describe("HookEvent — all 10 events are valid HookEvent values", () => {
  const allEvents: HookEvent[] = [
    "PreToolCall",
    "PostToolCall",
    "SessionStart",
    "SessionStop",
    "PreLLMRequest",
    "PostLLMResponse",
    "Stop",
    "ToolDenied",
    "ToolTimeout",
    "MaxTurnsReached",
  ];

  for (const event of allEvents) {
    it(`fireHooks accepts event "${event}" without throwing`, async () => {
      const result = await fireHooks(event, "true", basePayload(event));
      expect(result.ok).toBe(true);
    });
  }
});

// ── runHook backward compat ───────────────────────────────────────────────────

describe("runHook (backward compat)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orager-hooks-rc-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("still works as a command hook via fireHooks under the hood", async () => {
    const markerFile = path.join(tmpDir, "compat.txt");
    const result = await runHook(
      "PreToolCall",
      `touch ${markerFile}`,
      { sessionId: "compat-session", toolName: "bash" },
    );
    expect(result.ok).toBe(true);
    await expect(fs.stat(markerFile)).resolves.toBeTruthy();
  });

  it("passes ctx.isError as ORAGER_IS_ERROR env var", async () => {
    const outFile = path.join(tmpDir, "iserror.txt");
    await runHook(
      "PostToolCall",
      `echo "$ORAGER_IS_ERROR" > ${outFile}`,
      { sessionId: "s", toolName: "bash", isError: true },
    );
    const content = (await fs.readFile(outFile, "utf8")).trim();
    expect(content).toBe("true");
  });
});
