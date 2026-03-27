import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bashTool } from "../src/tools/bash.js";
import { writeFileTool, strReplaceTool } from "../src/tools/write-file.js";
import { readFileTool } from "../src/tools/read-file.js";
import { listDirTool } from "../src/tools/list-dir.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orager-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── bash tool ──────────────────────────────────────────────────────────────

describe("bash tool", () => {
  it("runs a simple command and returns output", async () => {
    const result = await bashTool.execute({ command: "echo hello" }, tmpDir);
    expect(result.isError).toBe(false);
    expect(result.content).toBe("hello\n");
  });

  it("non-zero exit returns isError: true with output", async () => {
    const result = await bashTool.execute(
      { command: "echo 'error output' && exit 1" },
      tmpDir
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("error output");
  });

  it("timeout resolves with isError: true and content includes 'timed out'", async () => {
    const result = await bashTool.execute(
      { command: "sleep 60", timeout_ms: 100 },
      tmpDir
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/timed out/i);
  }, 5000);
});

// ── write_file tool ────────────────────────────────────────────────────────

describe("write_file tool", () => {
  it("writes a file and the content can be read back", async () => {
    const filePath = path.join(tmpDir, "hello.txt");
    const result = await writeFileTool.execute(
      { path: filePath, content: "Hello, world!" },
      tmpDir
    );
    expect(result.isError).toBe(false);
    const written = await fs.readFile(filePath, "utf-8");
    expect(written).toBe("Hello, world!");
  });

  it("creates intermediate directories if they don't exist", async () => {
    const filePath = path.join(tmpDir, "a", "b", "c", "file.txt");
    const result = await writeFileTool.execute(
      { path: filePath, content: "nested" },
      tmpDir
    );
    expect(result.isError).toBe(false);
    const written = await fs.readFile(filePath, "utf-8");
    expect(written).toBe("nested");
  });
});

// ── str_replace tool ───────────────────────────────────────────────────────

describe("str_replace tool", () => {
  it("replaces a unique string in a file correctly", async () => {
    const filePath = path.join(tmpDir, "test.txt");
    await fs.writeFile(filePath, "foo bar baz", "utf-8");

    const result = await strReplaceTool.execute(
      { path: filePath, old_str: "bar", new_str: "qux" },
      tmpDir
    );
    expect(result.isError).toBe(false);
    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toBe("foo qux baz");
  });

  it("returns error when old_str not found", async () => {
    const filePath = path.join(tmpDir, "test.txt");
    await fs.writeFile(filePath, "foo bar baz", "utf-8");

    const result = await strReplaceTool.execute(
      { path: filePath, old_str: "notpresent", new_str: "something" },
      tmpDir
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
  });

  it("returns error when old_str appears multiple times", async () => {
    const filePath = path.join(tmpDir, "test.txt");
    await fs.writeFile(filePath, "foo foo foo", "utf-8");

    const result = await strReplaceTool.execute(
      { path: filePath, old_str: "foo", new_str: "bar" },
      tmpDir
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("3 times");
  });

  it("handles replacement strings containing $& literally (no special pattern bug)", async () => {
    const filePath = path.join(tmpDir, "test.txt");
    await fs.writeFile(filePath, "old text here", "utf-8");

    const result = await strReplaceTool.execute(
      { path: filePath, old_str: "old text", new_str: "cost $& fee" },
      tmpDir
    );
    expect(result.isError).toBe(false);
    const content = await fs.readFile(filePath, "utf-8");
    // $& should appear literally, not be replaced with the matched string
    expect(content).toBe("cost $& fee here");
  });
});

// ── read_file tool ─────────────────────────────────────────────────────────

describe("read_file tool", () => {
  it("reads a file and returns its content", async () => {
    const filePath = path.join(tmpDir, "read-me.txt");
    await fs.writeFile(filePath, "line one\nline two\nline three", "utf-8");

    const result = await readFileTool.execute({ path: filePath }, tmpDir);
    expect(result.isError).toBe(false);
    // Full-file reads include line numbers
    expect(result.content).toContain("line one");
    expect(result.content).toContain("line two");
    expect(result.content).toContain("line three");
  });

  it("returns isError: true for non-existent file", async () => {
    const result = await readFileTool.execute(
      { path: path.join(tmpDir, "does-not-exist.txt") },
      tmpDir
    );
    expect(result.isError).toBe(true);
  });

  it("respects start_line / end_line range", async () => {
    const filePath = path.join(tmpDir, "multi.txt");
    await fs.writeFile(filePath, "line1\nline2\nline3\nline4\nline5", "utf-8");

    const result = await readFileTool.execute(
      { path: filePath, start_line: 2, end_line: 3 },
      tmpDir
    );
    expect(result.isError).toBe(false);
    // Content should include lines 2 and 3 with line numbers
    expect(result.content).toContain("line2");
    expect(result.content).toContain("line3");
    expect(result.content).not.toContain("line1");
    expect(result.content).not.toContain("line4");
  });
});

// ── list_dir tool ──────────────────────────────────────────────────────────

describe("list_dir tool", () => {
  it("lists files in a dir (non-recursive)", async () => {
    await fs.writeFile(path.join(tmpDir, "a.txt"), "a", "utf-8");
    await fs.writeFile(path.join(tmpDir, "b.txt"), "b", "utf-8");
    await fs.mkdir(path.join(tmpDir, "subdir"));

    const result = await listDirTool.execute({ path: tmpDir, recursive: false }, tmpDir);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("a.txt");
    expect(result.content).toContain("b.txt");
    expect(result.content).toContain("subdir");
  });

  it("recursive listing works and skips node_modules", async () => {
    await fs.mkdir(path.join(tmpDir, "src"));
    await fs.writeFile(path.join(tmpDir, "src", "index.ts"), "export {}", "utf-8");
    await fs.mkdir(path.join(tmpDir, "node_modules"));
    await fs.writeFile(path.join(tmpDir, "node_modules", "pkg.js"), "module.exports = {}", "utf-8");

    const result = await listDirTool.execute({ path: tmpDir, recursive: true }, tmpDir);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("index.ts");
    // node_modules should be skipped
    expect(result.content).not.toContain("pkg.js");
  });

  it("returns error for non-existent directory", async () => {
    const result = await listDirTool.execute({ path: path.join(tmpDir, "no-such-dir") }, tmpDir);
    expect(result.isError).toBe(true);
  });
});

// ── Sandbox enforcement ────────────────────────────────────────────────────

describe("sandbox enforcement", () => {
  it("read_file allows access inside sandbox root", async () => {
    const filePath = path.join(tmpDir, "allowed.txt");
    await fs.writeFile(filePath, "secret", "utf-8");
    const result = await readFileTool.execute({ path: filePath }, tmpDir, { sandboxRoot: tmpDir });
    expect(result.isError).toBe(false);
    // Full-file reads include line numbers
    expect(result.content).toContain("secret");
  });

  it("read_file blocks access outside sandbox root", async () => {
    const result = await readFileTool.execute(
      { path: "/etc/passwd" },
      tmpDir,
      { sandboxRoot: tmpDir }
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("outside the sandbox root");
  });

  it("read_file blocks path traversal", async () => {
    const result = await readFileTool.execute(
      { path: path.join(tmpDir, "../outside.txt") },
      tmpDir,
      { sandboxRoot: tmpDir }
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("outside the sandbox root");
  });

  it("write_file allows writes inside sandbox root", async () => {
    const filePath = path.join(tmpDir, "out.txt");
    const result = await writeFileTool.execute(
      { path: filePath, content: "data" },
      tmpDir,
      { sandboxRoot: tmpDir }
    );
    expect(result.isError).toBe(false);
  });

  it("write_file blocks writes outside sandbox root", async () => {
    const result = await writeFileTool.execute(
      { path: "/tmp/evil.txt", content: "data" },
      tmpDir,
      { sandboxRoot: tmpDir }
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("outside the sandbox root");
  });

  it("str_replace blocks writes outside sandbox root", async () => {
    // The file doesn't need to exist for the sandbox check to trigger
    const result = await strReplaceTool.execute(
      { path: "/etc/passwd", old_str: "root", new_str: "evil" },
      tmpDir,
      { sandboxRoot: tmpDir }
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("outside the sandbox root");
  });

  it("list_dir blocks listing outside sandbox root", async () => {
    const result = await listDirTool.execute(
      { path: "/etc" },
      tmpDir,
      { sandboxRoot: tmpDir }
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("outside the sandbox root");
  });
});

// ── bash tool edge cases ───────────────────────────────────────────────────

describe("bash tool edge cases", () => {
  it("returns error for negative timeout_ms", async () => {
    const result = await bashTool.execute({ command: "echo hi", timeout_ms: -1 }, tmpDir);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("non-negative");
  });

  it("stderr output is included in content", async () => {
    const result = await bashTool.execute({ command: "echo 'err' >&2" }, tmpDir);
    expect(result.content).toContain("err");
  });
});

// ── read_file edge cases ───────────────────────────────────────────────────

describe("read_file edge cases", () => {
  it("returns error when start_line is 0", async () => {
    const filePath = path.join(tmpDir, "f.txt");
    await fs.writeFile(filePath, "a\nb\nc", "utf-8");
    const result = await readFileTool.execute({ path: filePath, start_line: 0 }, tmpDir);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("start_line must be >= 1");
  });

  it("returns error when end_line is 0", async () => {
    const filePath = path.join(tmpDir, "f.txt");
    await fs.writeFile(filePath, "a\nb\nc", "utf-8");
    const result = await readFileTool.execute({ path: filePath, end_line: 0 }, tmpDir);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("end_line must be >= 1");
  });

  it("returns error when start_line > end_line", async () => {
    const filePath = path.join(tmpDir, "f.txt");
    await fs.writeFile(filePath, "a\nb\nc\nd\ne", "utf-8");
    const result = await readFileTool.execute(
      { path: filePath, start_line: 4, end_line: 2 },
      tmpDir
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("start_line (4) must not exceed end_line (2)");
  });

  it("returns empty content without error when range is beyond file length", async () => {
    const filePath = path.join(tmpDir, "f.txt");
    await fs.writeFile(filePath, "only one line", "utf-8");
    const result = await readFileTool.execute(
      { path: filePath, start_line: 100, end_line: 200 },
      tmpDir
    );
    expect(result.isError).toBe(false);
    expect(result.content).toBe("");
  });
});
