import { readFile } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import type { ToolExecuteOptions, ToolExecutor, ToolResult } from "../types.js";
import { assertPathAllowed } from "../sandbox.js";

const MAX_OUTPUT_CHARS = 50_000;

export const readFileTool: ToolExecutor = {
  definition: {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a file. Returns the file content as text.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File path, absolute or relative to cwd",
          },
          start_line: {
            type: "number",
            description: "First line to read (1-indexed, inclusive)",
          },
          end_line: {
            type: "number",
            description: "Last line to read (1-indexed, inclusive)",
          },
        },
        required: ["path"],
      },
    },
  },

  async execute(
    input: Record<string, unknown>,
    cwd: string,
    opts?: ToolExecuteOptions
  ): Promise<ToolResult> {
    if (typeof input["path"] !== "string" || !input["path"]) {
      return { toolCallId: "", content: "path must be a non-empty string", isError: true };
    }
    const inputPath = input["path"];
    const startLine =
      typeof input["start_line"] === "number"
        ? (input["start_line"] as number)
        : undefined;
    const endLine =
      typeof input["end_line"] === "number"
        ? (input["end_line"] as number)
        : undefined;

    if (startLine !== undefined && startLine < 1) {
      return { toolCallId: "", content: "start_line must be >= 1", isError: true };
    }
    if (endLine !== undefined && endLine < 1) {
      return { toolCallId: "", content: "end_line must be >= 1", isError: true };
    }
    if (startLine !== undefined && endLine !== undefined && startLine > endLine) {
      return {
        toolCallId: "",
        content: `start_line (${startLine}) must not exceed end_line (${endLine})`,
        isError: true,
      };
    }

    const filePath = isAbsolute(inputPath)
      ? inputPath
      : resolve(cwd, inputPath);

    if (opts?.sandboxRoot) {
      try {
        assertPathAllowed(filePath, opts.sandboxRoot);
      } catch (err) {
        return { toolCallId: "", content: err instanceof Error ? err.message : String(err), isError: true };
      }
    }

    let raw: string;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { toolCallId: "", content: msg, isError: true };
    }

    let content: string;

    if (startLine !== undefined || endLine !== undefined) {
      const lines = raw.split("\n");
      const start = startLine !== undefined ? startLine - 1 : 0;
      const end = endLine !== undefined ? endLine : lines.length;
      const sliced = lines.slice(start, end);
      content = sliced
        .map((line, i) => {
          const lineNum = start + i + 1;
          return `${String(lineNum).padStart(6)}→ ${line}`;
        })
        .join("\n");
    } else {
      content = raw;
    }

    if (content.length > MAX_OUTPUT_CHARS) {
      content = content.slice(0, MAX_OUTPUT_CHARS) + "\n[truncated]";
    }

    return { toolCallId: "", content, isError: false };
  },
};
