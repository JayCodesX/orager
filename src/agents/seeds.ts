/**
 * Built-in seed agents shipped with orager.
 *
 * These are always available without any user configuration. They follow the
 * Claude Code pattern of shipping a curated set of specialised sub-agents
 * (Explore, Plan, general-purpose) out of the box.
 *
 * Seed agents can be overridden by a user or project definition with the
 * same key — higher-priority sources in the registry win.
 *
 * Design principles:
 *   - Each seed targets a single clear responsibility
 *   - Tool sets are minimal (principle of least privilege)
 *   - "low" effort seeds (explorer, reviewer) use cheap models by default
 *   - "high" effort seeds (planner) opt into deeper reasoning
 *   - No memory writes — seeds are stateless helpers
 *   - Skills disabled for utility seeds (token overhead not worth it)
 */

import type { AgentDefinition } from "../types.js";

export const SEED_AGENTS: Record<string, AgentDefinition> = {
  // ── explorer ────────────────────────────────────────────────────────────────
  // Read-only codebase navigator. Cheap + fast. Equivalent to Claude Code's
  // "Explore" seed agent (haiku-class model, read-only tools).
  explorer: {
    name: "Explorer",
    description:
      "Read-only codebase search and exploration. Use to find files, " +
      "read code sections, grep for patterns, or answer questions about " +
      "the structure of the codebase. Does not write or modify anything.",
    prompt:
      "You are a codebase explorer. Your only job is to read, search, and " +
      "summarise. Use Read, Glob, Grep, and ListDir to navigate the codebase. " +
      "Return concise, structured findings. Do not suggest changes or write code.",
    tools: ["Read", "Glob", "Grep", "ListDir"],
    model: "openai/gpt-4o-mini",
    effort: "low",
    skills: false,
    memoryWrite: false,
    tags: ["code", "search", "read-only"],
    color: "#818cf8",
    source: "seed",
  },

  // ── planner ─────────────────────────────────────────────────────────────────
  // Equivalent to Claude Code's "Plan" seed. Read-only research → structured plan.
  planner: {
    name: "Planner",
    description:
      "Analyse a task and produce a detailed implementation plan. Use before " +
      "making changes to complex features. Reads relevant code, identifies " +
      "affected files, and returns a step-by-step plan with trade-offs.",
    prompt:
      "You are a software architect. Given a task description, explore the " +
      "relevant codebase sections and produce a clear, actionable implementation " +
      "plan. Structure your response as:\n" +
      "1. Summary (2-3 sentences)\n" +
      "2. Files to create/modify (with brief reason)\n" +
      "3. Step-by-step implementation order\n" +
      "4. Risks and trade-offs\n\n" +
      "Do not write code. Read-only exploration only.",
    tools: ["Read", "Glob", "Grep", "ListDir", "WebFetch"],
    effort: "high",
    skills: false,
    memoryWrite: false,
    readProjectInstructions: true,
    tags: ["planning", "architecture"],
    color: "#f59e0b",
    source: "seed",
  },

  // ── researcher ──────────────────────────────────────────────────────────────
  // Web research + synthesis. No filesystem writes.
  researcher: {
    name: "Researcher",
    description:
      "Web research and information synthesis. Use to look up documentation, " +
      "investigate libraries, research APIs, or gather background context. " +
      "Returns structured summaries with sources.",
    prompt:
      "You are a research specialist. Search the web, fetch pages, and " +
      "synthesise information into clear summaries. Always cite sources. " +
      "Prioritise official documentation, GitHub repos, and authoritative " +
      "references. Be concise — return the key facts the caller needs.",
    tools: ["WebSearch", "WebFetch", "Read"],
    effort: "medium",
    skills: false,
    memoryWrite: false,
    tags: ["research", "web"],
    color: "#34d399",
    source: "seed",
  },

  // ── coder ───────────────────────────────────────────────────────────────────
  // Full tool access for writing/editing code. Reads project instructions so
  // it follows project conventions.
  coder: {
    name: "Coder",
    description:
      "Write, edit, and refactor code. Use for focused coding tasks where " +
      "the parent has already determined what needs to be built. Has full " +
      "filesystem access and can run bash commands.",
    prompt:
      "You are a skilled software engineer. Implement the requested changes " +
      "precisely and completely. Follow the project's existing code style and " +
      "conventions. Write clean, well-commented code. Run tests when appropriate. " +
      "Report what you changed and any issues encountered.",
    // all tools — no restriction; inherits parent's full toolset
    effort: "medium",
    skills: true,
    memoryWrite: false,
    readProjectInstructions: true,
    tags: ["code", "implementation"],
    color: "#60a5fa",
    source: "seed",
  },

  // ── reviewer ────────────────────────────────────────────────────────────────
  // Read-only code review and security audit.
  reviewer: {
    name: "Reviewer",
    description:
      "Code review, security audit, and quality analysis. Use to review a " +
      "diff, audit a file for bugs/vulnerabilities, or assess code quality. " +
      "Read-only — returns structured feedback.",
    prompt:
      "You are a senior code reviewer. Analyse the code or diff provided. " +
      "Structure your review as:\n" +
      "## Summary\n" +
      "## Issues (Critical / Major / Minor)\n" +
      "## Security concerns\n" +
      "## Suggestions\n\n" +
      "Be specific: cite file names and line numbers. Do not modify files.",
    tools: ["Read", "Grep", "Glob", "ListDir"],
    effort: "medium",
    skills: false,
    memoryWrite: false,
    readProjectInstructions: true,
    tags: ["code", "review", "security", "read-only"],
    color: "#f87171",
    source: "seed",
  },

  // ── tester ──────────────────────────────────────────────────────────────────
  // Runs tests, reads output, diagnoses failures.
  tester: {
    name: "Tester",
    description:
      "Run tests and diagnose failures. Use after a coder agent makes changes, " +
      "or to investigate why tests are failing. Can run bash commands and read " +
      "test output. Returns a pass/fail summary with root-cause analysis.",
    prompt:
      "You are a QA engineer. Run the project's tests, read the output, and " +
      "diagnose any failures. Return:\n" +
      "## Test Results (pass/fail counts)\n" +
      "## Failing Tests (name + root cause)\n" +
      "## Suggested Fixes (specific, actionable)\n\n" +
      "Read test files to understand intent before diagnosing failures.",
    tools: ["Bash", "Read", "Glob", "Grep"],
    effort: "medium",
    skills: false,
    memoryWrite: false,
    readProjectInstructions: true,
    tags: ["testing", "qa"],
    color: "#a78bfa",
    source: "seed",
  },
};
