import { unlink, rename, mkdir } from "node:fs/promises";
import { resolve, isAbsolute, dirname } from "node:path";
import type { ToolExecuteOptions, ToolExecutor, ToolResult } from "../types.js";
import { assertPathAllowed } from "../sandbox.js";

// ── delete_file ───────────────────────────────────────────────────────────────

export const deleteFileTool: ToolExecutor = {
  definition: {
    type: "function",
    function: {
      name: "delete_file",
      description:
        "Permanently delete a file. Use when you need to remove a file that is no longer needed. This action cannot be undone.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File path to delete, absolute or relative to cwd",
          },
        },
        required: ["path"],
      },
    },
  },

  async execute(
    input: Record<string, unknown>,
    cwd: string,
    opts?: ToolExecuteOptions,
  ): Promise<ToolResult> {
    if (typeof input["path"] !== "string" || !input["path"]) {
      return { toolCallId: "", content: "path must be a non-empty string", isError: true };
    }
    const inputPath = input["path"];
    const filePath = isAbsolute(inputPath) ? inputPath : resolve(cwd, inputPath);

    if (opts?.sandboxRoot) {
      try {
        assertPathAllowed(filePath, opts.sandboxRoot);
      } catch (err) {
        return { toolCallId: "", content: err instanceof Error ? err.message : String(err), isError: true };
      }
    }

    try {
      await unlink(filePath);
      return { toolCallId: "", content: `Deleted ${filePath}`, isError: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { toolCallId: "", content: msg, isError: true };
    }
  },
};

// ── move_file ─────────────────────────────────────────────────────────────────

export const moveFileTool: ToolExecutor = {
  definition: {
    type: "function",
    function: {
      name: "move_file",
      description:
        "Move or rename a file or directory. Works across directories on the same filesystem. " +
        "Creates the destination parent directory if it doesn't exist.",
      parameters: {
        type: "object",
        properties: {
          source: {
            type: "string",
            description: "Source path (absolute or relative to cwd)",
          },
          destination: {
            type: "string",
            description: "Destination path (absolute or relative to cwd)",
          },
        },
        required: ["source", "destination"],
      },
    },
  },

  async execute(
    input: Record<string, unknown>,
    cwd: string,
    opts?: ToolExecuteOptions,
  ): Promise<ToolResult> {
    if (typeof input["source"] !== "string" || !input["source"]) {
      return { toolCallId: "", content: "source must be a non-empty string", isError: true };
    }
    if (typeof input["destination"] !== "string" || !input["destination"]) {
      return { toolCallId: "", content: "destination must be a non-empty string", isError: true };
    }

    const srcPath = isAbsolute(input["source"]) ? input["source"] : resolve(cwd, input["source"]);
    const dstPath = isAbsolute(input["destination"]) ? input["destination"] : resolve(cwd, input["destination"]);

    if (opts?.sandboxRoot) {
      for (const p of [srcPath, dstPath]) {
        try {
          assertPathAllowed(p, opts.sandboxRoot);
        } catch (err) {
          return { toolCallId: "", content: err instanceof Error ? err.message : String(err), isError: true };
        }
      }
    }

    try {
      // Ensure destination parent exists
      await mkdir(dirname(dstPath), { recursive: true });
      await rename(srcPath, dstPath);
      return { toolCallId: "", content: `Moved ${srcPath} → ${dstPath}`, isError: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Helpful hint for cross-device moves (EXDEV)
      if ((err as NodeJS.ErrnoException).code === "EXDEV") {
        return {
          toolCallId: "",
          content: `Cannot move across filesystems (EXDEV): use bash to copy then delete, or ensure source and destination are on the same filesystem.\n${msg}`,
          isError: true,
        };
      }
      return { toolCallId: "", content: msg, isError: true };
    }
  },
};

// ── create_dir ────────────────────────────────────────────────────────────────

export const createDirTool: ToolExecutor = {
  definition: {
    type: "function",
    function: {
      name: "create_dir",
      description:
        "Create a directory (and any missing parent directories). Safe to call even if the directory already exists.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Directory path to create, absolute or relative to cwd",
          },
        },
        required: ["path"],
      },
    },
  },

  async execute(
    input: Record<string, unknown>,
    cwd: string,
    opts?: ToolExecuteOptions,
  ): Promise<ToolResult> {
    if (typeof input["path"] !== "string" || !input["path"]) {
      return { toolCallId: "", content: "path must be a non-empty string", isError: true };
    }
    const inputPath = input["path"];
    const dirPath = isAbsolute(inputPath) ? inputPath : resolve(cwd, inputPath);

    if (opts?.sandboxRoot) {
      try {
        assertPathAllowed(dirPath, opts.sandboxRoot);
      } catch (err) {
        return { toolCallId: "", content: err instanceof Error ? err.message : String(err), isError: true };
      }
    }

    try {
      await mkdir(dirPath, { recursive: true });
      return { toolCallId: "", content: `Directory ready: ${dirPath}`, isError: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { toolCallId: "", content: msg, isError: true };
    }
  },
};
