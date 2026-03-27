import { readdir, readFile } from "node:fs/promises";
import { resolve, isAbsolute, join, relative } from "node:path";
import type { ToolExecuteOptions, ToolExecutor, ToolResult } from "../types.js";
import { assertPathAllowed } from "../sandbox.js";

const MAX_MATCHES = 500;
const MAX_FILE_SIZE_BYTES = 5_000_000; // skip files > 5MB
const CONTEXT_LINES = 2; // lines of context above/below each match

// SKIP_DIRS: same set as list-dir / glob for consistency
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", ".next",
  "build", "__pycache__", ".venv", "venv", ".tox",
  "target", "out", "coverage", ".cache", ".parcel-cache",
  "__snapshots__", ".pytest_cache", "vendor",
]);

// File extensions that are almost certainly binary — skip without reading
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".svg",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".exe", ".dll", ".so", ".dylib", ".a", ".o",
  ".wasm", ".bin", ".dat",
  ".mp3", ".mp4", ".wav", ".ogg", ".flac",
  ".ttf", ".otf", ".woff", ".woff2",
  ".pyc", ".pyo",
  ".lock", // package-lock.json excluded intentionally but yarn.lock skipped
]);

interface Match {
  file: string;
  line: number;
  column: number;
  text: string;
  context: string;
}

