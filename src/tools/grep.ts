/**
 * grep tool — fast content search using ripgrep (rg) with grep fallback.
 *
 * Tries `rg` first; falls back to `grep -r` if rg is not in PATH.
 * Respects .gitignore automatically when using rg.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { ToolExecutor, ToolExecuteOptions, ToolResult } from "../types.js";
import { assertPathAllowed } from "../sandbox.js";

const execAsync = promisify(execFile);
const TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 100_000;

let _hasRg: boolean | null = null;

async function hasRipgrep(): Promise<boolean> {
  if (_hasRg !== null) return _hasRg;
  try {
    await execAsync("rg", ["--version"], { timeout: 3000 });
    _hasRg = true;
  } catch {
    _hasRg = false;
  }
  return _hasRg;
}

export const grepTool: ToolExecutor = {
  definition: {
    type: "function",
    readonly: true,
    function: {
      name: "grep",
      description:
        "Search for a pattern in files using ripgrep (rg) or grep. " +
        "Returns matching lines with file paths and line numbers. " +
        "Supports context lines (-C), file glob filtering, and case-insensitive mode; respects .gitignore when using rg.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Regular expression pattern to search for",
          },
          path: {
            type: "string",
            description: "File or directory to search in (default: current working directory)",
          },
          include: {
            type: "string",
            description: "Glob pattern to filter files (e.g. '*.ts', '*.{js,ts}')",
          },
          case_sensitive: {
            type: "boolean",
            description: "Whether the search is case-sensitive (default: true)",
          },
          files_only: {
            type: "boolean",
            description: "When true, only return file names that contain matches (not the matching lines)",
          },
          context_lines: {
            type: "number",
            description: "Number of context lines to show before and after each match (default: 0)",
          },
        },
        required: ["pattern"],
      },
    },
  },
  async execute(input: Record<string, unknown>, cwd: string, opts?: ToolExecuteOptions): Promise<ToolResult> {
    const pattern = input["pattern"] as string;
    if (typeof pattern !== "string" || !pattern) {
      return { toolCallId: "", content: "pattern must be a non-empty string", isError: true };
    }

    const searchPath = typeof input["path"] === "string" ? input["path"] : ".";
    const absPath = path.isAbsolute(searchPath) ? searchPath : path.join(cwd, searchPath);

    if (opts?.sandboxRoot) {
      try { assertPathAllowed(absPath, opts.sandboxRoot); } catch (e) {
        return { toolCallId: "", content: String(e), isError: true };
      }
    }

    const caseSensitive = input["case_sensitive"] !== false;
    const filesOnly = input["files_only"] === true;
    const contextLines = typeof input["context_lines"] === "number" ? Math.max(0, Math.min(10, input["context_lines"] as number)) : 0;
    const include = typeof input["include"] === "string" ? input["include"] : undefined;

    const useRg = await hasRipgrep();

    let stdout = "";
    let stderr = "";

    try {
      if (useRg) {
        const args: string[] = [
          "--line-number",
          "--no-heading",
          "--color=never",
        ];
        if (!caseSensitive) args.push("--ignore-case");
        if (filesOnly) args.push("--files-with-matches");
        if (contextLines > 0) args.push(`--context=${contextLines}`);
        if (include) args.push(`--glob=${include}`);
        args.push(pattern, absPath);

        const result = await execAsync("rg", args, { cwd, timeout: TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 });
        stdout = result.stdout;
        stderr = result.stderr;
      } else {
        const args: string[] = ["-r", "-n", "--color=never"];
        if (!caseSensitive) args.push("-i");
        if (filesOnly) args.push("-l");
        if (contextLines > 0) args.push(`-C${contextLines}`);
        if (include) args.push(`--include=${include}`);
        args.push(pattern, absPath);

        const result = await execAsync("grep", args, { cwd, timeout: TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 });
        stdout = result.stdout;
        stderr = result.stderr;
      }
    } catch (err: unknown) {
      // exit code 1 from grep/rg means "no matches" — not an error
      const execErr = err as { code?: number; stdout?: string; stderr?: string };
      if (execErr.code === 1) {
        return { toolCallId: "", content: "No matches found.", isError: false };
      }
      return {
        toolCallId: "",
        content: `grep error: ${execErr.stderr || (err instanceof Error ? err.message : String(err))}`,
        isError: true,
      };
    }

    let output = stdout;
    if (!output && stderr) output = stderr;
    if (!output) return { toolCallId: "", content: "No matches found.", isError: false };

    if (output.length > MAX_OUTPUT_CHARS) {
      output = output.slice(0, MAX_OUTPUT_CHARS) + `\n…(truncated — ${output.length - MAX_OUTPUT_CHARS} more chars)`;
    }

    return { toolCallId: "", content: output.trimEnd(), isError: false };
  },
};
