import { spawn } from "node:child_process";
import type { ToolExecutor, ToolResult } from "../types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_CHARS = 100_000;

export const bashTool: ToolExecutor = {
  definition: {
    type: "function",
    function: {
      name: "bash",
      description:
        "Execute a bash command in the working directory. Use for running tests, installing packages, checking git status, reading command output, etc.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The bash command to execute",
          },
          timeout_ms: {
            type: "number",
            description:
              "Timeout in milliseconds (default 30000, max 300000)",
          },
        },
        required: ["command"],
      },
    },
  },

  async execute(
    input: Record<string, unknown>,
    cwd: string,
    context?: Record<string, unknown>
  ): Promise<ToolResult> {
    if (typeof input["command"] !== "string" || !input["command"]) {
      return { toolCallId: "", content: "command must be a non-empty string", isError: true };
    }
    const command = input["command"];
    const rawTimeout =
      typeof input["timeout_ms"] === "number"
        ? (input["timeout_ms"] as number)
        : DEFAULT_TIMEOUT_MS;
    if (rawTimeout < 0) {
      return { toolCallId: "", content: "timeout_ms must be non-negative", isError: true };
    }
    const timeoutMs = Math.min(rawTimeout, MAX_TIMEOUT_MS);

    // ── Bash policy: command blocklist ────────────────────────────────────
    const bashPolicy = (context as { sandboxRoot?: string; bashPolicy?: { blockedCommands?: string[]; stripEnvKeys?: string[]; isolateEnv?: boolean; allowedEnvKeys?: string[] } })?.bashPolicy;
    if (bashPolicy?.blockedCommands && bashPolicy.blockedCommands.length > 0) {
      // Build a set of lowercase blocked command names for fast lookup
      const blockedSet = new Set(bashPolicy.blockedCommands.map((b) => b.toLowerCase()));

      // Helper: extract all "executable positions" from a shell command string.
      // We look for: the first word, words after | ; & ( ` and after $( constructs.
      // This covers the most common bypass patterns without a full shell parser.
      function extractExecutables(cmd: string): string[] {
        // Tokenize: split on shell metacharacters that introduce new commands
        // |, ;, &&, ||, &, (, `, $(  — each one resets the "first word" context.
        const tokens = cmd
          .split(/[|;&`()\n]|\$\(/)
          .map((t) => t.trimStart())
          .filter(Boolean);
        const execs: string[] = [];
        for (const token of tokens) {
          // Skip variable assignments (VAR=value cmd) by skipping leading KEY=VALUE tokens
          let rest = token;
          while (/^\w+=\S*\s/.test(rest)) {
            rest = rest.replace(/^\w+=\S*\s+/, "");
          }
          const first = rest.split(/\s+/)[0];
          if (first) {
            // Normalize path (e.g. /usr/bin/curl → curl)
            execs.push(first.toLowerCase().split("/").pop() ?? first.toLowerCase());
          }
        }
        return execs;
      }

      const execs = extractExecutables(command);
      // Also check for eval / exec which can wrap any command
      const hasEval = /\beval\b|\bexec\b/.test(command);
      const blocked = execs.find((e) => blockedSet.has(e));

      if (blocked) {
        return {
          toolCallId: "",
          content: `Command '${blocked}' is blocked by bash policy`,
          isError: true,
        };
      }

      if (hasEval) {
        // Check if the eval/exec might be invoking a blocked command
        // Since we can't safely parse the eval string statically, block if
        // any blocked command name appears anywhere in the command after eval/exec
        const afterEval = command.replace(/^[^;|&]*\beval\b/i, "").replace(/^[^;|&]*\bexec\b/i, "");
        const evalExecs = extractExecutables(afterEval);
        const evalBlocked = evalExecs.find((e) => blockedSet.has(e)) ?? (blockedSet.has("eval") ? "eval" : null);
        if (evalBlocked) {
          return {
            toolCallId: "",
            content: `Command '${evalBlocked}' is blocked by bash policy (detected in eval/exec context)`,
            isError: true,
          };
        }
      }
    }

    // ── Bash policy: environment isolation ───────────────────────────────
    let spawnEnv: NodeJS.ProcessEnv | undefined = undefined;
    if (bashPolicy) {
      if (bashPolicy.isolateEnv) {
        // Keep only safe defaults + explicitly allowed keys
        const SAFE_KEYS = new Set(["PATH", "HOME", "USER", "SHELL", "LANG", "TERM", "PWD", "TMPDIR", "TZ"]);
        const allowed = new Set([...SAFE_KEYS, ...(bashPolicy.allowedEnvKeys ?? []).map((k) => k.toUpperCase())]);
        spawnEnv = {};
        for (const [k, v] of Object.entries(process.env)) {
          if (allowed.has(k.toUpperCase()) && v !== undefined) {
            spawnEnv[k] = v;
          }
        }
      } else if (bashPolicy.stripEnvKeys && bashPolicy.stripEnvKeys.length > 0) {
        // Strip matching keys from the inherited environment
        spawnEnv = { ...process.env };
        const patterns = bashPolicy.stripEnvKeys.map((p) => p.toLowerCase());
        for (const k of Object.keys(spawnEnv)) {
          const kl = k.toLowerCase();
          if (patterns.some((p) => kl.includes(p))) {
            delete spawnEnv[k];
          }
        }
      }
    }

    return new Promise<ToolResult>((resolve) => {
      const chunks: string[] = [];
      let timedOut = false;
      let killTimer: ReturnType<typeof setTimeout> | null = null;

      const proc = spawn("bash", ["-c", command], {
        cwd,
        env: spawnEnv ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });

      // Unref so the child doesn't keep the parent process alive
      proc.unref();

      proc.stdout.on("data", (data: Buffer) => {
        chunks.push(data.toString());
      });

      proc.stderr.on("data", (data: Buffer) => {
        const lines = data.toString().split("\n");
        const prefixed = lines
          .map((l, i) =>
            i === lines.length - 1 && l === "" ? "" : `[stderr] ${l}`
          )
          .join("\n");
        chunks.push(prefixed);
      });

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        // Kill the entire process group to clean up bash subprocesses
        const pid = proc.pid;
        if (pid && pid > 1) {
          try { process.kill(-pid, "SIGTERM"); } catch { proc.kill("SIGTERM"); }
        } else {
          proc.kill("SIGTERM");
        }
        killTimer = setTimeout(() => {
          if (pid && pid > 1) {
            try { process.kill(-pid, "SIGKILL"); } catch { /* already exited */ }
          } else {
            try { proc.kill("SIGKILL"); } catch { /* already exited */ }
          }
        }, 2_000);
      }, timeoutMs);

      proc.on("close", (code) => {
        clearTimeout(timeoutHandle);
        if (killTimer !== null) clearTimeout(killTimer);

        if (timedOut) {
          resolve({
            toolCallId: "",
            content: `[timed out after ${timeoutMs}ms]\n${buildOutput(chunks)}`,
            isError: true,
          });
          return;
        }

        const output = buildOutput(chunks);
        const isError = code !== 0 && code !== null;
        resolve({ toolCallId: "", content: output, isError });
      });

      proc.on("error", (err) => {
        clearTimeout(timeoutHandle);
        if (killTimer !== null) clearTimeout(killTimer);
        resolve({
          toolCallId: "",
          content: `Failed to spawn process: ${err.message}`,
          isError: true,
        });
      });
    });
  },
};

function buildOutput(chunks: string[]): string {
  let output = chunks.join("");
  if (output.length > MAX_OUTPUT_CHARS) {
    output = output.slice(0, MAX_OUTPUT_CHARS) + "\n[output truncated]";
  }
  return output;
}
