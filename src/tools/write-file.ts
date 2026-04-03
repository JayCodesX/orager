import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, isAbsolute, dirname } from "node:path";
import type { ToolExecuteOptions, ToolExecutor, ToolResult } from "../types.js";
import { assertPathAllowed } from "../sandbox.js";

/**
 * Maximum content size for a single write_file call (in bytes, UTF-8 encoded).
 * Prevents agents from filling the disk with unbounded writes.
 * Override via ORAGER_MAX_WRITE_FILE_BYTES.
 */
const MAX_WRITE_FILE_BYTES =
  parseInt(process.env["ORAGER_MAX_WRITE_FILE_BYTES"] ?? "", 10) ||
  100 * 1024 * 1024; // 100 MB default

// ---------------------------------------------------------------------------
// write_file — full file write
// ---------------------------------------------------------------------------

export const writeFileTool: ToolExecutor = {
  definition: {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Write content to a file, creating it (and any missing parent directories) if needed. Overwrites existing content.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File path, absolute or relative to cwd",
          },
          content: {
            type: "string",
            description: "Full file content to write",
          },
        },
        required: ["path", "content"],
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
    if (typeof input["content"] !== "string") {
      return { toolCallId: "", content: "content must be a string", isError: true };
    }
    const inputPath = input["path"];
    const content = input["content"];

    // Guard against disk exhaustion from unbounded writes.
    // Check encoded byte length — not JS string length — because multi-byte
    // characters in UTF-8 can make the on-disk size larger than content.length.
    const contentBytes = Buffer.byteLength(content, "utf-8");
    if (contentBytes > MAX_WRITE_FILE_BYTES) {
      const fileMb = (contentBytes / (1024 * 1024)).toFixed(1);
      const limitMb = (MAX_WRITE_FILE_BYTES / (1024 * 1024)).toFixed(0);
      return {
        toolCallId: "",
        content: `Content is ${fileMb} MB which exceeds the ${limitMb} MB write limit (ORAGER_MAX_WRITE_FILE_BYTES).`,
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

    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, content, "utf-8");
      return {
        toolCallId: "",
        content: `Successfully wrote ${filePath}`,
        isError: false,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { toolCallId: "", content: msg, isError: true };
    }
  },
};

// ---------------------------------------------------------------------------
// str_replace — surgical single-occurrence replacement
// ---------------------------------------------------------------------------

export const strReplaceTool: ToolExecutor = {
  definition: {
    type: "function",
    function: {
      name: "str_replace",
      description:
        "Replace an exact, unique string in a file with a new string. The old_str must appear exactly once in the file.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File path, absolute or relative to cwd",
          },
          old_str: {
            type: "string",
            description:
              "Exact string to replace (must be unique in the file)",
          },
          new_str: {
            type: "string",
            description: "Replacement string",
          },
        },
        required: ["path", "old_str", "new_str"],
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
    if (typeof input["old_str"] !== "string") {
      return { toolCallId: "", content: "old_str must be a string", isError: true };
    }
    if (typeof input["new_str"] !== "string") {
      return { toolCallId: "", content: "new_str must be a string", isError: true };
    }
    const inputPath = input["path"];
    const oldStr = input["old_str"];
    const newStr = input["new_str"];

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

    let fileContent: string;
    try {
      fileContent = await readFile(filePath, "utf-8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { toolCallId: "", content: msg, isError: true };
    }

    // Count occurrences without regex so special characters are handled safely
    let count = 0;
    let searchStart = 0;
    while (true) {
      const idx = fileContent.indexOf(oldStr, searchStart);
      if (idx === -1) break;
      count++;
      searchStart = idx + oldStr.length;
    }

    if (count === 0) {
      return {
        toolCallId: "",
        content: `old_str not found in file: ${filePath}`,
        isError: true,
      };
    }

    if (count > 1) {
      return {
        toolCallId: "",
        content: `old_str appears ${count} times in ${filePath} — make it unique`,
        isError: true,
      };
    }

    // Use a replacer function so $& / $' / $` patterns in newStr are treated literally
    const updated = fileContent.replace(oldStr, () => newStr);

    try {
      await writeFile(filePath, updated, "utf-8");
      return {
        toolCallId: "",
        content: `Successfully replaced string in ${filePath}`,
        isError: false,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { toolCallId: "", content: msg, isError: true };
    }
  },
};
