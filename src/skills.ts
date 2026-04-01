import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ToolExecutor, ToolExecuteOptions, ToolParameterSchema, ToolResult } from "./types.js";
import { containsBlockedCommand } from "./tools/bash.js";

// ── Skills cache ──────────────────────────────────────────────────────────────
// Cache skill entries per directory to avoid re-reading from disk on every
// agent invocation. Cache entries are invalidated when any SKILL.md mtime
// changes or when the entry is older than SKILLS_CACHE_TTL_MS (5 minutes).
// Skills from each dir are cached independently so a change in one dir does
// not evict other dirs.

// 30-minute TTL — skills change rarely; the mtime key already handles
// invalidation when a SKILL.md is edited, so a long TTL is safe.
const SKILLS_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

interface SkillsCacheEntry {
  skills: SkillEntry[];
  loadedAt: number;
  /** Concatenated "<file>:<mtime>" pairs for all SKILL.md files in the dir. */
  mtimeKey: string;
}

// Keyed by the skills root path (dir + "/.orager/skills")
const skillsCache = new Map<string, SkillsCacheEntry>();

// Skills cache invalidation via fs.watch
const _watchedDirs = new Set<string>();

function watchSkillsDir(dir: string, invalidate: () => void): void {
  if (_watchedDirs.has(dir)) return;
  try {
    const watcher = fsSync.watch(dir, { recursive: false }, (event, filename) => {
      if (filename?.endsWith(".md") || filename?.endsWith(".yaml") || filename?.endsWith(".yml")) {
        invalidate();
      }
    });
    watcher.on("error", () => {
      // fs.watch not supported on this platform — fall back to TTL
      _watchedDirs.delete(dir);
    });
    _watchedDirs.add(dir);
  } catch {
    // fs.watch unavailable — silently fall back to TTL
  }
}

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
    } catch (err) {
      // L-06: ENOENT is expected when .orager/skills doesn't exist; log others.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        process.stderr.write(`[orager] skills: cannot read ${skillsRoot}: ${code ?? err}\n`);
      }
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
      // Register a fs.watch listener to invalidate cache on file changes
      watchSkillsDir(skillsRoot, () => {
        const entry = skillsCache.get(skillsRoot);
        if (entry) {
          skillsCache.set(skillsRoot, { ...entry, loadedAt: 0 });
        }
      });
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
    // Register a fs.watch listener to invalidate cache on file changes
    watchSkillsDir(skillsRoot, () => {
      const entry = skillsCache.get(skillsRoot);
      if (entry) {
        skillsCache.set(skillsRoot, { ...entry, loadedAt: 0 });
      }
    });
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
      // Include the skill name label followed by the full skill body
      lines.push(`**${skill.name}**`);
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
  timeoutMs = DEFAULT_EXEC_TIMEOUT_MS,
  additionalEnv?: Record<string, string>,
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
    const spawnEnv = additionalEnv && Object.keys(additionalEnv).length > 0
      ? { ...process.env, ...additionalEnv }
      : undefined;
    const proc = spawn("bash", ["-c", cmd], {
      cwd,
      env: spawnEnv,
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
 * Validate tool input against a skill's declared parameter schema.
 * Returns an error message string on failure, or null if valid.
 */
function validateSkillInput(
  input: Record<string, unknown>,
  schema: ToolParameterSchema | undefined,
): string | null {
  if (!schema) return null;

  for (const key of schema.required ?? []) {
    const val = input[key];
    if (val === undefined || val === null || val === "") {
      return `Missing required parameter: '${key}'`;
    }
  }

  for (const [key, def] of Object.entries(schema.properties)) {
    const val = input[key];
    if (val === undefined) continue;
    // Only check primitive types (skip object/array)
    if (def.type && def.type !== "object" && def.type !== "array") {
      if (typeof val !== def.type) {
        return `Parameter '${key}' must be type ${def.type}, got ${typeof val}`;
      }
    }
    if (def.enum && !def.enum.includes(String(val))) {
      return `Parameter '${key}' must be one of: ${def.enum.join(", ")}`;
    }
  }

  return null;
}

/**
 * Returns `ToolExecutor` instances for skills that have an `exec` field.
 * Tool names are normalised: dashes are replaced with underscores.
 *
 * @param blockedCommands — optional set of blocked command names from bash policy.
 *   When provided, skill exec templates are checked against the blocklist
 *   both at build time (the template itself) and at execution time (after
 *   parameter interpolation). This prevents malicious SKILL.md files from
 *   bypassing the bash tool's security controls (H-04).
 */
export function buildSkillTools(
  skills: SkillEntry[],
  blockedCommands?: Set<string>,
): ToolExecutor[] {
  return skills
    .filter((s) => s.exec != null)
    .filter((skill) => {
      // H-04: Check the exec template itself against the blocklist at build time.
      // This catches obviously blocked commands in the template before any
      // parameters are interpolated.
      if (blockedCommands && blockedCommands.size > 0) {
        const blocked = containsBlockedCommand(skill.exec!, blockedCommands);
        if (blocked) {
          process.stderr.write(
            `[orager] Skill '${skill.name}' blocked: exec template contains blocked command '${blocked}'\n`,
          );
          return false;
        }
      }
      return true;
    })
    .map((skill): ToolExecutor => ({
      definition: {
        type: "function",
        function: {
          name: skill.name.replace(/-/g, "_"),
          description: skill.description || skill.name,
          parameters: skill.parameters ?? { type: "object", properties: {} },
        },
      },
      async execute(input: Record<string, unknown>, cwd: string, opts?: ToolExecuteOptions): Promise<ToolResult> {
        const validationError = validateSkillInput(input, skill.parameters);
        if (validationError) {
          return { toolCallId: "", content: validationError, isError: true };
        }
        const cmd = interpolate(skill.exec!, input);

        // Detect any unreplaced placeholders (e.g. {{param}} not in input)
        const unreplaced = [...cmd.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
        if (unreplaced.length > 0) {
          return {
            toolCallId: "",
            content: `Skill '${skill.name}': unreplaced placeholder(s) in exec template: ${unreplaced.map((p) => `{{${p}}}`).join(", ")}. Check that all required parameters are provided.`,
            isError: true,
          };
        }

        // H-04: Check the interpolated command against the blocklist at runtime.
        // Parameters could inject blocked command names even if the template was clean.
        if (blockedCommands && blockedCommands.size > 0) {
          const blocked = containsBlockedCommand(cmd, blockedCommands);
          if (blocked) {
            return {
              toolCallId: "",
              content: `Skill '${skill.name}': blocked command '${blocked}' detected in interpolated exec command`,
              isError: true,
            };
          }
        }

        const { stdout, stderr, exitCode } = await runShell(cmd, cwd, DEFAULT_EXEC_TIMEOUT_MS, opts?.additionalEnv);
        let content = stdout;
        if (stderr) content += (content ? "\n" : "") + `[stderr] ${stderr}`;
        if (!content) content = exitCode === 0 ? "(no output)" : `exited with code ${exitCode}`;
        const MAX_SKILL_OUTPUT_CHARS = 50_000;
        if (content.length > MAX_SKILL_OUTPUT_CHARS) {
          content =
            content.slice(0, MAX_SKILL_OUTPUT_CHARS) +
            `\n[skill output truncated at ${MAX_SKILL_OUTPUT_CHARS} chars]`;
        }
        return { toolCallId: "", content, isError: exitCode !== 0 };
      },
    }));
}
