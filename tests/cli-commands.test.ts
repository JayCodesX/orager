/**
 * Tests for `orager run` and `orager chat` CLI subcommands (Ticket 5).
 *
 * Parsing tests use the exported parseArgs helper directly.
 * Integration tests spawn real Bun/node subprocesses to verify routing,
 * error output, and exit codes without calling any LLM API.
 */

import { describe, it, expect } from "vitest";
import { parseArgs } from "../src/cli/parse-args.js";
import { spawn } from "node:child_process";
import path from "node:path";

// ── parseArgs: --session-id alias ─────────────────────────────────────────────

describe("parseArgs --session-id alias", () => {
  it("sets sessionId from --session-id", () => {
    const opts = parseArgs(["--session-id", "abc-123"]);
    expect(opts.sessionId).toBe("abc-123");
  });

  it("sets sessionId from --resume (existing behaviour preserved)", () => {
    const opts = parseArgs(["--resume", "xyz-456"]);
    expect(opts.sessionId).toBe("xyz-456");
  });

  it("last flag wins when both --session-id and --resume appear", () => {
    const opts = parseArgs(["--session-id", "first", "--resume", "second"]);
    expect(opts.sessionId).toBe("second");
  });

  it("does not set sessionId when flag is absent", () => {
    const opts = parseArgs(["--model", "some-model"]);
    expect(opts.sessionId).toBeNull();
  });
});

// ── parseArgs: existing flags still work alongside new ones ──────────────────

describe("parseArgs combined flags", () => {
  it("parses --model and --session-id together", () => {
    const opts = parseArgs(["--model", "deepseek/deepseek-r1", "--session-id", "s-789"]);
    expect(opts.model).toBe("deepseek/deepseek-r1");
    expect(opts.sessionId).toBe("s-789");
  });

  it("parses --max-turns and --max-cost-usd", () => {
    const opts = parseArgs(["--max-turns", "5", "--max-cost-usd", "1.50"]);
    expect(opts.maxTurns).toBe(5);
    expect(opts.maxCostUsd).toBe(1.5);
  });
});

// ── Integration: `orager run` routing ────────────────────────────────────────

/**
 * Spawn the orager CLI entry point with the given argv and collect stderr output.
 * Exits when the process closes (max 5 s).
 */
async function spawnOragerCli(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const entryPoint = path.resolve("src/index.ts");

  return new Promise((resolve) => {
    const proc = spawn(
      process.execPath.endsWith("bun") ? process.execPath : "bun",
      ["run", entryPoint, ...args],
      {
        env: { ...process.env, ORAGER_SKIP_PID_LOCK: "1", ...env },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.stdin?.end();

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
    }, 5000);

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code });
    });
  });
}

describe("orager run subcommand routing", () => {
  it("exits non-zero and prints API key error when PROTOCOL_API_KEY is unset", async () => {
    const { stderr, exitCode } = await spawnOragerCli(
      ["run", "hello world"],
      { PROTOCOL_API_KEY: "" },
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("PROTOCOL_API_KEY");
  }, 8000);

  it("exits non-zero with empty prompt error when no prompt and no stdin pipe", async () => {
    // Spawn without any prompt argument — stdin is not a pipe here so we
    // detect it via the error message.
    const { stderr, exitCode } = await spawnOragerCli(
      ["run"],
      // Provide key to get past the API key check; no LLM will be called
      // because the prompt check fires first.
      { PROTOCOL_API_KEY: "test-key" },
    );
    expect(exitCode).not.toBe(0);
    expect(stderr.toLowerCase()).toMatch(/prompt|stdin/);
  }, 8000);
});

describe("orager chat subcommand routing", () => {
  it("exits non-zero and prints API key error when PROTOCOL_API_KEY is unset", async () => {
    const { stderr, exitCode } = await spawnOragerCli(
      ["chat"],
      { PROTOCOL_API_KEY: "" },
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("PROTOCOL_API_KEY");
  }, 8000);
});

// ── Integration: `orager --help` includes new commands ───────────────────────

describe("orager --help mentions run and chat", () => {
  it("help output contains 'run' and 'chat' subcommands", async () => {
    const proc = spawn(
      process.execPath.endsWith("bun") ? process.execPath : "bun",
      ["run", path.resolve("src/index.ts"), "--help"],
      { env: { ...process.env, ORAGER_SKIP_PID_LOCK: "1" }, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stdin?.end();
    await new Promise<void>((res) => proc.on("close", () => res()));

    expect(stdout).toContain("run");
    expect(stdout).toContain("chat");
    expect(stdout).toContain("--session-id");
    expect(stdout).toContain("--memory-key");
    expect(stdout).toContain("--subprocess");
  }, 8000);
});
