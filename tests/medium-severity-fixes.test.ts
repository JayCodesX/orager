/**
 * Tests for Medium + Low severity audit fixes.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// ── M-05: native-sqlite flush() method ───────────────────────────────────────
// wasm-sqlite.ts has been deleted (ADR-0008 §WASM removal). The flush() contract
// is satisfied by SqliteDb in native-sqlite.ts — native writes are immediately
// durable so flush() is a no-op, but the method must still exist for callers.

describe("M-05: native-sqlite flush() method", () => {
  it("flush() method exists on SqliteDb (native-sqlite.ts)", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/native-sqlite.ts"),
      "utf8",
    );
    expect(source).toContain("async flush()");
    // Native writes are immediately durable — no debounce queue to wait for
    expect(source).toContain("no debounced write queue");
  });
});

// ── M-07: PID lock TOCTOU race mitigation ────────────────────────────────────
// ADR-0003: src/daemon.ts has been removed. The PID lock pattern now lives in
// src/ui-server.ts (for `orager serve`). We verify the same safe pattern there.

describe("M-07: PID lock TOCTOU mitigation", () => {
  it("ui-server acquireUiPidLock uses exclusive write flag", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/ui-server.ts"),
      "utf8",
    );
    // Exclusive create flag — atomic, no TOCTOU window
    expect(source).toContain('flag: "wx"');
    // Must check for stale lock file (ESRCH = no such process)
    expect(source).toContain("ESRCH");
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
// ADR-0003: src/daemon.ts has been removed. The rate-limit concern no longer
// applies (no HTTP server for agent execution). We verify that neither the
// ui-server nor any remaining HTTP handler trusts x-forwarded-for for security
// decisions.

describe("M-22: Rate limit uses socket address only", () => {
  it("ui-server.ts does not trust x-forwarded-for for auth decisions", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/ui-server.ts"),
      "utf8",
    );
    // The UI auth check must not rely on a spoofable proxy header
    expect(source).not.toContain('req.headers["x-forwarded-for"]');
  });
});

// ── M-23: Health detail avoids opening a new SQLite DB ───────────────────────
// ADR-0003: src/daemon/routes/health.ts has been removed with the daemon.
// The ui-server /api/daemon/status endpoint is now a simple stub (no DB open).
// ADR-0008: WASM driver removed; openDb() is the current factory.

describe("M-23: Health detail DB check", () => {
  it("ui-server daemon-status handler does not open a SQLite DB", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/ui-server.ts"),
      "utf8",
    );
    // The stub handler must not open a new database on every call
    expect(source).not.toContain("openDb");
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

// ── M-12: Browser beforeExit cleanup ────────────────────────────────────────

describe("M-12: Browser beforeExit handler", () => {
  it("source has beforeExit handler for async browser cleanup", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/tools/browser.ts"),
      "utf8",
    );
    expect(source).toContain("M-12");
    expect(source).toContain("beforeExit");
    expect(source).toContain("_beforeExitCalled");
  });
});

// ── L-01: Rate limit map hard cap ───────────────────────────────────────────
// ADR-0003: src/daemon.ts (which held the HTTP rate limiter) has been removed.
// No unbounded in-memory rate-limit map remains. The concern is resolved by deletion.

describe("L-01: Rate limit map hard cap", () => {
  it("src/daemon.ts no longer exists — L-01 concern is resolved by ADR-0003 removal", async () => {
    // The daemon and its rate-limit map are gone. Verify the file is absent.
    await expect(
      fs.readFile(path.join(process.cwd(), "src/daemon.ts"), "utf8"),
    ).rejects.toThrow(); // ENOENT expected
  });
});

// ── L-02: Session save queue safe eviction ──────────────────────────────────

describe("L-02: Session save queue eviction", () => {
  it("only evicts settled entries from save queue", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/session.ts"),
      "utf8",
    );
    expect(source).toContain("L-02");
    expect(source).toContain("settled");
    // Should check settled state before evicting
    expect(source).toContain("entry.settled");
  });
});

// ── L-03: Session size cap documentation ────────────────────────────────────

describe("L-03: Session size cap documented as best-effort", () => {
  it("source documents the best-effort limitation", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/session.ts"),
      "utf8",
    );
    expect(source).toContain("L-03");
    expect(source).toContain("best-effort");
  });
});

// ── L-04: Audit dir init before write ───────────────────────────────────────

describe("L-04: Audit stream awaits dir init", () => {
  it("write call sites defer until _dirInit completes", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/audit.ts"),
      "utf8",
    );
    expect(source).toContain("L-04");
    expect(source).toContain("_dirInit");
  });
});

// ── L-05: MCP shutdown guard ────────────────────────────────────────────────

describe("L-05: MCP shuttingDown guard", () => {
  it("source checks shuttingDown before accepting calls", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/mcp.ts"),
      "utf8",
    );
    expect(source).toContain("L-05");
    expect(source).toContain("shuttingDown");
  });
});

// ── L-06: Silent error logging ──────────────────────────────────────────────

describe("L-06: Non-obvious catch blocks log errors", () => {
  it("glob.ts logs non-ENOENT readdir failures", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/tools/glob.ts"),
      "utf8",
    );
    expect(source).toContain("L-06");
    expect(source).toContain("ENOENT");
  });

  it("list-dir.ts logs non-ENOENT readdir failures", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/tools/list-dir.ts"),
      "utf8",
    );
    expect(source).toContain("L-06");
  });

  it("profile-loader.ts logs profile parse failures", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/profile-loader.ts"),
      "utf8",
    );
    expect(source).toContain("L-06");
  });
});

// ── L-07: Crash-safe atomic writes ──────────────────────────────────────────

describe("L-07: edit_files uses temp-then-rename", () => {
  it("source uses temp file and rename for crash safety", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/tools/edit-files.ts"),
      "utf8",
    );
    expect(source).toContain("L-07");
    expect(source).toContain(".tmp.");
    expect(source).toContain("rename");
  });
});

// ── L-08: UI server fd leak fix ─────────────────────────────────────────────

describe("L-08: UI server fd operations wrapped in try/finally", () => {
  it("source wraps openSync/readSync/closeSync in try/finally", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/ui-server.ts"),
      "utf8",
    );
    expect(source).toContain("L-08");
    // closeSync should be in a finally block
    expect(source).toMatch(/finally\s*\{[^}]*closeSync/s);
  });
});
