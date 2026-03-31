import { readdir } from "node:fs/promises";
import { resolve, isAbsolute, join, relative } from "node:path";
import type { ToolExecuteOptions, ToolExecutor, ToolResult } from "../types.js";
import { assertPathAllowed } from "../sandbox.js";

const MAX_RESULTS = 500;

// Minimal glob matcher supporting *, **, and ? patterns.
// Does NOT support character classes ([abc]) or brace expansion ({a,b}) —
// those are edge cases not needed for typical file-discovery patterns.
/**
 * N-08: Collapse consecutive ** segments to prevent O(n^k) exponential
 * backtracking on patterns like **\/**\/**\/*.ts in deep directory trees.
 */
function collapseDoubleStars(segments: string[]): string[] {
  const result: string[] = [];
  for (const seg of segments) {
    if (seg === "**" && result.length > 0 && result[result.length - 1] === "**") continue;
    result.push(seg);
  }
  return result;
}

function matchGlob(pattern: string, filePath: string): boolean {
  return matchSegments(collapseDoubleStars(pattern.split("/")), filePath.split("/"));
}

const MAX_MATCH_RECURSION = 64;

function matchSegments(patterns: string[], parts: string[], depth = 0): boolean {
  if (depth > MAX_MATCH_RECURSION) return false; // prevent runaway recursion

  let pi = 0; // pattern index
  let si = 0; // string (path) index

  while (pi < patterns.length && si < parts.length) {
    const pat = patterns[pi];
    if (pat === "**") {
      // ** matches zero or more path segments
      // Try matching the rest of the pattern against every possible suffix
      for (let k = si; k <= parts.length; k++) {
        if (matchSegments(patterns.slice(pi + 1), parts.slice(k), depth + 1)) return true;
      }
      return false;
    }
    if (!matchSingleSegment(pat, parts[si])) return false;
    pi++;
    si++;
  }

  // Skip any trailing ** patterns
  while (pi < patterns.length && patterns[pi] === "**") pi++;

  return pi === patterns.length && si === parts.length;
}

function matchSingleSegment(pattern: string, str: string): boolean {
  // Convert glob pattern to regex
  let regexStr = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      regexStr += "[^/]*";
    } else if (c === "?") {
      regexStr += "[^/]";
    } else {
      // Escape regex special chars
      regexStr += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  regexStr += "$";
  return new RegExp(regexStr).test(str);
}

/**
 * Expand brace expressions in a glob pattern.
 * e.g. "**\/*.{ts,tsx,js}" → ["**\/*.ts", "**\/*.tsx", "**\/*.js"]
 * Only top-level braces are expanded (no nesting).
 * Returns [pattern] unchanged if no braces are present.
 */
function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf("{");
  if (open === -1) return [pattern];
  const close = pattern.indexOf("}", open);
  if (close === -1) return [pattern]; // unmatched brace — treat as literal

  const prefix = pattern.slice(0, open);
  const suffix = pattern.slice(close + 1);
  const alternatives = pattern.slice(open + 1, close).split(",");

  const results: string[] = [];
  for (const alt of alternatives) {
    // Recursively expand in case of multiple brace groups
    const expanded = expandBraces(prefix + alt.trim() + suffix);
    results.push(...expanded);
  }
  return results;
}

export const globTool: ToolExecutor = {
  definition: {
    type: "function",
    readonly: true,
    function: {
      name: "glob",
      description:
        "Find files matching a glob pattern (supports *, **, ?). Returns matching paths relative to the search root. Use ** to match across directories, e.g. '**/*.ts', 'src/**/*.test.js'.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description:
              "Glob pattern to match (e.g. '**/*.ts', 'src/**/*.test.js', '*.json')",
          },
          root: {
            type: "string",
            description:
              "Directory to search in (absolute or relative to cwd). Defaults to cwd.",
          },
          max_results: {
            type: "number",
            description:
              `Maximum number of files to return (default ${MAX_RESULTS}). ` +
              `A truncation notice is appended when the limit is hit.`,
          },
        },
        required: ["pattern"],
      },
    },
  },

  async execute(
    input: Record<string, unknown>,
    cwd: string,
    opts?: ToolExecuteOptions,
  ): Promise<ToolResult> {
    if (typeof input["pattern"] !== "string" || !input["pattern"]) {
      return { toolCallId: "", content: "pattern must be a non-empty string", isError: true };
    }
    const pattern = input["pattern"];
    const rawRoot =
      typeof input["root"] === "string" ? input["root"] : ".";
    const searchRoot = isAbsolute(rawRoot) ? rawRoot : resolve(cwd, rawRoot);

    if (opts?.sandboxRoot) {
      try {
        assertPathAllowed(searchRoot, opts.sandboxRoot);
      } catch (err) {
        return {
          toolCallId: "",
          content: err instanceof Error ? err.message : String(err),
          isError: true,
        };
      }
    }

    const maxResults =
      typeof input["max_results"] === "number" && input["max_results"] > 0
        ? Math.min(Math.floor(input["max_results"]), 10_000)
        : MAX_RESULTS;

    const patterns = expandBraces(pattern);
    const seen = new Set<string>();
    const matches: string[] = [];

    try {
      for (const p of patterns) {
        await walkForGlob(searchRoot, searchRoot, p, matches, opts?.sandboxRoot, seen, maxResults);
        if (matches.length >= maxResults) break;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { toolCallId: "", content: msg, isError: true };
    }

    let truncated = false;
    if (matches.length > maxResults) {
      truncated = true;
      matches.splice(maxResults);
    }

    if (matches.length === 0) {
      return {
        toolCallId: "",
        content: `No files matched pattern: ${pattern}`,
        isError: false,
      };
    }

    matches.sort();
    let output = matches.join("\n");
    if (truncated) {
      output += `\n[results truncated at ${maxResults}]`;
    }

    return { toolCallId: "", content: output, isError: false };
  },
};

// SKIP_DIRS: same set as list-dir to be consistent
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", ".next",
  "build", "__pycache__", ".venv", "venv", ".tox",
  "target", "out", "coverage", ".cache", ".parcel-cache",
  "__snapshots__", ".pytest_cache", "vendor",
]);

async function walkForGlob(
  rootDir: string,
  currentDir: string,
  pattern: string,
  matches: string[],
  sandboxRoot?: string,
  seen?: Set<string>,
  limit: number = MAX_RESULTS,
): Promise<void> {
  if (matches.length >= limit) return;

  let entries;
  try {
    entries = await readdir(currentDir, { withFileTypes: true });
  } catch (err) {
    // L-06: Log non-ENOENT readdir failures for debugging; ENOENT is expected
    // for directories that disappear during traversal.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      process.stderr.write(`[orager] glob: cannot read directory ${currentDir}: ${code ?? err}\n`);
    }
    return;
  }

  for (const entry of entries) {
    if (matches.length >= limit) return;

    const fullPath = join(currentDir, entry.name);

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (sandboxRoot) {
        try { assertPathAllowed(fullPath, sandboxRoot); } catch { continue; }
      }
      await walkForGlob(rootDir, fullPath, pattern, matches, sandboxRoot, seen, limit);
    } else {
      const relPath = relative(rootDir, fullPath);
      if (matchGlob(pattern, relPath)) {
        // Deduplicate across brace-expanded patterns
        if (seen && seen.has(relPath)) continue;
        seen?.add(relPath);
        matches.push(relPath);
      }
    }
  }
}
