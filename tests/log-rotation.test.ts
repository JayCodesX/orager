import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { _getLogFileSizeBytes, _maybeRotate } from "../src/logger.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function tmpFile(): string {
  return path.join(os.tmpdir(), `orager-log-rotation-test-${process.pid}-${Date.now()}.log`);
}

function cleanup(...files: string[]): void {
  for (const f of files) {
    try { fs.unlinkSync(f); } catch { /* already gone */ }
  }
}

// ── _getLogFileSizeBytes ──────────────────────────────────────────────────────

describe("_getLogFileSizeBytes", () => {
  it("returns 0 for a missing file (ENOENT)", () => {
    expect(_getLogFileSizeBytes("/tmp/__this_file_does_not_exist_12345.log")).toBe(0);
  });

  it("returns the correct byte count for an existing file", () => {
    const f = tmpFile();
    try {
      fs.writeFileSync(f, "hello\n");
      expect(_getLogFileSizeBytes(f)).toBe(6);
    } finally {
      cleanup(f);
    }
  });
});

// ── _maybeRotate ──────────────────────────────────────────────────────────────

describe("_maybeRotate", () => {
  it("does not rotate when file size is under threshold", () => {
    const logPath = tmpFile();
    const rotated = `${logPath}.1`;
    try {
      fs.writeFileSync(logPath, "small");
      _maybeRotate(logPath, 1000); // 1000 bytes threshold — file is 5 bytes
      expect(fs.existsSync(rotated)).toBe(false);
      expect(fs.existsSync(logPath)).toBe(true);
    } finally {
      cleanup(logPath, rotated);
    }
  });

  it("rotates file to .1 when over threshold", () => {
    const logPath = tmpFile();
    const rotated = `${logPath}.1`;
    try {
      fs.writeFileSync(logPath, "AB"); // 2 bytes
      _maybeRotate(logPath, 1); // threshold: 1 byte → rotation triggered
      expect(fs.existsSync(rotated)).toBe(true);
      // .1 should contain original content
      expect(fs.readFileSync(rotated, "utf8")).toBe("AB");
      // Original log path should no longer exist (renamed away)
      expect(fs.existsSync(logPath)).toBe(false);
    } finally {
      cleanup(logPath, rotated);
    }
  });

  it("writes go to fresh file after rotation", () => {
    const logPath = tmpFile();
    const rotated = `${logPath}.1`;
    try {
      fs.writeFileSync(logPath, "EXISTING_CONTENT");
      _maybeRotate(logPath, 1); // force rotation
      // Now write new content to the fresh path
      fs.appendFileSync(logPath, "NEW_CONTENT\n");
      const newContent = fs.readFileSync(logPath, "utf8");
      expect(newContent).not.toContain("EXISTING_CONTENT");
      expect(newContent).toContain("NEW_CONTENT");
      // Rotated file has original
      expect(fs.readFileSync(rotated, "utf8")).toBe("EXISTING_CONTENT");
    } finally {
      cleanup(logPath, rotated);
    }
  });

  it("ORAGER_LOG_MAX_SIZE_MB threshold is respected (large file triggers rotation)", () => {
    const logPath = tmpFile();
    const rotated = `${logPath}.1`;
    try {
      // Write 100 bytes, use 50 bytes as threshold
      fs.writeFileSync(logPath, "X".repeat(100));
      const maxBytes = 50; // 50 bytes — less than file size
      _maybeRotate(logPath, maxBytes);
      expect(fs.existsSync(rotated)).toBe(true);
    } finally {
      cleanup(logPath, rotated);
    }
  });

  it("does not crash when log file is missing (ENOENT)", () => {
    const logPath = tmpFile(); // never created
    expect(() => {
      _maybeRotate(logPath, 100);
    }).not.toThrow();
    // No rotation file should be created
    expect(fs.existsSync(`${logPath}.1`)).toBe(false);
  });
});
