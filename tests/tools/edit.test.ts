import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { editFileTool } from "../../src/tools/edit.js";

describe("edit_file tool", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orager-edit-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("applies a single edit successfully", async () => {
    const file = path.join(tmpDir, "test.txt");
    fs.writeFileSync(file, "hello world\n");

    const result = await editFileTool.execute!(
      { path: file, edits: [{ old_string: "world", new_string: "earth" }] },
      tmpDir,
    );

    expect(result.isError).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe("hello earth\n");
  });

  it("applies multiple edits in order", async () => {
    const file = path.join(tmpDir, "multi.txt");
    fs.writeFileSync(file, "foo bar baz\n");

    const result = await editFileTool.execute!(
      {
        path: file,
        edits: [
          { old_string: "foo", new_string: "one" },
          { old_string: "bar", new_string: "two" },
        ],
      },
      tmpDir,
    );

    expect(result.isError).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe("one two baz\n");
  });

  it("errors when old_string not found", async () => {
    const file = path.join(tmpDir, "nope.txt");
    fs.writeFileSync(file, "hello\n");

    const result = await editFileTool.execute!(
      { path: file, edits: [{ old_string: "missing", new_string: "x" }] },
      tmpDir,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
  });

  it("errors when old_string is ambiguous (multiple matches)", async () => {
    const file = path.join(tmpDir, "ambiguous.txt");
    fs.writeFileSync(file, "foo foo\n");

    const result = await editFileTool.execute!(
      { path: file, edits: [{ old_string: "foo", new_string: "bar" }] },
      tmpDir,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/2 times|appears.*2/i);
  });

  it("creates file when create_if_missing is true", async () => {
    const file = path.join(tmpDir, "new.txt");

    // old_string must be non-empty even for create_if_missing; the file not
    // existing triggers the create path before old_string is checked.
    const result = await editFileTool.execute!(
      {
        path: file,
        edits: [{ old_string: "placeholder", new_string: "created content" }],
        create_if_missing: true,
      },
      tmpDir,
    );

    expect(result.isError).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe("created content");
  });

  it("errors on missing file without create_if_missing", async () => {
    const result = await editFileTool.execute!(
      { path: path.join(tmpDir, "missing.txt"), edits: [{ old_string: "a", new_string: "b" }] },
      tmpDir,
    );
    expect(result.isError).toBe(true);
  });

  // ── Fix 1: String.prototype.replace pattern injection guard ─────────────────
  // If new_string is passed directly as the second arg to String.replace(), the
  // JS engine expands special replacement patterns ($& = matched substring,
  // $1..$N = capture groups, $` = pre-match, $' = post-match).  The replacer-fn
  // form `() => new_string` bypasses this expansion entirely.

  it("preserves $& literally in new_string (no match substitution)", async () => {
    const file = path.join(tmpDir, "dollar-amp.txt");
    fs.writeFileSync(file, "hello world\n");

    const result = await editFileTool.execute!(
      { path: file, edits: [{ old_string: "world", new_string: "$&_suffix" }] },
      tmpDir,
    );

    expect(result.isError).toBe(false);
    // Without the replacer-fn fix this would produce "world_suffix" (or "world world_suffix").
    expect(fs.readFileSync(file, "utf8")).toBe("hello $&_suffix\n");
  });

  it("preserves $1 literally in new_string (no capture-group substitution)", async () => {
    const file = path.join(tmpDir, "dollar-one.txt");
    fs.writeFileSync(file, "foo bar\n");

    const result = await editFileTool.execute!(
      { path: file, edits: [{ old_string: "foo", new_string: "prefix_$1" }] },
      tmpDir,
    );

    expect(result.isError).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe("prefix_$1 bar\n");
  });

  it("preserves $` and $' literally in new_string", async () => {
    const file = path.join(tmpDir, "dollar-backtick.txt");
    fs.writeFileSync(file, "A B C\n");

    const result = await editFileTool.execute!(
      { path: file, edits: [{ old_string: "B", new_string: "$`$'" }] },
      tmpDir,
    );

    expect(result.isError).toBe(false);
    // Without fix this would expand $` → "A " and $' → " C\n", producing "A A  C\n C\n".
    expect(fs.readFileSync(file, "utf8")).toBe("A $`$' C\n");
  });
});
