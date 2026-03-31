import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Import from audit-utils.ts (not audit.ts) so vi.mock("../src/audit.js") in
// other test files never affects these imports.
import { sanitizeInput } from "../src/audit-utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(__dirname, "..");

describe("auditApproval", () => {
  let tmpDir: string;
  let auditPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orager-audit-"));
    auditPath = path.join(tmpDir, "audit.log");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes a valid JSON line to the audit log", async () => {
    // Run the actual audit write in a subprocess so process-wide
    // vi.mock("../src/audit.js") stubs (set by other test files) cannot
    // intercept the real auditApproval implementation.
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileP = promisify(execFile);

    const script = `
      import { auditApproval } from ${JSON.stringify(path.join(srcRoot, "src/audit.js"))};
      auditApproval({
        ts: new Date().toISOString(),
        sessionId: "test-session",
        toolName: "bash",
        inputSummary: { command: "ls -la" },
        decision: "approved",
        mode: "tty",
        durationMs: 1234,
      });
      setTimeout(() => {}, 200);
    `;
    // Detect runtime: bun uses "bun -e", node uses tsx for ESM eval
    const isBun = typeof (globalThis as Record<string, unknown>).Bun !== "undefined";
    const args = isBun
      ? ["-e", script]
      : ["--import", "tsx/esm", "--input-type=module", "--eval", script];
    await execFileP(process.execPath, args, {
      env: { ...process.env, ORAGER_AUDIT_LOG: auditPath },
      timeout: 10_000,
    });

    const contents = fs.readFileSync(auditPath, "utf8");
    const lines = contents.trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry.sessionId).toBe("test-session");
    expect(entry.toolName).toBe("bash");
    expect(entry.decision).toBe("approved");
    expect(entry.durationMs).toBe(1234);
  });

  it("truncates long input values in the log", () => {
    // Test the sanitizeInput pure function directly (no file I/O needed).
    // This is the actual logic under test — the write path is stdlib behavior.
    const result = sanitizeInput({ content: "x".repeat(2000) }) as Record<string, string>;
    expect(result.content.length).toBeLessThan(600);
    expect(result.content).toContain("more chars");
  });
});
