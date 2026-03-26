import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ToolExecutor, ToolParameterSchema, ToolResult } from "./types.js";

// ── Skills cache ──────────────────────────────────────────────────────────────
// Cache skill entries per directory to avoid re-reading from disk on every
// agent invocation. Cache entries are invalidated when any SKILL.md mtime
// changes or when the entry is older than SKILLS_CACHE_TTL_MS (5 minutes).
// Skills from each dir are cached independently so a change in one dir does
// not evict other dirs.

const SKILLS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface SkillsCacheEntry {
  skills: SkillEntry[];
  loadedAt: number;
  /** Concatenated "<file>:<mtime>" pairs for all SKILL.md files in the dir. */
  mtimeKey: string;
}

// Keyed by the skills root path (dir + "/.orager/skills")
const skillsCache = new Map<string, SkillsCacheEntry>();

/** Build a mtime key by stat-ing every SKILL.md under the given skillsRoot. */
async function buildMtimeKey(skillsRoot: string, skillDirs: string[]): Promise<string> {
  const parts: string[] = [];
  for (const skillName of skillDirs) {
    const skillFile = path.join(skillsRoot, skillName, "SKILL.md");
    try {
      const stat = await fs.stat(skillFile);
      parts.push(`${skillFile}:${stat.mtimeMs}`);
    } catch {
      // File may not exist — include a sentinel so its absence is part of the key
      parts.push(`${skillFile}:missing`);
    }
  }
  return parts.join("|");
}

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
      const raw = descMatch[1].trim();
      if (
        (raw.startsWith('"') && raw.endsWith('"')) ||
        (raw.startsWith("'") && raw.endsWith("'"))
      ) {
        description = raw.slice(1, -1);
      } else {
        description = raw;
      }
      continue;
    }

    const execMatch = line.match(/^exec\s*:\s*(.+)$/);
    if (execMatch) {
      const raw = execMatch[1].trim();
      // Only strip outer quotes when the string is symmetrically quoted
      // (e.g. 'cmd' or "cmd") — never strip a trailing quote that is part of
      // the command itself (e.g. -H "Authorization: Bearer $TOKEN")
      if (
        (raw.startsWith('"') && raw.endsWith('"')) ||
        (raw.startsWith("'") && raw.endsWith("'"))
      ) {
        exec = raw.slice(1, -1);
      } else {
        exec = raw;
      }
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

    // ── Cache check ──────────────────────────────────────────────────────────
    // Build the mtime key for all SKILL.md files in this dir. If the key and
    // age both match the cached entry, skip disk reads and reuse cached skills.
    const now = Date.now();
    const mtimeKey = await buildMtimeKey(skillsRoot, skillDirs);
    const cached = skillsCache.get(skillsRoot);

    if (
      cached &&
      cached.mtimeKey === mtimeKey &&
      now - cached.loadedAt < SKILLS_CACHE_TTL_MS
    ) {
      // Cache hit — use cached skills for this dir
      skills.push(...cached.skills);
      continue;
    }

    // ── Cache miss or stale — reload from disk ───────────────────────────────
    const dirSkills: SkillEntry[] = [];

    for (const skillName of skillDirs) {
      const skillFile = path.join(skillsRoot, skillName, "SKILL.md");

      let content: string;
      try {
        content = await fs.readFile(skillFile, "utf8");
      } catch {
        continue;
      }

      const fm = extractFrontmatter(content);

      dirSkills.push({
        name: skillName,
        description: fm.description,
        content,
        exec: fm.exec,
        parameters: fm.parameters,
      });
    }

    // Store the freshly loaded skills in the cache
    skillsCache.set(skillsRoot, { skills: dirSkills, loadedAt: now, mtimeKey });
    skills.push(...dirSkills);
  }

  return skills;
}

// ── System prompt builder (prompt-only skills) ────────────────────────────────

/** Strip YAML frontmatter block (---...---) from skill content. */
function stripFrontmatter(content: string): string {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) return trimmed;
  const afterOpen = trimmed.slice(3);
  const closeIdx = afterOpen.indexOf("\n---");
  if (closeIdx === -1) return trimmed;
  return afterOpen.slice(closeIdx + 4).trimStart();
}

export function buildSkillsSystemPrompt(skills: SkillEntry[]): string {
  const promptSkills = skills.filter((s) => !s.exec);
  if (promptSkills.length === 0) return "";

  const lines: string[] = ["## Skills", ""];

  for (const skill of promptSkills) {
    const body = stripFrontmatter(skill.content);
    if (body) {
      // Include the full skill body (already contains its own headings)
      lines.push(body, "");
    } else if (skill.description) {
      lines.push(`### ${skill.name}`, "", skill.description, "");
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
