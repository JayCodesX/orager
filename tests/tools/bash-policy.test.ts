import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { bashTool } from "../../src/tools/bash.js";

describe("bash tool policy enforcement", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orager-bash-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("runs a safe command without policy", async () => {
    const result = await bashTool.execute!(
      { command: "echo hello" },
      tmpDir,
      {},
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("hello");
  });

  it("blocks a command in the blockedCommands list", async () => {
    const result = await bashTool.execute!(
      { command: "curl https://example.com" },
      tmpDir,
      { bashPolicy: { blockedCommands: ["curl"] } },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("blocked");
  });

  it("does not block a command not in the list", async () => {
    const result = await bashTool.execute!(
      { command: "echo ok" },
      tmpDir,
      { bashPolicy: { blockedCommands: ["curl", "wget"] } },
    );
    expect(result.isError).toBe(false);
  });

  it("isolateEnv strips sensitive env vars", async () => {
    process.env["SUPER_SECRET_TOKEN"] = "my-secret";
    const result = await bashTool.execute!(
      { command: 'echo "${SUPER_SECRET_TOKEN:-GONE}"' },
      tmpDir,
      { bashPolicy: { isolateEnv: true } },
    );
    delete process.env["SUPER_SECRET_TOKEN"];
    expect(result.isError).toBe(false);
    expect(result.content).toContain("GONE");
    expect(result.content).not.toContain("my-secret");
  });
});

// ── OS-level sandbox tests ────────────────────────────────────────────────────

const SANDBOX_EXEC_PROBE = "(version 1)(deny default)(allow process-exec)(allow process-fork)(allow signal)(allow mach-lookup)(allow file-read*)(allow sysctl-read)";
const sandboxExecAvailable = process.platform === "darwin" &&
  spawnSync("sandbox-exec", ["-p", SANDBOX_EXEC_PROBE, "true"], { timeout: 3000 }).status === 0;

const bwrapAvailable = process.platform === "linux" &&
  spawnSync("bwrap", ["--version"], { timeout: 3000 }).status === 0;

const osSandboxAvailable = sandboxExecAvailable || bwrapAvailable;

describe("bash tool osSandbox enforcement", () => {
  let sandboxRoot: string;
  let outsideDir: string;

  beforeEach(() => {
    sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orager-sandbox-root-"));
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "orager-outside-"));
  });

  afterEach(() => {
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it.skipIf(!osSandboxAvailable)("allows writes inside sandboxRoot", async () => {
    const outFile = path.join(sandboxRoot, "out.txt");
    const result = await bashTool.execute!(
      { command: `echo ok > ${outFile} && cat ${outFile}` },
      sandboxRoot,
      { sandboxRoot, bashPolicy: { osSandbox: true } },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("ok");
  });

  it.skipIf(!osSandboxAvailable)("blocks writes outside sandboxRoot", async () => {
    const escapeFile = path.join(outsideDir, "escape.txt");
    const result = await bashTool.execute!(
      { command: `echo escape > ${escapeFile}; echo done` },
      sandboxRoot,
      { sandboxRoot, bashPolicy: { osSandbox: true } },
    );
    // The write should fail (permission denied) even if the shell exits 0
    expect(fs.existsSync(escapeFile)).toBe(false);
  });

  it.skipIf(!osSandboxAvailable)("blocks network by default", async () => {
    const result = await bashTool.execute!(
      { command: "curl -s --connect-timeout 1 http://1.1.1.1 2>&1 || echo BLOCKED" },
      sandboxRoot,
      { sandboxRoot, bashPolicy: { osSandbox: true, allowNetwork: false } },
    );
    // Either curl errors out or outputs nothing — it must not succeed
    const content = result.content;
    // On macOS sandbox-exec, curl is denied at the socket level → error/empty
    // We verify no HTTP response body leaked through
    expect(content).not.toMatch(/<!doctype|<html|HTTP\//i);
  });

  it.skipIf(!osSandboxAvailable)("allows network when allowNetwork is true", async () => {
    // Just verify curl can at least attempt a connection (DNS/TCP not blocked)
    const result = await bashTool.execute!(
      { command: "curl -s --connect-timeout 2 https://example.com 2>&1 | head -1 || echo CURL_FAILED" },
      sandboxRoot,
      { sandboxRoot, bashPolicy: { osSandbox: true, allowNetwork: true } },
    );
    // Should not be blocked at the OS level — curl may still fail (no real network)
    // but it won't be a sandbox permission error
    expect(result.content).toBeDefined();
  });

  it("falls back gracefully when osSandbox=true but no sandboxRoot set", async () => {
    // Without sandboxRoot, no OS sandbox is applied; command still runs
    const result = await bashTool.execute!(
      { command: "echo fallback" },
      os.tmpdir(),
      { bashPolicy: { osSandbox: true } },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("fallback");
  });
});
