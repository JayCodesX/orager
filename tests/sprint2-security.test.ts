/**
 * Sprint 2 security-hardening regression tests.
 *
 * Covers the four changes shipped in fix/sprint-2-security-hardening:
 *   1. read-file.ts  — stat guard rejects files over ORAGER_MAX_READ_FILE_BYTES
 *   2. write-file.ts — content guard rejects content over ORAGER_MAX_WRITE_FILE_BYTES
 *   3. mcp-client.ts — IPv6 link-local (fe80::/10) blocked by SSRF guard
 *   4. audit.ts      — rotation uses timestamped suffix; pruneAuditBackups keeps
 *                       ≤ AUDIT_MAX_BACKUPS files
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readFileTool } from "../src/tools/read-file.js";
import { writeFileTool } from "../src/tools/write-file.js";

// ── 1. read-file: stat guard ──────────────────────────────────────────────────

describe("read_file size guard", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orager-rf-"));
  });

  afterEach(async () => {
    delete process.env["ORAGER_MAX_READ_FILE_BYTES"];
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("rejects a file that exceeds ORAGER_MAX_READ_FILE_BYTES", async () => {
    // Use a 10-byte limit so we can test with tiny files.
    process.env["ORAGER_MAX_READ_FILE_BYTES"] = "10";

    const filePath = path.join(tmpDir, "big.txt");
    // Write 20 bytes — above the 10-byte limit.
    await fs.writeFile(filePath, "x".repeat(20), "utf-8");

    // We must re-import to pick up the new env var because the constant is
    // evaluated at module load. Use a fresh dynamic import.
    const { readFileTool: freshTool } = await import("../src/tools/read-file.js?bust=" + Date.now());

    const result = await freshTool.execute({ path: filePath }, tmpDir);

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/exceeds the \d+ MB read limit/);
  });

  it("allows a file that fits within the limit", async () => {
    process.env["ORAGER_MAX_READ_FILE_BYTES"] = "10000";

    const filePath = path.join(tmpDir, "small.txt");
    await fs.writeFile(filePath, "hello", "utf-8");

    const result = await readFileTool.execute({ path: filePath }, tmpDir);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("hello");
  });
});

// ── 2. write-file: content guard ─────────────────────────────────────────────

describe("write_file content size guard", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orager-wf-"));
  });

  afterEach(async () => {
    delete process.env["ORAGER_MAX_WRITE_FILE_BYTES"];
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("rejects content that exceeds ORAGER_MAX_WRITE_FILE_BYTES", async () => {
    process.env["ORAGER_MAX_WRITE_FILE_BYTES"] = "10";

    // Re-import to see the updated env var
    const { writeFileTool: freshTool } = await import("../src/tools/write-file.js?bust=" + Date.now());

    const filePath = path.join(tmpDir, "big.txt");
    const result = await freshTool.execute({ path: filePath, content: "x".repeat(20) }, tmpDir);

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/exceeds the \d+ MB write limit/);
    // File must NOT have been created — guard fires before any disk I/O
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it("reports byte size (not char count) for multi-byte UTF-8", async () => {
    // Each '€' is 3 bytes in UTF-8. 4 chars = 12 bytes; limit = 11 bytes.
    process.env["ORAGER_MAX_WRITE_FILE_BYTES"] = "11";

    const { writeFileTool: freshTool } = await import("../src/tools/write-file.js?bust=" + Date.now());

    const filePath = path.join(tmpDir, "unicode.txt");
    const result = await freshTool.execute({ path: filePath, content: "€€€€" }, tmpDir);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("MB");
  });

  it("allows content within the limit", async () => {
    const filePath = path.join(tmpDir, "ok.txt");
    const result = await writeFileTool.execute({ path: filePath, content: "hello" }, tmpDir);
    expect(result.isError).toBe(false);
  });
});

// ── 3. mcp-client: SSRF guard — IPv6 link-local ──────────────────────────────

describe("MCP SSRF guard — IPv6 link-local", () => {
  it("connectMcpServer throws for fe80:: (link-local) URL", async () => {
    const { connectMcpServer } = await import("../src/mcp-client.js");

    // fe80::1 is a canonical IPv6 link-local address
    await expect(
      connectMcpServer("bad-server", { url: "http://[fe80::1]/mcp" }),
    ).rejects.toThrow(/blocked/);
  });

  it("connectMcpServer throws for fe89:: (fe80::/10 range) URL", async () => {
    const { connectMcpServer } = await import("../src/mcp-client.js");

    await expect(
      connectMcpServer("bad-server2", { url: "http://[fe89::1]/mcp" }),
    ).rejects.toThrow(/blocked/);
  });

  it("connectMcpServer throws for 169.254.x.x (IPv4 link-local) URL", async () => {
    const { connectMcpServer } = await import("../src/mcp-client.js");

    await expect(
      connectMcpServer("meta", { url: "http://169.254.169.254/latest/meta-data" }),
    ).rejects.toThrow(/blocked/);
  });

  it("connectMcpServer does NOT throw for a normal localhost URL", async () => {
    const { connectMcpServer } = await import("../src/mcp-client.js");

    // Localhost is allowed — but since nothing is listening, expect a network error
    // (connection refused), not a "blocked" SSRF error.
    const err = await connectMcpServer("local", { url: "http://127.0.0.1:19998/mcp" }).catch((e) => e);
    expect(err).toBeTruthy();
    // The error should NOT be the SSRF block message
    expect(String(err.message ?? err)).not.toMatch(/blocked/);
  }, 10_000);
});

// ── 4. audit.ts: timestamped rotation + pruning ───────────────────────────────
//
// We exercise rotation via Bun.spawn so that process-wide vi.mock("../src/audit.js")
// stubs (set by other files) can't interfere, and so that _stream is fresh.

describe("audit log rotation", () => {
  let tmpDir: string;
  let auditPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orager-audit-rot-"));
    auditPath = path.join(tmpDir, "audit.log");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /**
   * Run a snippet in a subprocess so the audit stream singleton is fresh.
   * Returns stdout+stderr as combined text.
   */
  async function runAuditScript(code: string): Promise<void> {
    const isBun = typeof (globalThis as Record<string, unknown>).Bun !== "undefined";
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execP = promisify(execFile);
    const script = `
      import { auditApproval, _resetStreamForTesting } from ${JSON.stringify(
        path.resolve("src/audit.js"),
      )};
      ${code}
      await new Promise(r => setTimeout(r, 300));
    `;
    const args = isBun
      ? ["-e", script]
      : ["--import", "tsx/esm", "--input-type=module", "--eval", script];
    await execP(process.execPath, args, {
      env: { ...process.env, ORAGER_AUDIT_LOG: auditPath },
      timeout: 10_000,
    });
  }

  it("rotation uses a timestamped suffix (not .1)", async () => {
    // Pre-create a 1-byte file and set MAX to 0 so any write triggers rotation.
    // We override the internal limit by pre-filling the file beyond 10 MB limit
    // before spawning. Write exactly 10MB + 1 byte by stuffing the file directly.
    const limit = 10 * 1024 * 1024; // same as src/audit.ts MAX_AUDIT_LOG_BYTES
    const filler = Buffer.alloc(limit + 1, "x");
    fsSync.writeFileSync(auditPath, filler);

    // Trigger a write — ensureAuditDir will rotate because size >= MAX
    await runAuditScript(`
      auditApproval({
        ts: new Date().toISOString(),
        sessionId: "s1",
        toolName: "bash",
        inputSummary: {},
        decision: "approved",
        mode: "tty",
      });
    `);

    const entries = await fs.readdir(tmpDir);
    const backups = entries.filter((e) => e.startsWith("audit.log.") && e !== "audit.log");

    // Exactly one backup should exist
    expect(backups.length).toBe(1);

    // The suffix must look like a compact ISO timestamp (e.g. 2026-04-03T12-00-00Z)
    const suffix = backups[0]!.slice("audit.log.".length);
    // Must contain digits + hyphens + T + Z — not just ".1"
    expect(suffix).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/);
  }, 20_000);

  it("pruneAuditBackups removes oldest backups beyond AUDIT_MAX_BACKUPS", async () => {
    // Create 12 fake backup files (AUDIT_MAX_BACKUPS defaults to 10)
    const limit = 10 * 1024 * 1024;
    const filler = Buffer.alloc(limit + 1, "x");
    fsSync.writeFileSync(auditPath, filler);

    // Seed 12 fake backups with lexicographically-orderable timestamps
    for (let i = 1; i <= 12; i++) {
      const ts = `2026-01-${String(i).padStart(2, "0")}T00-00-00Z`;
      fsSync.writeFileSync(path.join(tmpDir, `audit.log.${ts}`), "old\n");
    }

    await runAuditScript(`
      auditApproval({
        ts: new Date().toISOString(),
        sessionId: "s2",
        toolName: "bash",
        inputSummary: {},
        decision: "approved",
        mode: "tty",
      });
    `);

    const entries = await fs.readdir(tmpDir);
    const backups = entries.filter((e) => e.startsWith("audit.log.") && e !== "audit.log");

    // 12 pre-existing + 1 new rotation = 13 total; pruning must trim to ≤ 10
    expect(backups.length).toBeLessThanOrEqual(10);
    // The 2 oldest (2026-01-01, 2026-01-02) should have been deleted
    expect(backups.some((b) => b.includes("2026-01-01"))).toBe(false);
    expect(backups.some((b) => b.includes("2026-01-02"))).toBe(false);
  }, 20_000);
});
