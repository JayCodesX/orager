import { spawn, spawnSync } from "node:child_process";
import type { ToolExecutor, ToolResult } from "../types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_CHARS = 100_000;

// ── Platform availability ─────────────────────────────────────────────────────

let _bashAvailable: boolean | null = null;

/**
 * Returns true if a bash-compatible shell is available.
 * On non-Windows platforms, always returns true.
 * On Windows, checks whether `bash` or `sh` are in PATH using `where`.
 * Result is cached after the first call.
 */
export function isBashAvailable(): boolean {
  if (_bashAvailable !== null) return _bashAvailable;
  if (process.platform !== "win32") {
    _bashAvailable = true;
    return true;
  }
  // On Windows, check if bash or sh is available via `where`
  for (const shell of ["bash", "sh"]) {
    try {
      const result = spawnSync("where", [shell], { encoding: "utf8", timeout: 5000 });
      if (result.status === 0 && result.stdout.trim()) {
        _bashAvailable = true;
        return true;
      }
    } catch {
      // ignore
    }
  }
  _bashAvailable = false;
  return false;
}

/** Reset cached bash availability — for testing only. */
export function _resetBashAvailabilityForTesting(): void {
  _bashAvailable = null;
}

/**
 * Check if a command string contains a blocked command, using a set of
 * hardening techniques that go beyond simple executable extraction:
 *
 * 1. `bash -c <arg>` / `sh -c <arg>` — recursively check the inline arg
 * 2. `. <file>` / `source <file>` — always blocked when any policy is active
 * 3. Process substitution `<(...)` — check content inside for blocked commands
 * 4. Substring scan — any blocked term appearing anywhere in the full command
 *
 * Returns the name of the first blocked command found, or null if clean.
 */
export function containsBlockedCommand(cmd: string, blocked: Set<string>): string | null {
  // 1. bash -c / sh -c — extract the inline argument and recurse
  const shellCMatch = /(?:^|\s)(?:bash|sh|dash|zsh|ksh|csh|fish)\s+-[^c]*c\s+(['"]?)(.+?)\1(?:\s|$)/s.exec(cmd);
  if (shellCMatch) {
    const inlineArg = shellCMatch[2] ?? "";
    const inner = containsBlockedCommand(inlineArg, blocked);
    if (inner) return inner;
  }

  // 2. source / . (dot) — always block when any bash policy is active
  if (/(?:^|[;|&()\s`])(?:source|\.)\s+\S/.test(cmd)) {
    return "source";
  }

  // 3. Process substitution <(...) — check content inside
  const procSubRe = /<\(([^)]+)\)/g;
  let procMatch: RegExpExecArray | null;
  while ((procMatch = procSubRe.exec(cmd)) !== null) {
    const inner = containsBlockedCommand(procMatch[1] ?? "", blocked);
    if (inner) return inner;
  }

  // 4. Substring scan — catch any occurrence of a blocked term in the full command
  const cmdLower = cmd.toLowerCase();
  for (const term of blocked) {
    if (cmdLower.includes(term)) {
      // Only match if it appears as a word boundary to reduce false positives
      // (e.g. "rmdir" should not trigger "rm" block unless "rmdir" is also blocked)
      const wordBoundaryRe = new RegExp(`(?:^|[^a-z0-9_/-])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[^a-z0-9_]|$)`);
      if (wordBoundaryRe.test(cmdLower)) return term;
    }
  }

  return null;
}

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
    // ── Platform availability check ────────────────────────────────────────
    if (!isBashAvailable()) {
      return {
        toolCallId: "",
        content: "bash tool is not available on this platform without Git Bash or WSL",
        isError: true,
      };
    }

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
        // Check if the eval/exec might be invoking a blocked command.
        // Split on shell separators so eval appearing after a semicolon,
        // pipe, or && is still caught (e.g. "safe_cmd; eval blocked_cmd").
        // For each segment that starts with eval/exec, extract the rest of
        // that segment and check its executables.
        const segments = command.split(/[;|&`()\n]|\$\(/).map((s) => s.trimStart());
        const evalExecs: string[] = [];
        for (const seg of segments) {
          if (/^\s*(?:eval|exec)\b/i.test(seg)) {
            // Grab everything after the eval/exec keyword as the inner command
            const inner = seg.replace(/^\s*(?:eval|exec)\s+/i, "");
            evalExecs.push(...extractExecutables(inner));
          }
        }
        const evalBlocked = evalExecs.find((e) => blockedSet.has(e)) ?? (blockedSet.has("eval") ? "eval" : null);
        if (evalBlocked) {
          return {
            toolCallId: "",
            content: `Command '${evalBlocked}' is blocked by bash policy (detected in eval/exec context)`,
            isError: true,
          };
        }
      }

      // Hardened bypass checks: shell -c, source/., process substitution, substring
      const hardenedBlocked = containsBlockedCommand(command, blockedSet);
      if (hardenedBlocked) {
        return {
          toolCallId: "",
          content: `Command '${hardenedBlocked}' is blocked by bash policy`,
          isError: true,
        };
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
