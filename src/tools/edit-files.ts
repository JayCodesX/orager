import type { ToolExecutor, ToolExecuteOptions, ToolResult } from "../types.js";
import fs from "node:fs/promises";
import path from "node:path";
import { assertPathAllowed } from "../sandbox.js";

interface FileEdit {
  path: string;
  edits: Array<{ old_string: string; new_string: string }>;
}

export const editFilesTool: ToolExecutor = {
  definition: {
    type: "function",
    readonly: false,
    function: {
      name: "edit_files",
      description:
        "Apply edits to multiple files atomically. " +
        "All old_strings across all files are validated BEFORE any file is written. " +
        "If any validation fails, no files are modified. " +
        "Use this for cross-file refactoring (renaming a function, updating imports, etc.).",
      parameters: {
        type: "object",
        properties: {
          files: {
            type: "array",
            description: "List of files to edit",
            items: {
              type: "object",
              properties: {
                path: { type: "string", description: "File path (relative to cwd or absolute)" },
                edits: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      old_string: { type: "string" },
                      new_string: { type: "string" },
                    },
                    required: ["old_string", "new_string"],
                  },
                },
              },
              required: ["path", "edits"],
            },
          },
        },
        required: ["files"],
      },
    },
  },

  async execute(input: Record<string, unknown>, cwd: string, opts?: ToolExecuteOptions): Promise<ToolResult> {
    if (!Array.isArray(input["files"]) || input["files"].length === 0) {
      return { toolCallId: "", content: "files must be a non-empty array", isError: true };
    }

    const files = input["files"] as FileEdit[];

    // ── Phase 1: Read all files ───────────────────────────────────────────────
    const fileContents = new Map<string, string>();
    for (const file of files) {
      if (!file.path || !Array.isArray(file.edits)) {
        return { toolCallId: "", content: `Invalid file entry: ${JSON.stringify(file)}`, isError: true };
      }
      const abs = path.isAbsolute(file.path) ? file.path : path.join(cwd, file.path);
      if (opts?.sandboxRoot) {
        try { assertPathAllowed(abs, opts.sandboxRoot); } catch (e) {
          return { toolCallId: "", content: String(e), isError: true };
        }
      }
      try {
        fileContents.set(abs, await fs.readFile(abs, "utf8"));
      } catch (err) {
        return {
          toolCallId: "",
          content: `Cannot read ${file.path}: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    }

    // ── Phase 2: Validate all edits (dry run) ─────────────────────────────────
    const pendingWrites = new Map<string, string>();
    for (const file of files) {
      const abs = path.isAbsolute(file.path) ? file.path : path.join(cwd, file.path);
      let content = fileContents.get(abs)!;

      for (let i = 0; i < file.edits.length; i++) {
        const { old_string, new_string } = file.edits[i];

        if (typeof old_string !== "string" || typeof new_string !== "string") {
          return { toolCallId: "", content: `${file.path} edits[${i}]: old_string and new_string must be strings`, isError: true };
        }
        if (old_string === "") {
          return { toolCallId: "", content: `${file.path} edits[${i}]: old_string must not be empty`, isError: true };
        }

        let count = 0;
        let pos = 0;
        while (true) {
          const idx = content.indexOf(old_string, pos);
          if (idx === -1) break;
          count++;
          pos = idx + 1;
          if (count > 1) break;
        }

        if (count === 0) {
          return {
            toolCallId: "",
            content: `${file.path} edits[${i}]: old_string not found. Use read_file to verify content.`,
            isError: true,
          };
        }
        if (count > 1) {
          return {
            toolCallId: "",
            content: `${file.path} edits[${i}]: old_string appears ${count} times — must be unique.`,
            isError: true,
          };
        }

        content = content.replace(old_string, () => new_string);
      }

      pendingWrites.set(abs, content);
    }

    // ── Phase 3: Write all files (all validations passed) ────────────────────
    // On write failure, restore already-written files from the Phase 1 snapshot
    // so the working tree is never left in a partially-edited state.
    const written: string[] = [];
    for (const [abs, content] of pendingWrites) {
      // L-07: Write to temp file first, then atomically rename. This prevents
      // leaving partially-written files if the process crashes mid-write.
      const tmpPath = abs + `.tmp.${process.pid}`;
      try {
        await fs.writeFile(tmpPath, content, "utf8");
        await fs.rename(tmpPath, abs);
        written.push(abs);
      } catch (err) {
        await fs.unlink(tmpPath).catch(() => {});
        const writeErr = err instanceof Error ? err.message : String(err);
        // Restore all files written so far back to their original content
        const restoreErrors: string[] = [];
        for (const w of written) {
          try {
            await fs.writeFile(w, fileContents.get(w)!, "utf8");
          } catch (restoreErr) {
            restoreErrors.push(`${w}: ${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}`);
          }
        }
        const restoreNote = restoreErrors.length > 0
          ? ` Restore also failed for: ${restoreErrors.join("; ")}`
          : written.length > 0 ? ` Restored ${written.length} previously-written file(s) to original content.` : "";
        return {
          toolCallId: "",
          content:
            `Write failed on ${abs}: ${writeErr}.${restoreNote}`,
          isError: true,
        };
      }
    }

    const totalEdits = files.reduce((sum, f) => sum + f.edits.length, 0);
    return {
      toolCallId: "",
      content: `Applied ${totalEdits} edit(s) across ${written.length} file(s):\n${written.map((p) => `  • ${p}`).join("\n")}`,
      isError: false,
    };
  },
};
