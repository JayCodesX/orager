import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { editFilesTool } from "../../src/tools/edit-files.js";

describe("edit_files tool", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orager-edit-files-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("applies edits to two files atomically (happy path)", async () => {
    const fileA = path.join(tmpDir, "a.ts");
    const fileB = path.join(tmpDir, "b.ts");
    fs.writeFileSync(fileA, "export function foo() {}\n");
    fs.writeFileSync(fileB, "// uses a\ncallFoo();\n");

    const result = await editFilesTool.execute!(
      {
        files: [
          { path: fileA, edits: [{ old_string: "function foo()", new_string: "function bar()" }] },
          { path: fileB, edits: [{ old_string: "callFoo()", new_string: "callBar()" }] },
        ],
      },
      tmpDir,
    );

    expect(result.isError).toBe(false);
    expect(fs.readFileSync(fileA, "utf8")).toContain("function bar()");
    expect(fs.readFileSync(fileB, "utf8")).toContain("callBar()");
    expect(result.content).toContain("2 file(s)");
  });

  it("rolls back (writes nothing) when validation fails on second file", async () => {
    const fileA = path.join(tmpDir, "a.ts");
    const fileB = path.join(tmpDir, "b.ts");
    const origA = "export function foo() {}\n";
    const origB = "import { foo } from './a.js';\n";
    fs.writeFileSync(fileA, origA);
    fs.writeFileSync(fileB, origB);

    // fileB edit references a string that doesn't exist
    const result = await editFilesTool.execute!(
      {
        files: [
          { path: fileA, edits: [{ old_string: "foo()", new_string: "bar()" }] },
          { path: fileB, edits: [{ old_string: "nonexistent_string_xyz", new_string: "bar" }] },
        ],
      },
      tmpDir,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
    // fileA must be unchanged because validation failed before any writes
    expect(fs.readFileSync(fileA, "utf8")).toBe(origA);
    expect(fs.readFileSync(fileB, "utf8")).toBe(origB);
  });

  it("returns error when a file path does not exist", async () => {
    const result = await editFilesTool.execute!(
      {
        files: [
          { path: path.join(tmpDir, "nonexistent.ts"), edits: [{ old_string: "x", new_string: "y" }] },
        ],
      },
      tmpDir,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Cannot read");
  });

  it("errors when files array is empty", async () => {
    const result = await editFilesTool.execute!({ files: [] }, tmpDir);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("non-empty");
  });

  it("errors when old_string is ambiguous (appears multiple times)", async () => {
    const file = path.join(tmpDir, "dup.ts");
    fs.writeFileSync(file, "foo foo\n");

    const result = await editFilesTool.execute!(
      { files: [{ path: file, edits: [{ old_string: "foo", new_string: "bar" }] }] },
      tmpDir,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/2 times|appears.*2/i);
    // File must be unchanged
    expect(fs.readFileSync(file, "utf8")).toBe("foo foo\n");
  });
});
