import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertPathAllowed } from "../src/sandbox.js";

describe("assertPathAllowed", () => {
  it("allows a path equal to the sandbox root", () => {
    expect(() => assertPathAllowed("/sandbox", "/sandbox")).not.toThrow();
  });

  it("allows a direct child of the sandbox root", () => {
    expect(() => assertPathAllowed("/sandbox/file.txt", "/sandbox")).not.toThrow();
  });

  it("allows a deeply nested path inside the root", () => {
    expect(() => assertPathAllowed("/sandbox/a/b/c.ts", "/sandbox")).not.toThrow();
  });

  it("throws for a path outside the sandbox root", () => {
    expect(() => assertPathAllowed("/etc/passwd", "/sandbox")).toThrow(
      "outside the sandbox root"
    );
  });

  it("throws for a sibling directory that starts with the same prefix", () => {
    // /sandbox-extra must not be allowed when root is /sandbox
    expect(() => assertPathAllowed("/sandbox-extra/file.txt", "/sandbox")).toThrow(
      "outside the sandbox root"
    );
  });

  it("throws for a path traversal attempt", () => {
    expect(() =>
      assertPathAllowed("/sandbox/../etc/passwd", "/sandbox")
    ).toThrow("outside the sandbox root");
  });

  it("resolves relative root and path before comparing", () => {
    // Both get resolve()-d so the check is purely on absolute canonical paths
    // Use tmp-style absolute paths to avoid OS differences
    expect(() => assertPathAllowed("/tmp/sandbox/a.txt", "/tmp/sandbox")).not.toThrow();
    expect(() => assertPathAllowed("/tmp/other/a.txt", "/tmp/sandbox")).toThrow();
  });
});

// ── Fix 6: symlink escape prevention via fs.realpathSync ──────────────────────

describe("assertPathAllowed — symlink escape prevention (Fix 6)", () => {
  it("blocks a symlink inside the sandbox that points outside", () => {
    // Create a real tmpdir (sandbox root), put a symlink inside it pointing to /etc.
    // Use fs.realpathSync to resolve macOS /var/folders → real path.
    const sandboxRaw = fs.mkdtempSync(path.join(os.tmpdir(), "orager-sandbox-"));
    const sandbox = fs.realpathSync(sandboxRaw);
    const symlinkPath = path.join(sandbox, "escape");
    try {
      fs.symlinkSync("/etc", symlinkPath);
      // The symlink is inside the sandbox directory, but resolves outside it.
      expect(() => assertPathAllowed(symlinkPath, sandbox)).toThrow("outside the sandbox root");
    } finally {
      try { fs.unlinkSync(symlinkPath); } catch { /* ignore */ }
      try { fs.rmdirSync(sandbox); } catch { /* ignore */ }
    }
  });

  it("allows a real file inside the sandbox (not a symlink escape)", () => {
    const sandboxRaw = fs.mkdtempSync(path.join(os.tmpdir(), "orager-sandbox-"));
    const sandbox = fs.realpathSync(sandboxRaw);
    const realFile = path.join(sandbox, "legit.txt");
    try {
      fs.writeFileSync(realFile, "hello");
      expect(() => assertPathAllowed(realFile, sandbox)).not.toThrow();
    } finally {
      try { fs.unlinkSync(realFile); } catch { /* ignore */ }
      try { fs.rmdirSync(sandbox); } catch { /* ignore */ }
    }
  });

  it("allows a non-existent target path inside the sandbox (new file creation)", () => {
    const sandboxRaw = fs.mkdtempSync(path.join(os.tmpdir(), "orager-sandbox-"));
    const sandbox = fs.realpathSync(sandboxRaw);
    const newFile = path.join(sandbox, "new-file.txt");
    try {
      // File does not exist yet — assertPathAllowed should still allow it
      expect(() => assertPathAllowed(newFile, sandbox)).not.toThrow();
    } finally {
      try { fs.rmdirSync(sandbox); } catch { /* ignore */ }
    }
  });
});
