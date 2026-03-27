import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
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
