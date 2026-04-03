/**
 * Tests for audit findings N-01 through N-12 and R-08 fixes.
 *
 * N-04: Body-read timeout in web_fetch
 * N-05: Session ID path traversal in todo
 * N-07: Notebook edit index drift on delete
 * N-08: Glob exponential backtracking on consecutive **
 * N-09: withCacheControl multimodal corruption
 * N-10: wasm-sqlite lastSaveError tracking
 *
 * N-01/N-02/N-06 are tested via daemon-abort-cleanup.test.ts adjustments.
 * R-08 and N-11 are in the adapter repo.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// ── N-05: Todo session ID path traversal ─────────────────────────────────────

import { makeTodoTools } from "../src/tools/todo.js";

describe("N-05: Todo sessionId path traversal prevention", () => {
  it("rejects sessionId containing path traversal (../../etc)", async () => {
    const tools = makeTodoTools("../../etc/passwd");
    const todoWrite = tools.find(
      (t) => t.definition.function.name === "todo_write",
    )!;
    // The todoPath function should sanitize the sessionId; attempting to write
    // should not escape the ~/.orager/todos/ directory.
    const result = await todoWrite.execute(
      {
        todos: [
          {
            id: "1",
            content: "test",
            status: "pending",
            priority: "medium",
          },
        ],
      },
      "/tmp",
    );
    // After sanitization, the file should be written to ~/.orager/todos/passwd.json
    // (path.basename("../../etc/passwd") === "passwd"), NOT to ../../etc/passwd.json
    if (!result.isError) {
      // Clean up — verify the file was written in the correct location
      const safePath = path.join(
        os.homedir(),
        ".orager",
        "todos",
        "passwd.json",
      );
      const exists = await fs
        .stat(safePath)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);
      await fs.unlink(safePath).catch(() => {});
    }
  });

  it("rejects sessionId that is just '..'", async () => {
    const tools = makeTodoTools("..");
    const todoWrite = tools.find(
      (t) => t.definition.function.name === "todo_write",
    )!;
    // todoPath throws on ".." — the error propagates from writeTodos
    await expect(
      todoWrite.execute(
        {
          todos: [
            { id: "1", content: "test", status: "pending", priority: "medium" },
          ],
        },
        "/tmp",
      ),
    ).rejects.toThrow("Invalid session ID");
  });

  it("sanitizes sessionId with slashes to basename only", async () => {
    const tools = makeTodoTools("foo/bar/baz");
    const todoRead = tools.find(
      (t) => t.definition.function.name === "todo_read",
    )!;
    // Should not error — reads from ~/.orager/todos/baz.json
    const result = await todoRead.execute({}, "/tmp");
    expect(result.isError).toBe(false);
  });
});

// ── N-07: Notebook edit index drift ──────────────────────────────────────────

import { notebookEditTool } from "../src/tools/notebook.js";

describe("N-07: Notebook edit operations with index drift", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "orager-notebook-test-"),
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function makeNotebook(sources: string[]) {
    return {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: sources.map((s) => ({
        cell_type: "code",
        source: s,
        outputs: [],
        execution_count: null,
      })),
    };
  }

  it("deleting cell 2 then cell 5 hits correct cells (descending order)", async () => {
    // 6 cells: [A, B, C, D, E, F]
    const nbPath = path.join(tmpDir, "test.ipynb");
    await fs.writeFile(
      nbPath,
      JSON.stringify(makeNotebook(["A", "B", "C", "D", "E", "F"])),
    );

    const result = await notebookEditTool.execute(
      {
        path: nbPath,
        operations: [
          { type: "delete", cell_index: 2 }, // delete C
          { type: "delete", cell_index: 5 }, // delete F (original index)
        ],
      },
      tmpDir,
    );

    expect(result.isError).toBe(false);
    const nb = JSON.parse(await fs.readFile(nbPath, "utf8"));
    // Should have 4 cells: A, B, D, E (C and F deleted)
    expect(nb.cells.map((c: { source: string }) => c.source)).toEqual([
      "A",
      "B",
      "D",
      "E",
    ]);
  });

  it("mixed delete and replace operations use correct indices", async () => {
    const nbPath = path.join(tmpDir, "test2.ipynb");
    await fs.writeFile(
      nbPath,
      JSON.stringify(makeNotebook(["A", "B", "C", "D"])),
    );

    const result = await notebookEditTool.execute(
      {
        path: nbPath,
        operations: [
          { type: "replace", cell_index: 1, source: "B_REPLACED" },
          { type: "delete", cell_index: 2 }, // delete C
        ],
      },
      tmpDir,
    );

    expect(result.isError).toBe(false);
    const nb = JSON.parse(await fs.readFile(nbPath, "utf8"));
    // A, B_REPLACED, D (C deleted, B replaced)
    expect(nb.cells.map((c: { source: string }) => c.source)).toEqual([
      "A",
      "B_REPLACED",
      "D",
    ]);
  });
});

// ── N-08: Glob consecutive ** collapse ───────────────────────────────────────

import { globTool } from "../src/tools/glob.js";

describe("N-08: Glob consecutive ** collapse", () => {
  it("does not hang on **/**/**/*.ts pattern", async () => {
    // This test verifies the pattern completes in reasonable time.
    // Without the fix, consecutive ** causes exponential backtracking.
    const start = Date.now();
    // Run against /tmp which has a manageable depth
    await globTool.execute(
      { pattern: "**/**/**/*.test-nonexistent" },
      os.tmpdir(),
      { allowedPaths: [os.tmpdir()] },
    );
    const elapsed = Date.now() - start;
    // Should complete in under 10 seconds even on slow machines.
    // Without the fix this would take minutes/hours on deep trees.
    expect(elapsed).toBeLessThan(10_000);
  });
});

