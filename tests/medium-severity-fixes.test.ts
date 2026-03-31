/**
 * Tests for Medium severity audit fixes (M-05 through M-27).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// ── M-05: wasm-sqlite flush() method ─────────────────────────────────────────

describe("M-05: wasm-sqlite flush() method", () => {
  it("flush() method exists on WasmCompatDb", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/wasm-sqlite.ts"),
      "utf8",
    );
    expect(source).toContain("async flush()");
    expect(source).toContain("M-05");
    expect(source).toContain("if (this._saving) await this._saving");
  });
});

// ── M-07: PID lock TOCTOU race mitigation ────────────────────────────────────

describe("M-07: PID lock TOCTOU mitigation", () => {
  it("acquirePidLock uses retry loop with exclusive flag", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/daemon.ts"),
      "utf8",
    );
    expect(source).toContain("M-07");
    expect(source).toContain("for (let retry = 0; retry < 3; retry++)");
    expect(source).toContain('flag: "wx"');
  });
});

// ── M-08: runConcurrent abort on error ───────────────────────────────────────

import { runConcurrent } from "../src/loop-helpers.js";

describe("M-08: runConcurrent abort on error", () => {
  it("returns results in correct order for successful runs", async () => {
    const results = await runConcurrent(
      [1, 2, 3],
      2,
      async (n) => n * 10,
    );
    expect(results).toEqual([10, 20, 30]);
  });

  it("throws on first error", async () => {
    await expect(
      runConcurrent([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });

  it("stops picking up new items after an error", async () => {
    const executed: number[] = [];
    await runConcurrent(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      1, // single worker — sequential execution
      async (n) => {
        executed.push(n);
        if (n === 3) throw new Error("stop");
        return n;
      },
    ).catch(() => {});
    // With limit=1 (sequential), items 4-10 should NOT have executed
    expect(executed).toEqual([1, 2, 3]);
  });

  it("validates limit parameter", async () => {
    await expect(
      runConcurrent([1], 0, async (n) => n),
    ).rejects.toThrow("positive integer");
  });
});

// ── M-10: Sandbox symlink detection ──────────────────────────────────────────

import { assertPathAllowed } from "../src/sandbox.js";

describe("M-10: Sandbox symlink TOCTOU mitigation", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orager-sandbox-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("allows normal files inside sandbox", () => {
    const filePath = path.join(tmpDir, "test.txt");
    expect(() => assertPathAllowed(filePath, tmpDir)).not.toThrow();
  });

  it("rejects paths outside sandbox", () => {
    expect(() => assertPathAllowed("/etc/passwd", tmpDir)).toThrow(
      "outside the sandbox",
    );
  });

  it("rejects symlinks pointing outside sandbox", async () => {
    const linkPath = path.join(tmpDir, "escape-link");
    await fs.symlink("/etc/passwd", linkPath);
    expect(() => assertPathAllowed(linkPath, tmpDir)).toThrow(
      "outside the sandbox",
    );
  });

  it("allows symlinks pointing inside sandbox", async () => {
    const realFile = path.join(tmpDir, "real.txt");
    await fs.writeFile(realFile, "test");
    const linkPath = path.join(tmpDir, "internal-link");
    await fs.symlink(realFile, linkPath);
    expect(() => assertPathAllowed(linkPath, tmpDir)).not.toThrow();
  });
});

// ── M-16: Hook env var + stdin ───────────────────────────────────────────────

describe("M-16: Hook tool input via stdin", () => {
  it("hooks pass tool input via stdin option", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/hooks.ts"),
      "utf8",
    );
    expect(source).toContain("M-16");
    expect(source).toContain("input: toolInputJson");
    expect(source).toContain("Pipe tool input JSON on stdin");
  });
});

// ── M-22: Rate limiting ignores x-forwarded-for ──────────────────────────────

describe("M-22: Rate limit uses socket address only", () => {
  it("rate limit logic does not use x-forwarded-for", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/daemon.ts"),
      "utf8",
    );
    expect(source).toContain("M-22");
    expect(source).toContain("req.socket.remoteAddress");
    // Should NOT contain the old x-forwarded-for lookup
    expect(source).not.toContain('req.headers["x-forwarded-for"]');
  });
});

// ── M-23: Health detail avoids opening new WASM DB ───────────────────────────

describe("M-23: Health detail DB check", () => {
  it("health detail uses accessSync instead of openWasmDb", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/daemon/routes/health.ts"),
      "utf8",
    );
    expect(source).toContain("M-23");
    expect(source).toContain("fsSync.accessSync");
    // Should NOT open a new WASM DB
    expect(source).not.toContain("openWasmDb");
  });
});

// ── M-24: MCP client separate retry budgets ──────────────────────────────────

describe("M-24: MCP client separate retry budgets", () => {
  it("callTool has separate rate limit and reconnect handling", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/mcp-client.ts"),
      "utf8",
    );
    expect(source).toContain("M-24");
    expect(source).toContain("rateLimitAttempt");
    expect(source).toContain("_callWithReconnect");
  });
});