export const searchFilesTool: ToolExecutor = {
  definition: {
    type: "function",
    readonly: true,
    function: {
      name: "search_files",
      description:
        "Search for a regex pattern across files in a directory (like grep -r). Returns matching lines with file path, line number, and surrounding context. Use for finding function definitions, variable usages, string constants, etc.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Regular expression to search for (JavaScript regex syntax)",
          },
          path: {
            type: "string",
            description:
              "Directory or file to search in (absolute or relative to cwd). Defaults to cwd.",
          },
          file_pattern: {
            type: "string",
            description:
              "Optional glob pattern to filter which files are searched (e.g. '*.ts', '*.py'). Uses * and ? wildcards within a single filename only (no path separators).",
          },
          case_sensitive: {
            type: "boolean",
            description: "Whether the search is case-sensitive (default true).",
          },
          context_lines: {
            type: "number",
            description: `Lines of context to show above and below each match (default ${CONTEXT_LINES}, max 5).`,
          },
          count_only: {
            type: "boolean",
            description:
              "When true, return only the total match count and per-file counts without showing the matching lines. Useful for checking whether a pattern exists or how widespread it is before diving in.",
          },
          max_results: {
            type: "number",
            description:
              "Maximum number of matches to return (default 200). Each match includes surrounding context lines.",
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
    const patternStr = input["pattern"];
    const rawPath = typeof input["path"] === "string" ? input["path"] : ".";
    const searchPath = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
    const filePattern =
      typeof input["file_pattern"] === "string" ? input["file_pattern"] : null;
    const caseSensitive = input["case_sensitive"] !== false; // default true
    const ctxLines = Math.min(
      5,
      typeof input["context_lines"] === "number"
        ? Math.max(0, input["context_lines"])
        : CONTEXT_LINES,
    );
    const countOnly = input["count_only"] === true;

    const maxMatches =
      typeof input["max_results"] === "number" && input["max_results"] > 0
        ? Math.min(Math.floor(input["max_results"]), 5_000)
        : 200; // default lower than glob since each result has context lines

    if (opts?.sandboxRoot) {
      try {
        assertPathAllowed(searchPath, opts.sandboxRoot);
      } catch (err) {
        return {
          toolCallId: "",
          content: err instanceof Error ? err.message : String(err),
          isError: true,
        };
      }
    }

    let regex: RegExp;
    try {
      regex = new RegExp(patternStr, caseSensitive ? "g" : "gi");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { toolCallId: "", content: `Invalid regex: ${msg}`, isError: true };
    }

    const matches: Match[] = [];
    // Track the true total even when we stop collecting after maxMatches
    const state: SearchState = { truncated: false, count: 0, totalCount: 0, maxMatches };

    try {
      await searchInPath(
        searchPath,
        searchPath,
        regex,
        filePattern,
        ctxLines,
        matches,
        opts?.sandboxRoot,
        state,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { toolCallId: "", content: msg, isError: true };
    }

    if (matches.length === 0 && state.totalCount === 0) {
      return {
        toolCallId: "",
        content: `No matches found for: ${patternStr}`,
        isError: false,
      };
    }

    // Group by file for all output modes
    const byFile = new Map<string, Match[]>();
    for (const m of matches) {
      const arr = byFile.get(m.file) ?? [];
      arr.push(m);
      byFile.set(m.file, arr);
    }

    // ── count_only mode ───────────────────────────────────────────────────────
    if (countOnly) {
      const lines: string[] = [];
      for (const [file, fileMatches] of byFile) {
        lines.push(`${String(fileMatches.length).padStart(5)}  ${file}`);
      }
      lines.sort((a, b) => {
        const na = parseInt(a.trimStart(), 10);
        const nb = parseInt(b.trimStart(), 10);
        return nb - na; // highest count first
      });
      const shown = state.count;
      const total = state.totalCount;
      const truncNote = state.truncated
        ? ` (showing first ${shown} of ${total} total — run without count_only or narrow the search for full results)`
        : "";
      return {
        toolCallId: "",
        content:
          lines.join("\n") +
          `\n\n${total} match${total === 1 ? "" : "es"} across ${byFile.size} file${byFile.size === 1 ? "" : "s"}` +
          truncNote,
        isError: false,
      };
    }

    // ── full match output ─────────────────────────────────────────────────────
    const sections: string[] = [];
    for (const [file, fileMatches] of byFile) {
      const header = `── ${file} ──`;
      const lines = fileMatches.map((m) => {
        const loc = `${m.line}:${m.column}`;
        return `${loc.padEnd(8)} ${m.context}`;
      });
      sections.push([header, ...lines].join("\n"));
    }

    let output = sections.join("\n\n");
    const shown = state.count;
    const total = state.totalCount;
    if (state.truncated) {
      output += `\n\n[showing ${shown} of ${total} matches — use count_only:true or narrow your search to see all]`;
    }
    output += `\n\n${total} match${total === 1 ? "" : "es"} across ${byFile.size} file${byFile.size === 1 ? "" : "s"}`;

    return { toolCallId: "", content: output, isError: false };
  },
};

interface SearchState {
  truncated: boolean;
  /** Number of matches collected into the matches array (capped at maxMatches) */
  count: number;
  /** True total matches found, even beyond the cap */
  totalCount: number;
  maxMatches: number;
}

async function searchInPath(
  rootDir: string,
  currentPath: string,
  regex: RegExp,
  filePattern: string | null,
  ctxLines: number,
  matches: Match[],
  sandboxRoot?: string,
  state: SearchState = { truncated: false, count: 0, totalCount: 0, maxMatches: 200 },
): Promise<void> {
  // Still scan even when capped so we can report the true total
  if (state.truncated && state.count >= state.maxMatches) return;

  let stat;
  try {
    const { stat: statFn } = await import("node:fs/promises");
    stat = await statFn(currentPath);
  } catch {
    return;
  }

  if (stat.isFile()) {
    await searchInFile(rootDir, currentPath, regex, filePattern, ctxLines, matches, state);
    return;
  }

  if (!stat.isDirectory()) return;

  let entries;
  try {
    entries = await readdir(currentPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (state.truncated && state.count >= state.maxMatches) return;

    const fullPath = join(currentPath, entry.name);

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (sandboxRoot) {
        try { assertPathAllowed(fullPath, sandboxRoot); } catch { continue; }
      }
      await searchInPath(rootDir, fullPath, regex, filePattern, ctxLines, matches, sandboxRoot, state);
    } else if (entry.isFile()) {
      if (sandboxRoot) {
        try { assertPathAllowed(fullPath, sandboxRoot); } catch { continue; }
      }
      await searchInFile(rootDir, fullPath, regex, filePattern, ctxLines, matches, state);
    }
  }
}

function matchesFilePattern(filename: string, pattern: string): boolean {
  let regexStr = "^";
  for (const c of pattern) {
    if (c === "*") regexStr += ".*";
    else if (c === "?") regexStr += ".";
    else regexStr += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  regexStr += "$";
  return new RegExp(regexStr).test(filename);
}

async function searchInFile(
  rootDir: string,
  filePath: string,
  regex: RegExp,
  filePattern: string | null,
  ctxLines: number,
  matches: Match[],
  state: SearchState,
): Promise<void> {
  // Skip based on extension
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) return;

  // Skip yarn.lock / package-lock.json — too noisy
  const basename = filePath.slice(filePath.lastIndexOf("/") + 1);
  if (basename === "yarn.lock" || basename === "package-lock.json") return;

  // Apply file pattern filter if specified
  if (filePattern && !matchesFilePattern(basename, filePattern)) return;

  let content: string;
  try {
    const { stat } = await import("node:fs/promises");
    const s = await stat(filePath);
    if (s.size > MAX_FILE_SIZE_BYTES) return;
    content = await readFile(filePath, "utf-8");
  } catch {
    return;
  }

  const lines = content.split("\n");
  const relPath = relative(rootDir, filePath);

  for (let i = 0; i < lines.length; i++) {
    // Reset lastIndex for global regex
    regex.lastIndex = 0;
    const match = regex.exec(lines[i]);
    if (!match) continue;

    state.totalCount++;

    // Once we've hit the cap, keep counting totals but stop collecting detail
    if (state.count >= state.maxMatches) {
      state.truncated = true;
      continue;
    }

    // Build context block
    const startCtx = Math.max(0, i - ctxLines);
    const endCtx = Math.min(lines.length - 1, i + ctxLines);
    const contextLines: string[] = [];
    for (let j = startCtx; j <= endCtx; j++) {
      const lineNum = j + 1;
      const prefix = j === i ? ">" : " ";
      contextLines.push(`${prefix} ${String(lineNum).padStart(5)} │ ${lines[j]}`);
    }

    matches.push({
      file: relPath,
      line: i + 1,
      column: match.index + 1,
      text: lines[i],
      context: contextLines.join("\n"),
    });
    state.count++;
  }
}
