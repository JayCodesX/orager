import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ToolExecutor, ToolParameterSchema, ToolResult } from "./types.js";

export interface SkillEntry {
  name: string;
  description: string;
  content: string;
  /** Shell command template; if set this skill is exposed as a callable tool. */
  exec?: string;
  /** Tool parameter schema for callable skills. */
  parameters?: ToolParameterSchema;
}

// ── Frontmatter parsing ──────────────────────────────────────────────────────

interface Frontmatter {
  description: string;
  exec?: string;
  parameters?: ToolParameterSchema;
}

function extractFrontmatter(raw: string): Frontmatter {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("---")) return { description: "" };

  const afterOpen = trimmed.slice(3);
  const closeIdx = afterOpen.indexOf("---");
  if (closeIdx === -1) return { description: "" };

  const block = afterOpen.slice(0, closeIdx);

  let description = "";
  let exec: string | undefined;
  let parameters: ToolParameterSchema | undefined;

  for (const line of block.split(/\r?\n/)) {
    const descMatch = line.match(/^description\s*:\s*(.+)$/);
    if (descMatch) {
      description = descMatch[1].trim().replace(/^['"]|['"]$/g, "");
      continue;
    }

    const execMatch = line.match(/^exec\s*:\s*(.+)$/);
    if (execMatch) {
      exec = execMatch[1].trim().replace(/^['"]|['"]$/g, "");
      continue;
    }

    const paramsMatch = line.match(/^parameters\s*:\s*(\{.+\})$/);
    if (paramsMatch) {
      try {
        parameters = JSON.parse(paramsMatch[1]) as ToolParameterSchema;
      } catch {
        // ignore malformed parameters line
      }
    }
  }

  return { description, exec, parameters };
}

// ── Directory loading ────────────────────────────────────────────────────────

export async function loadSkillsFromDirs(addDirs: string[]): Promise<SkillEntry[]> {
  const skills: SkillEntry[] = [];

  for (const dir of addDirs) {
    const skillsRoot = path.join(dir, ".orager", "skills");

    let skillDirs: string[];
    try {
      const entries = await fs.readdir(skillsRoot, { withFileTypes: true });
      skillDirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue;
    }

    for (const skillName of skillDirs) {
      const skillFile = path.join(skillsRoot, skillName, "SKILL.md");

      let content: string;
      try {
        content = await fs.readFile(skillFile, "utf8");
      } catch {
        continue;
      }

      const fm = extractFrontmatter(content);

      skills.push({
        name: skillName,
        description: fm.description,
        content,
        exec: fm.exec,
        parameters: fm.parameters,
      });
    }
  }

  return skills;
}

// ── System prompt builder (prompt-only skills) ────────────────────────────────

export function buildSkillsSystemPrompt(skills: SkillEntry[]): string {
  const promptSkills = skills.filter((s) => !s.exec);
  if (promptSkills.length === 0) return "";

  const lines: string[] = [
    "## Available Skills",
    "",
    "The following skills are available to you:",
    "",
  ];

  for (const skill of promptSkills) {
    if (skill.description) {
      lines.push(`- **${skill.name}**: ${skill.description}`);
    } else {
      lines.push(`- **${skill.name}**`);
    }
  }

  return lines.join("\n");
}

// ── Skill tool builder (exec-capable skills) ─────────────────────────────────

const DEFAULT_EXEC_TIMEOUT_MS = 30_000;

function runShell(
  cmd: string,
  cwd: string,
  timeoutMs = DEFAULT_EXEC_TIMEOUT_MS
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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

/**
 * Returns `ToolExecutor` instances for skills that have an `exec` field.
 * Tool names are normalised: dashes are replaced with underscores.
 */
export function buildSkillTools(skills: SkillEntry[]): ToolExecutor[] {
  return skills
    .filter((s) => s.exec != null)
    .map((skill): ToolExecutor => ({
      definition: {
        type: "function",
        function: {
          name: skill.name.replace(/-/g, "_"),
          description: skill.description || skill.name,
          parameters: skill.parameters ?? { type: "object", properties: {} },
        },
      },
      async execute(input: Record<string, unknown>, cwd: string): Promise<ToolResult> {
        const cmd = interpolate(skill.exec!, input);
        const { stdout, stderr, exitCode } = await runShell(cmd, cwd);
        let content = stdout;
        if (stderr) content += (content ? "\n" : "") + `[stderr] ${stderr}`;
        if (!content) content = exitCode === 0 ? "(no output)" : `exited with code ${exitCode}`;
        return { toolCallId: "", content, isError: exitCode !== 0 };
      },
    }));
}
