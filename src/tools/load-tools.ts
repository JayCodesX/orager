import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import type { ToolExecutor, ToolParameterSchema, ToolResult } from "../types.js";
import { containsBlockedCommand } from "./bash.js";

// ── JSON schema for a tool spec file entry ─────────────────────────────────

interface ToolSpec {
  name: string;
  description: string;
  parameters?: ToolParameterSchema;
  /** Shell command template; use {{paramName}} placeholders for input substitution. */
  exec: string;
}

// ── Shared helper ────────────────────────────────────────────────────────────

const DEFAULT_EXEC_TIMEOUT_MS = 30_000;

function runShell(
  cmd: string,
  cwd: string,
  timeoutMs = DEFAULT_EXEC_TIMEOUT_MS,
  blockedCommands?: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // ── Bash policy: command blocklist (mirrors bash.ts checks) ──────────
  if (blockedCommands && blockedCommands.length > 0) {
    const blockedSet = new Set(blockedCommands.map((b) => b.toLowerCase()));
    const blocked = containsBlockedCommand(cmd, blockedSet);
    if (blocked) {
      return Promise.resolve({ stdout: "", stderr: `Command blocked by bash policy: ${blocked}`, exitCode: 1 });
    }
  }

  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: { stdout: string; stderr: string; exitCode: number }) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    const stdout: string[] = [];
    const stderr: string[] = [];
    const proc = spawn("bash", ["-c", cmd], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stdout.on("data", (d: Buffer) => stdout.push(d.toString()));
    proc.stderr.on("data", (d: Buffer) => stderr.push(d.toString()));

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      settle({ stdout: stdout.join(""), stderr: `Command timed out after ${timeoutMs}ms`, exitCode: 1 });
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      settle({ stdout: stdout.join(""), stderr: stderr.join(""), exitCode: code ?? 0 });
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      settle({ stdout: "", stderr: err.message, exitCode: 1 });
    });
  });
}

/**
 * Wrap a value in single quotes for safe shell interpolation.
 * Embedded single quotes are escaped using the standard `'\''` technique.
 */
function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

/**
 * Substitute `{{param}}` placeholders in a shell command template.
 * Each value is shell-quoted to prevent injection attacks.
 */
function interpolate(template: string, input: Record<string, unknown>): string {
  let result = template;
  for (const [key, value] of Object.entries(input)) {
    result = result.replaceAll(`{{${key}}}`, shellQuote(String(value ?? "")));
  }
  return result;
}

// ── Tool spec executor builder ───────────────────────────────────────────────

function specToExecutor(spec: ToolSpec): ToolExecutor {
  return {
    definition: {
      type: "function",
      function: {
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters ?? { type: "object", properties: {} },
      },
    },
    async execute(input: Record<string, unknown>, cwd: string, opts?: Record<string, unknown>): Promise<ToolResult> {
      const cmd = interpolate(spec.exec, input);
      const bashPolicy = (opts as { bashPolicy?: { blockedCommands?: string[] } } | undefined)?.bashPolicy;
      const { stdout, stderr, exitCode } = await runShell(cmd, cwd, DEFAULT_EXEC_TIMEOUT_MS, bashPolicy?.blockedCommands);
      let content = stdout;
      if (stderr) content += (content ? "\n" : "") + `[stderr] ${stderr}`;
      if (!content) content = exitCode === 0 ? "(no output)" : `exited with code ${exitCode}`;
      return { toolCallId: "", content, isError: exitCode !== 0 };
    },
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Load extra tool executors from a JSON file.
 *
 * File format — array of objects with:
 *   { "name": string, "description": string, "exec": string, "parameters"?: {...} }
 *
 * The `exec` field is a shell command template.  Use `{{paramName}}` to
 * interpolate input parameters before execution.
 */
export async function loadToolsFromFile(filePath: string): Promise<ToolExecutor[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    throw new Error(
      `Cannot read tools file '${filePath}': ${err instanceof Error ? err.message : String(err)}`
    );
  }

  let specs: unknown;
  try {
    specs = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Invalid JSON in tools file '${filePath}': ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!Array.isArray(specs)) {
    throw new Error(`Tools file '${filePath}' must contain a JSON array`);
  }

  const tools: ToolExecutor[] = [];
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i] as Record<string, unknown>;
    if (typeof spec.name !== "string" || !spec.name) {
      throw new Error(`tools[${i}].name must be a non-empty string`);
    }
    if (typeof spec.description !== "string") {
      throw new Error(`tools[${i}].description must be a string`);
    }
    if (typeof spec.exec !== "string" || !spec.exec) {
      throw new Error(`tools[${i}].exec must be a non-empty string`);
    }
    tools.push(specToExecutor(spec as unknown as ToolSpec));
  }

  return tools;
}
