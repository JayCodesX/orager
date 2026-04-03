import { stat, readFile } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import type { ToolExecuteOptions, ToolExecutor, ToolResult } from "../types.js";
import { assertPathAllowed } from "../sandbox.js";

const MAX_OUTPUT_CHARS = 50_000;

/**
 * Maximum file size allowed for a single read_file call.
 * Prevents heap exhaustion when an agent reads a large binary or archive.
 * Override via ORAGER_MAX_READ_FILE_BYTES (bytes).
 */
const MAX_READ_FILE_BYTES =
  parseInt(process.env["ORAGER_MAX_READ_FILE_BYTES"] ?? "", 10) ||
  50 * 1024 * 1024; // 50 MB default

export const readFileTool: ToolExecutor = {
  definition: {
    type: "function",
    readonly: true,
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

    // Guard against reading excessively large files that would exhaust heap.
    // stat() before readFile so we fail fast before allocating the buffer.
    try {
      const info = await stat(filePath);
      if (info.size > MAX_READ_FILE_BYTES) {
        const fileMb = (info.size / (1024 * 1024)).toFixed(1);
        const limitMb = (MAX_READ_FILE_BYTES / (1024 * 1024)).toFixed(0);
        return {
          toolCallId: "",
          content: `File is ${fileMb} MB which exceeds the ${limitMb} MB read limit. Use start_line/end_line to read a specific range, or increase ORAGER_MAX_READ_FILE_BYTES.`,
          isError: true,
        };
      }
    } catch {
      // stat failed (e.g. file does not exist) — fall through to readFile
      // which will return a clearer ENOENT error.
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
      // Full-file read: always include line numbers for easier reference
      const lines = raw.split("\n");
      content = lines
        .map((line, i) => `${String(i + 1).padStart(6)}→ ${line}`)
        .join("\n");
    }

    if (content.length > MAX_OUTPUT_CHARS) {
      content = content.slice(0, MAX_OUTPUT_CHARS) + "\n[truncated]";
    }

    return { toolCallId: "", content, isError: false };
  },
};
