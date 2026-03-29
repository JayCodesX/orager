import type { ToolExecutor, ToolExecuteOptions, ToolResult } from "../types.js";
import fs from "node:fs/promises";
import path from "node:path";
import { assertPathAllowed } from "../sandbox.js";

interface EditOperation {
  old_string: string;
  new_string: string;
}

export const editFileTool: ToolExecutor = {
  definition: {
    type: "function",
    readonly: false,
    function: {
      name: "edit_file",
      description:
        "Make precise edits to a file by replacing exact strings. " +
        "Each edit replaces one occurrence of old_string with new_string. " +
        "old_string must match the file content exactly (including whitespace and indentation). " +
        "Use read_file first to see the current content. " +
        "Prefer this over write_file for targeted changes — it is faster and less error-prone.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file to edit (relative to cwd or absolute)",
          },
          edits: {
            type: "array",
            description: "List of { old_string, new_string } replacements to apply in order",
            items: {
              type: "object",
              properties: {
                old_string: {
                  type: "string",
                  description: "The exact string to find (must appear exactly once in the file)",
                },
                new_string: {
                  type: "string",
                  description: "The string to replace it with",
                },
              },
              required: ["old_string", "new_string"],
            },
          },
          create_if_missing: {
            type: "boolean",
            description:
              "When true and the file does not exist, create it with new_string from the first edit " +
              "(old_string is ignored for creation). Useful for scaffolding new files.",
          },
        },
        required: ["path", "edits"],
      },
    },
  },

  async execute(input: Record<string, unknown>, cwd: string, opts?: ToolExecuteOptions): Promise<ToolResult> {
    if (typeof input["path"] !== "string" || !input["path"]) {
      return { toolCallId: "", content: "path must be a non-empty string", isError: true };
    }
    if (!Array.isArray(input["edits"]) || input["edits"].length === 0) {
      return { toolCallId: "", content: "edits must be a non-empty array", isError: true };
    }

    const filePath = path.isAbsolute(input["path"] as string)
      ? (input["path"] as string)
      : path.join(cwd, input["path"] as string);

    if (opts?.sandboxRoot) {
      try { assertPathAllowed(filePath, opts.sandboxRoot); } catch (e) {
        return { toolCallId: "", content: String(e), isError: true };
      }
    }

    const edits = input["edits"] as EditOperation[];
    const createIfMissing = input["create_if_missing"] === true;

    // Validate edit shape
    for (let i = 0; i < edits.length; i++) {
      const e = edits[i];
      if (typeof e.old_string !== "string" || typeof e.new_string !== "string") {
        return {
          toolCallId: "",
          content: `edits[${i}] must have string old_string and new_string`,
          isError: true,
        };
      }
    }

    let content: string;

    // Read existing file (or create new one)
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT" && createIfMissing) {
        // Create file with first edit's new_string
        const newContent = edits[0].new_string;
        try {
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          await fs.writeFile(filePath, newContent, { encoding: "utf8", mode: 0o644 });
          return {
            toolCallId: "",
            content: `Created ${input["path"]} (${newContent.length} chars)`,
            isError: false,
          };
        } catch (writeErr) {
          return {
            toolCallId: "",
            content: `Failed to create file: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`,
            isError: true,
          };
        }
      }
      return {
        toolCallId: "",
        content: `Cannot read file: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }

    // Apply edits in order
    for (let i = 0; i < edits.length; i++) {
      const { old_string, new_string } = edits[i];

      if (old_string === "") {
        return {
          toolCallId: "",
          content: `edits[${i}].old_string is empty — use write_file to replace entire file contents`,
          isError: true,
        };
      }

      // Count occurrences to enforce exactly-once constraint
      let count = 0;
      let searchFrom = 0;
      while (true) {
        const idx = content.indexOf(old_string, searchFrom);
        if (idx === -1) break;
        count++;
        searchFrom = idx + 1;
        if (count > 1) break; // No need to count further
      }

      if (count === 0) {
        // Provide a helpful diff-style context for debugging
        const lines = old_string.split("\n").slice(0, 3).join("↵");
        return {
          toolCallId: "",
          content:
            `edits[${i}]: old_string not found in file.\n` +
            `Looking for: ${lines.length > 120 ? lines.slice(0, 120) + "…" : lines}\n` +
            `Hint: use read_file to see the current content, then match exactly (including indentation).`,
          isError: true,
        };
      }

      if (count > 1) {
        return {
          toolCallId: "",
          content:
            `edits[${i}]: old_string appears ${count} times — must be unique. ` +
            `Add more surrounding context to make it unambiguous.`,
          isError: true,
        };
      }

      content = content.replace(old_string, () => new_string);
    }

    // Write back
    try {
      await fs.writeFile(filePath, content, { encoding: "utf8" });
    } catch (err) {
      return {
        toolCallId: "",
        content: `Failed to write file: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }

    const editSummary = edits.length === 1
      ? `1 edit applied`
      : `${edits.length} edits applied`;

    return {
      toolCallId: "",
      content: `${editSummary} to ${input["path"]}`,
      isError: false,
    };
  },
};
