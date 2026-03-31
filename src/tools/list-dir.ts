import { readdir } from "node:fs/promises";
import { resolve, isAbsolute, join } from "node:path";
import type { ToolExecuteOptions, ToolExecutor, ToolResult } from "../types.js";
import { assertPathAllowed } from "../sandbox.js";

const MAX_ENTRIES = 200;
const MAX_DEPTH = 4;
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", ".next",
  "build", "__pycache__", ".venv", "venv", ".tox",
  "target", "out", "coverage", ".cache", ".parcel-cache",
  "__snapshots__", ".pytest_cache", "vendor",
]);

export const listDirTool: ToolExecutor = {
  definition: {
    type: "function",
    readonly: true,
    function: {
      name: "list_dir",
      description: "List files and directories at a path.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Directory path, absolute or relative to cwd",
          },
          recursive: {
            type: "boolean",
            description:
              "If true, list recursively (max depth 4, skips node_modules/.git/dist/.next/build/__pycache__/.venv/venv/target/out/coverage/vendor and similar)",
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
    const recursive = input["recursive"] === true;

    const dirPath = isAbsolute(inputPath)
      ? inputPath
      : resolve(cwd, inputPath);

    if (opts?.sandboxRoot) {
      try {
        assertPathAllowed(dirPath, opts.sandboxRoot);
      } catch (err) {
        return { toolCallId: "", content: err instanceof Error ? err.message : String(err), isError: true };
      }
    }

    const lines: string[] = [];
    let totalEntries = 0;
    let truncated = false;

    try {
      if (recursive) {
        const state: WalkState = { totalEntries: 0, truncated: false };
        await walkDir(dirPath, 0, lines, state);
        totalEntries = state.totalEntries;
        truncated = state.truncated;
      } else {
        const entries = await readdir(dirPath, { withFileTypes: true });
        for (const entry of entries) {
          if (totalEntries >= MAX_ENTRIES) {
            truncated = true;
            break;
          }
          if (entry.isDirectory()) {
            lines.push(`  [dir]  ${entry.name}/`);
          } else {
            lines.push(`  [file] ${entry.name}`);
          }
          totalEntries++;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { toolCallId: "", content: msg, isError: true };
    }

    const remaining = totalEntries > MAX_ENTRIES ? totalEntries - MAX_ENTRIES : 0;
    let output = `${dirPath}:\n${lines.join("\n")}`;
    if (truncated) {
      output += `\n[... ${remaining} more entries]`;
    }

    return { toolCallId: "", content: output, isError: false };
  },
};

interface WalkState {
  totalEntries: number;
  truncated: boolean;
}

async function walkDir(
  dirPath: string,
  depth: number,
  lines: string[],
  state: WalkState
): Promise<void> {
  if (depth > MAX_DEPTH || state.truncated) return;

  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    // L-06: Log non-ENOENT readdir failures for debugging; ENOENT is expected
    // for directories that disappear during traversal.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      process.stderr.write(`[orager] list-dir: cannot read directory ${dirPath}: ${code ?? err}\n`);
    }
    return;
  }

  const indent = "  ".repeat(depth + 1);

  for (const entry of entries) {
    if (state.totalEntries >= MAX_ENTRIES) {
      state.truncated = true;
      return;
    }

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      lines.push(`${indent}[dir]  ${entry.name}/`);
      state.totalEntries++;
      await walkDir(join(dirPath, entry.name), depth + 1, lines, state);
    } else {
      lines.push(`${indent}[file] ${entry.name}`);
      state.totalEntries++;
    }
  }
}
