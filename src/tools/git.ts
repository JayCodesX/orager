import { spawn } from "node:child_process";
import type { ToolExecutor, ToolResult } from "../types.js";

const MAX_OUTPUT_CHARS = 50_000;
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Subcommands that are read-only — their results can safely be cached and
 * they do not modify the working tree or repository history.
 */
const READONLY_SUBCOMMANDS = new Set([
  "status", "log", "diff", "show", "branch", "tag", "remote",
  "ls-files", "ls-tree", "describe", "rev-parse", "rev-list",
  "shortlog", "blame", "grep", "stash list", "reflog",
]);

/**
 * Subcommands that are destructive and require `confirmed: true` to execute.
 * Without explicit confirmation the tool returns an error describing the risk.
 */
const DESTRUCTIVE_SUBCOMMANDS: Array<{ pattern: RegExp; description: string }> = [
  {
    pattern: /\bpush\b.*--force(-with-lease)?/,
    description: "force push can permanently overwrite remote history and destroy others' commits",
  },
  {
    pattern: /\breset\b.*--hard/,
    description: "--hard reset permanently discards all uncommitted changes in the working tree",
  },
  {
    pattern: /\bclean\b.*-[a-zA-Z]*f/,
    description: "git clean -f permanently deletes untracked files with no undo",
  },
];

function getSubcommand(args: string[]): string {
  return args[0] ?? "";
}

function isReadOnly(args: string[]): boolean {
  const sub = getSubcommand(args);
  if (READONLY_SUBCOMMANDS.has(sub)) return true;
  // `git stash list` is read-only but `git stash` alone is not
  if (sub === "stash" && args[1] === "list") return true;
  return false;
}

export const gitTool: ToolExecutor = {
  definition: {
    type: "function",
    function: {
      name: "git",
      description:
        "Run a git command in the working directory. Use for checking status/diffs, viewing history, staging files, committing, branching, and other git operations. " +
        "Pass the subcommand and arguments without the leading 'git'. " +
        "Examples: 'status', 'diff HEAD', 'diff HEAD~1 -- src/foo.ts', " +
        "'log --oneline -20', 'log --oneline --graph --decorate -30', " +
        "'add src/foo.ts', 'add -p', 'commit -m \"fix: correct off-by-one\"', " +
        "'branch', 'checkout -b feature/xyz', 'stash', 'stash pop'.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description:
              "Git subcommand and arguments (without the leading 'git'). " +
              "E.g.: 'status', 'diff HEAD', 'log --oneline -10', 'add .', 'commit -m \"message\"'",
          },
          confirmed: {
            type: "boolean",
            description:
              "Must be true to execute destructive operations: force push, --hard reset, git clean -f. " +
              "Omit or set false for normal operations.",
          },
          timeout_ms: {
            type: "number",
            description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS})`,
          },
        },
        required: ["command"],
      },
    },
  },

  async execute(
    input: Record<string, unknown>,
    cwd: string,
  ): Promise<ToolResult> {
    if (typeof input["command"] !== "string" || !input["command"].trim()) {
      return {
        toolCallId: "",
        content: "command must be a non-empty string",
        isError: true,
      };
    }

    const rawCommand = input["command"].trim();
    const confirmed = input["confirmed"] === true;
    const timeoutMs =
      typeof input["timeout_ms"] === "number"
        ? Math.min(Math.max(input["timeout_ms"], 0), 120_000)
        : DEFAULT_TIMEOUT_MS;

    // Split command into args (simple split — no shell interpretation)
    // Supports quoted strings: 'commit -m "my message"' → ['commit', '-m', 'my message']
    const args = splitArgs(rawCommand);

    if (args.length === 0) {
      return {
        toolCallId: "",
        content: "command must not be empty",
        isError: true,
      };
    }

    // Block destructive operations unless confirmed: true is explicitly passed.
    // This prevents accidental history loss or untracked-file deletion.
    for (const { pattern, description } of DESTRUCTIVE_SUBCOMMANDS) {
      if (pattern.test(rawCommand)) {
        if (!confirmed) {
          return {
            toolCallId: "",
            content:
              `Destructive git operation blocked: ${description}.\n` +
              `To proceed, re-call this tool with confirmed: true.\n` +
              `Command: git ${rawCommand}`,
            isError: true,
          };
        }
        // confirmed: true — proceed but log so the action is visible
        break;
      }
    }

    return new Promise<ToolResult>((resolve) => {
      const chunks: string[] = [];
      let timedOut = false;
      let killTimer: ReturnType<typeof setTimeout> | null = null;

      const proc = spawn("git", args, {
        cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      proc.stdout.on("data", (data: Buffer) => {
        chunks.push(data.toString());
      });

      proc.stderr.on("data", (data: Buffer) => {
        // git writes progress/info to stderr — include it but prefix
        const lines = data.toString().split("\n");
        const prefixed = lines
          .map((l, i) =>
            i === lines.length - 1 && l === "" ? "" : `[stderr] ${l}`,
          )
          .join("\n");
        chunks.push(prefixed);
      });

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGTERM");
        killTimer = setTimeout(() => {
          try { proc.kill("SIGKILL"); } catch { /* already exited */ }
        }, 2_000);
      }, timeoutMs);

      proc.on("close", (code) => {
        clearTimeout(timeoutHandle);
        if (killTimer !== null) clearTimeout(killTimer);

        if (timedOut) {
          resolve({
            toolCallId: "",
            content: `[git timed out after ${timeoutMs}ms]`,
            isError: true,
          });
          return;
        }

        let output = chunks.join("");
        if (output.length > MAX_OUTPUT_CHARS) {
          output = output.slice(0, MAX_OUTPUT_CHARS) + "\n[output truncated]";
        }

        const isError = code !== 0 && code !== null;
        resolve({
          toolCallId: "",
          content: output,
          isError,
        });
      });

      proc.on("error", (err) => {
        clearTimeout(timeoutHandle);
        if (killTimer !== null) clearTimeout(killTimer);

        const isNotFound =
          (err as NodeJS.ErrnoException).code === "ENOENT";
        resolve({
          toolCallId: "",
          content: isNotFound
            ? "git is not installed or not in PATH"
            : `Failed to spawn git: ${err.message}`,
          isError: true,
        });
      });
    });
  },
};

/**
 * Split a command string into arguments, respecting double-quoted strings.
 * e.g. 'commit -m "fix: my bug"' → ['commit', '-m', 'fix: my bug']
 */
function splitArgs(cmd: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuote = false;
  let quoteChar = "";

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (inQuote) {
      if (ch === quoteChar) {
        inQuote = false;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
    } else if (ch === " " || ch === "\t") {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }

  if (current.length > 0) args.push(current);
  return args;
}
