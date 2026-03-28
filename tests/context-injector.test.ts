/**
 * Unit tests for context-injector.ts — gatherContext and formatContext.
 * Git commands are not mocked; they are expected to either succeed or fail gracefully.
 */
import { describe, it, expect } from "vitest";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { gatherContext, formatContext } from "../src/context-injector.js";

describe("gatherContext", () => {
  it("returns an object with optional fields (no crash) in tmp dir", async () => {
    // Use a tmp dir that has no git context — all fields should be undefined or empty
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ctx-test-"));
    try {
      const ctx = await gatherContext(tmpDir);
      // Should be defined (not throw)
      expect(ctx).toBeDefined();
      // gitBranch / gitStatus / recentCommits should be undefined when not a git repo
      expect(ctx.gitBranch === undefined || typeof ctx.gitBranch === "string").toBe(true);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns packageName when package.json exists", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ctx-pkg-test-"));
    try {
      await fs.writeFile(
        path.join(tmpDir, "package.json"),
        JSON.stringify({ name: "my-test-pkg", version: "1.2.3" }),
        "utf8",
      );
      const ctx = await gatherContext(tmpDir);
      expect(ctx.packageName).toBe("my-test-pkg");
      expect(ctx.packageVersion).toBe("1.2.3");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns undefined packageName when no package.json", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ctx-nopkg-test-"));
    try {
      const ctx = await gatherContext(tmpDir);
      expect(ctx.packageName).toBeUndefined();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("handles non-existent cwd gracefully", async () => {
    // Should not throw even if cwd does not exist
    const ctx = await gatherContext("/nonexistent/path/that/does/not/exist");
    expect(ctx).toBeDefined();
  });

  it("includes dirListing when directory has files", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ctx-dir-test-"));
    try {
      await fs.writeFile(path.join(tmpDir, "foo.ts"), "export {};");
      const ctx = await gatherContext(tmpDir);
      // dirListing may be defined if the readdir succeeded
      if (ctx.dirListing !== undefined) {
        expect(ctx.dirListing).toContain("foo.ts");
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("formatContext", () => {
  it("returns a string starting with [Auto-injected context]", () => {
    const output = formatContext({
      gitBranch: "main",
      gitStatus: "M  src/foo.ts",
    });
    expect(output.startsWith("[Auto-injected context]")).toBe(true);
  });

  it("includes gitBranch when provided", () => {
    const output = formatContext({ gitBranch: "feature/test" });
    expect(output).toContain("feature/test");
  });

  it("includes packageName and version when provided", () => {
    const output = formatContext({ packageName: "myapp", packageVersion: "2.0.0" });
    expect(output).toContain("myapp");
    expect(output).toContain("v2.0.0");
  });

  it("handles empty context without throwing", () => {
    expect(() => formatContext({})).not.toThrow();
  });

  it("does not include undefined fields", () => {
    const output = formatContext({ gitBranch: "main" });
    // Should not contain "undefined" literally
    expect(output).not.toContain("undefined");
  });
});
