/**
 * Auto-memory tools: write_memory / read_memory
 *
 * Enabled when `AgentLoopOptions.autoMemory` is true. These tools let the
 * agent maintain a persistent, human-readable markdown file that survives
 * across sessions — similar to Claude Code's CLAUDE.md writer.
 *
 * Storage strategy:
 *   - Project memory  → <cwd>/CLAUDE.md         (committed to the repo)
 *   - Global memory   → ~/.orager/MEMORY.md      (user-wide, never committed)
 *
 * The agent chooses the scope via the `scope` parameter ("project" | "global").
 * Default scope is "project".
 *
 * write_memory writes/replaces a named section (H2 heading) in the file.
 * read_memory returns the full file contents.
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { ToolExecutor, ToolResult } from "../types.js";

// ── Path helpers ──────────────────────────────────────────────────────────────

export const GLOBAL_MEMORY_FILE = path.join(os.homedir(), ".orager", "MEMORY.md");

export function projectMemoryFile(cwd: string): string {
  return path.join(cwd, "CLAUDE.md");
}

function memoryFilePath(scope: "project" | "global", cwd: string): string {
  return scope === "global" ? GLOBAL_MEMORY_FILE : projectMemoryFile(cwd);
}

// ── Section helpers ───────────────────────────────────────────────────────────
//
// A "section" is an H2 block in the markdown file:
//   ## Section Title
//   content here
//   content continues
//   (next H2 or EOF terminates the section)

const H2_RE = /^## /m;

/**
 * Replace or append a named H2 section in `markdown`.
 * If the section already exists it is replaced; otherwise it is appended.
 */
export function upsertSection(markdown: string, heading: string, body: string): string {
  const sectionHeading = `## ${heading}`;
  const lines = markdown.split("\n");

  // Find start of the target section
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.trimEnd() === sectionHeading) {
      start = i;
      break;
    }
  }

  const newBlock = `${sectionHeading}\n${body.trimEnd()}`;

  if (start === -1) {
    // Section not found — append
    const trimmed = markdown.trimEnd();
    return trimmed.length > 0 ? `${trimmed}\n\n${newBlock}\n` : `${newBlock}\n`;
  }

  // Find end of the target section (next H2 or EOF)
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (H2_RE.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }

  const before = lines.slice(0, start).join("\n");
  const after = lines.slice(end).join("\n");

  const parts: string[] = [];
  if (before.trimEnd().length > 0) parts.push(before.trimEnd());
  parts.push(newBlock);
  if (after.trim().length > 0) parts.push(after.trim());

  return parts.join("\n\n") + "\n";
}

// ── Tool: write_memory ────────────────────────────────────────────────────────

export function makeWriteMemoryTool(cwd: string): ToolExecutor {
  return {
    definition: {
      type: "function",
      function: {
        name: "write_memory",
        description:
          "Write a persistent memory note that will be available in future sessions. " +
          "Notes are stored in a markdown file (CLAUDE.md for project scope, " +
          "~/.orager/MEMORY.md for global scope). " +
          "Each note is a named section — writing to an existing section replaces it. " +
          "Use this to persist decisions, user preferences, codebase facts, or anything " +
          "the agent should remember across session resets.",
        parameters: {
          type: "object",
          properties: {
            heading: {
              type: "string",
              description:
                "Short section title (used as an H2 heading). " +
                'Examples: "User preferences", "Key architectural decisions", "Build commands".',
            },
            content: {
              type: "string",
              description: "Markdown content for the section. May contain bullet lists, code blocks, etc.",
            },
            scope: {
              type: "string",
              enum: ["project", "global"],
              description:
                '"project" writes to <cwd>/CLAUDE.md (default, committed to the repo). ' +
                '"global" writes to ~/.orager/MEMORY.md (user-wide, never committed).',
            },
          },
          required: ["heading", "content"],
        },
      },
    },
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const heading = String(input["heading"] ?? "").trim();
      const content = String(input["content"] ?? "");
      const scope = input["scope"] === "global" ? "global" : "project";

      if (!heading) {
        return { toolCallId: "", content: "Error: heading is required and must not be empty.", isError: true };
      }

      const filePath = memoryFilePath(scope, cwd);

      let existing = "";
      try {
        existing = await fs.readFile(filePath, "utf8");
      } catch {
        // File doesn't exist yet — start empty
        await fs.mkdir(path.dirname(filePath), { recursive: true });
      }

      const updated = upsertSection(existing, heading, content);
      await fs.writeFile(filePath, updated, { encoding: "utf8", mode: 0o644 });

      return {
        toolCallId: "",
        content: `Memory written to ${scope === "global" ? "~/.orager/MEMORY.md" : "CLAUDE.md"} under section "## ${heading}".`,
        isError: false,
      };
    },
  };
}

// ── Tool: read_memory ─────────────────────────────────────────────────────────

export function makeReadMemoryTool(cwd: string): ToolExecutor {
  return {
    definition: {
      type: "function",
      function: {
        name: "read_memory",
        description:
          "Read the persistent memory file for the current project or global scope. " +
          "Returns the full markdown contents of CLAUDE.md (project) or " +
          "~/.orager/MEMORY.md (global). Returns an empty string if the file does not exist.",
        parameters: {
          type: "object",
          properties: {
            scope: {
              type: "string",
              enum: ["project", "global"],
              description: '"project" reads <cwd>/CLAUDE.md (default). "global" reads ~/.orager/MEMORY.md.',
            },
          },
          required: [],
        },
      },
    },
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const scope = input["scope"] === "global" ? "global" : "project";
      const filePath = memoryFilePath(scope, cwd);

      let content = "";
      try {
        content = await fs.readFile(filePath, "utf8");
      } catch {
        // File does not exist — return empty
      }

      return {
        toolCallId: "",
        content: content || "(memory file is empty or does not exist)",
        isError: false,
      };
    },
  };
}

// ── Load memory file for system-prompt injection ──────────────────────────────

/**
 * Read the project CLAUDE.md (if it exists) for injection into the system prompt
 * at session start. Returns empty string when the file is missing or empty.
 *
 * This is distinct from `loadProjectInstructions` which looks up the hierarchy
 * for project instructions — this reads only the cwd-level CLAUDE.md that the
 * agent writes to via write_memory.
 *
 * Note: when `readProjectInstructions` is enabled in the loop, CLAUDE.md is
 * already injected via that path.  `autoMemory` injection only adds value when
 * `readProjectInstructions` is false (or when the global MEMORY.md should also
 * be included).
 */
export async function loadAutoMemory(cwd: string): Promise<{ project: string; global: string }> {
  const [projectMd, globalMd] = await Promise.all([
    fs.readFile(projectMemoryFile(cwd), "utf8").catch(() => ""),
    fs.readFile(GLOBAL_MEMORY_FILE, "utf8").catch(() => ""),
  ]);

  // When SQLite memory is enabled, also render the structured memory store
  // and append it to the project block so the agent sees all persistent notes.
  let sqliteBlock = "";
  try {
    const { isSqliteMemoryEnabled, loadMemoryStoreSqlite } = await import("../memory-sqlite.js");
    if (isSqliteMemoryEnabled()) {
      const { renderMemoryBlock, memoryKeyFromCwd } = await import("../memory.js");
      const key = memoryKeyFromCwd(cwd);
      const store = await loadMemoryStoreSqlite(key);
      sqliteBlock = renderMemoryBlock(store);
    }
  } catch {
    // SQLite not available or memory load failed — non-fatal
  }

  const project = [projectMd, sqliteBlock].filter(Boolean).join("\n\n---\n\n");
  return { project, global: globalMd };
}
