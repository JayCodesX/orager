import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("auditApproval", () => {
  let tmpDir: string;
  let auditPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orager-audit-"));
    auditPath = path.join(tmpDir, "audit.log");
    process.env["ORAGER_AUDIT_LOG"] = auditPath;
    // Reset module registry so the next import picks up the new env var
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env["ORAGER_AUDIT_LOG"];
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it("writes a valid JSON line to the audit log", async () => {
    // Dynamic import so it picks up the env var set above
    const { auditApproval } = await import("../src/audit.js");
    auditApproval({
      ts: new Date().toISOString(),
      sessionId: "test-session",
      toolName: "bash",
      inputSummary: { command: "ls -la" },
      decision: "approved",
      mode: "tty",
      durationMs: 1234,
    });

    // Give the write stream a moment to flush
    await new Promise((r) => setTimeout(r, 50));

    const contents = fs.readFileSync(auditPath, "utf8");
    const lines = contents.trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry.sessionId).toBe("test-session");
    expect(entry.toolName).toBe("bash");
    expect(entry.decision).toBe("approved");
    expect(entry.durationMs).toBe(1234);
  });

  it("truncates long input values in the log", async () => {
    const { auditApproval } = await import("../src/audit.js");
    auditApproval({
      ts: new Date().toISOString(),
      sessionId: "s2",
      toolName: "write_file",
      inputSummary: { content: "x".repeat(2000) },
      decision: "denied",
      mode: "callback",
    });

    await new Promise((r) => setTimeout(r, 50));
    const contents = fs.readFileSync(auditPath, "utf8");
    const lines = contents.trim().split("\n").filter(Boolean);
    const entry = JSON.parse(lines[lines.length - 1]);
    expect((entry.inputSummary as Record<string, string>).content.length).toBeLessThan(600);
    expect((entry.inputSummary as Record<string, string>).content).toContain("more chars");
  });
});
