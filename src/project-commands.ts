/**
 * Project command loader — reads .claude/commands/*.md from the cwd hierarchy.
 *
 * Each .md file defines a named prompt template callable as /<command-name>.
 * The filename (without .md) is the command name.
 * $ARGUMENTS in the template is replaced with any text after the command name.
 *
 * Commands from closer directories override commands with the same name from
 * parent directories. ORAGER-specific commands can live in .orager/commands/.
 *
 * Results are mtime-cached per file.
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export interface ProjectCommand {
  name: string;
  description: string; // first non-empty line of the file (stripped of leading #)
  template: string;    // full file content
  source: string;      // absolute path to the file
}

interface CacheEntry { mtime: number; command: ProjectCommand }
const _cache = new Map<string, CacheEntry>();

async function loadCommandFile(filePath: string): Promise<ProjectCommand | null> {
  try {
    const stat = await fs.stat(filePath);
    const mtime = stat.mtimeMs;
    const cached = _cache.get(filePath);
    if (cached && cached.mtime === mtime) return cached.command;

    const content = await fs.readFile(filePath, "utf8");
    const name = path.basename(filePath, ".md");
    // Extract first non-empty line as description (strip leading #)
    const firstLine = content.split("\n").find((l) => l.trim()) ?? "";
    const description = firstLine.replace(/^#+\s*/, "").trim() || name;

    const command: ProjectCommand = { name, description, template: content, source: filePath };
    _cache.set(filePath, { mtime, command });
    return command;
  } catch {
    return null;
  }
}

function ancestorDirs(dir: string): string[] {
  const dirs: string[] = [];
  let current = dir;
  while (true) {
    dirs.unshift(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

async function loadCommandsFromDir(dir: string): Promise<Map<string, ProjectCommand>> {
  const commands = new Map<string, ProjectCommand>();
  for (const subdir of [".claude/commands", ".orager/commands"]) {
    const commandsDir = path.join(dir, subdir);
    try {
      const entries = await fs.readdir(commandsDir);
      for (const entry of entries) {
        if (!entry.endsWith(".md")) continue;
        const filePath = path.join(commandsDir, entry);
        const cmd = await loadCommandFile(filePath);
        if (cmd) commands.set(cmd.name, cmd);
      }
    } catch { /* directory doesn't exist */ }
  }
  return commands;
}

/**
 * Load all project commands for a given cwd.
 * Commands from closer directories override those from parent dirs.
 * Global commands from ~/.claude/commands and ~/.orager/commands are also loaded (lowest precedence).
 */
export async function loadProjectCommands(cwd: string): Promise<Map<string, ProjectCommand>> {
  const home = os.homedir();
  const merged = new Map<string, ProjectCommand>();

  // Global commands (lowest precedence)
  for (const globalDir of [path.join(home, ".claude"), path.join(home, ".orager")]) {
    const globalCmds = await loadCommandsFromDir(globalDir);
    for (const [name, cmd] of globalCmds) merged.set(name, cmd);
  }

  // Project hierarchy (root → cwd, closer dirs override)
  for (const dir of ancestorDirs(cwd)) {
    const dirCmds = await loadCommandsFromDir(dir);
    for (const [name, cmd] of dirCmds) merged.set(name, cmd);
  }

  return merged;
}

/**
 * If the prompt starts with /<command-name>, resolve it against the loaded commands.
 * Returns the expanded prompt, or null if no command matched.
 */
export function resolveCommandPrompt(
  prompt: string,
  commands: Map<string, ProjectCommand>,
): string | null {
  const match = prompt.match(/^\/([a-zA-Z0-9_-]+)(?:\s+(.*))?$/s);
  if (!match) return null;
  const [, name, args = ""] = match;
  const cmd = commands.get(name);
  if (!cmd) return null;
  return cmd.template.replace(/\$ARGUMENTS/g, args.trim());
}

/**
 * Build a system prompt section listing available project commands.
 */
export function buildCommandsSystemPrompt(commands: Map<string, ProjectCommand>): string {
  if (commands.size === 0) return "";
  const lines = ["Available project commands (invoke with /<command-name>):"];
  for (const [name, cmd] of commands) {
    lines.push(`  /${name} — ${cmd.description}`);
  }
  return lines.join("\n");
}
