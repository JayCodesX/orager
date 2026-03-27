/**
 * Reads CLAUDE.md and ORAGER.md files from the cwd hierarchy and global locations,
 * merges them into a single string for injection into the system prompt.
 *
 * Merge order (lowest → highest precedence, all appended):
 *   ~/.claude/CLAUDE.md
 *   CLAUDE.md files from filesystem root → cwd
 *   ~/.orager/ORAGER.md
 *   ORAGER.md files from filesystem root → cwd
 *
 * Results are mtime-cached so repeated daemon calls don't re-read unchanged files.
 * Total merged output is capped at 32KB.
 * All read failures are silently ignored.
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const MAX_TOTAL_BYTES = 32 * 1024;

interface CacheEntry {
  mtime: number;
  content: string;
}
const _cache = new Map<string, CacheEntry>();

async function readCached(filePath: string): Promise<string> {
  try {
    const stat = await fs.stat(filePath);
    const mtime = stat.mtimeMs;
    const cached = _cache.get(filePath);
    if (cached && cached.mtime === mtime) return cached.content;
    const content = await fs.readFile(filePath, "utf8");
    _cache.set(filePath, { mtime, content });
    return content;
  } catch {
    return "";
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

export async function loadProjectInstructions(cwd: string): Promise<string> {
  const home = os.homedir();
  const ancestors = ancestorDirs(cwd);

  const sources: string[] = [];

  // Global CLAUDE.md
  sources.push(await readCached(path.join(home, ".claude", "CLAUDE.md")));

  // Project CLAUDE.md hierarchy (root → cwd)
  for (const dir of ancestors) {
    sources.push(await readCached(path.join(dir, "CLAUDE.md")));
  }

  // Global ORAGER.md
  sources.push(await readCached(path.join(home, ".orager", "ORAGER.md")));

  // Project ORAGER.md hierarchy (root → cwd)
  for (const dir of ancestors) {
    sources.push(await readCached(path.join(dir, "ORAGER.md")));
  }

  const merged = sources.filter(Boolean).join("\n\n");
  if (!merged) return "";

  const encoder = new TextEncoder();
  const bytes = encoder.encode(merged);
  if (bytes.length <= MAX_TOTAL_BYTES) return merged;

  // Truncate to MAX_TOTAL_BYTES
  const decoder = new TextDecoder();
  return decoder.decode(bytes.slice(0, MAX_TOTAL_BYTES));
}