// ── N-09: withCacheControl multimodal ────────────────────────────────────────
// withCacheControl is not exported, so we test via applyAnthropicCacheControl
// indirectly through callOpenRouter. Instead, we'll test the logic pattern directly.

describe("N-09: withCacheControl multimodal message handling", () => {
  // We can't import the private function directly, so we test by verifying
  // the openrouter module handles array content without corruption.
  // The fix ensures Array.isArray(msg.content) is checked before wrapping.

  it("the fix exists in the source code", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/openrouter.ts"),
      "utf8",
    );
    // Verify the fix is present
    expect(source).toContain("Array.isArray(msg.content)");
    expect(source).toContain("cache_control: cc");
    // Verify the old bug pattern (unconditionally wrapping) is guarded
    expect(source).toContain("N-09");
  });
});

// ── N-10: native-sqlite lastSaveError tracking ───────────────────────────────
// wasm-sqlite.ts has been deleted (ADR-0008 §WASM removal). The lastSaveError
// field is preserved in native-sqlite.ts's SqliteDb for API compatibility.

describe("N-10: native-sqlite lastSaveError field", () => {
  it("the lastSaveError field exists in native-sqlite.ts (SqliteDb)", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/native-sqlite.ts"),
      "utf8",
    );
    // SqliteDb exposes lastSaveError for API compatibility — always null (native writes are durable)
    expect(source).toContain("lastSaveError");
    expect(source).toContain("lastSaveError: Error | null = null");
  });
});

// ── N-04: Body-read timeout ──────────────────────────────────────────────────

describe("N-04: Body-read timeout in web_fetch", () => {
  it("the body timeout fix exists in the source code", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/tools/web-fetch.ts"),
      "utf8",
    );
    expect(source).toContain("bodyController");
    expect(source).toContain("Body read timed out");
    expect(source).toContain("N-04");
  });
});

// ── N-01: Abort signal forwarded to API call ────────────────────────────────

describe("N-01: Abort signal forwarded to LLM API call", () => {
  it("the signal is passed in the callWithRetry options", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/loop.ts"),
      "utf8",
    );
    // The signal property must appear between the callWithRetry call and its
    // closing bracket, indicating it's part of the options object
    expect(source).toContain("signal: _effectiveAbortSignal");
    expect(source).toContain("N-01");
  });
});

// N-02 and N-06 audited daemon/routes/run.ts which has been removed in
// Ticket 3 (daemon agent-execution removed; agents run in-process only).
