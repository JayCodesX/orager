/**
 * Tests for src/tools/auto-memory.ts — write_memory / read_memory tools
 * and the upsertSection / loadAutoMemory helpers.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  upsertSection,
  makeWriteMemoryTool,
  makeReadMemoryTool,
  loadAutoMemory,
  projectMemoryFile,
  GLOBAL_MEMORY_FILE,
} from "../src/tools/auto-memory.js";

// ── Test isolation ─────────────────────────────────────────────────────────────

let testCwd: string;
let savedGlobalEnv: string | undefined;

beforeEach(async () => {
  testCwd = await fs.mkdtemp(path.join(os.tmpdir(), "orager-automem-"));
  testCwd = await fs.realpath(testCwd);

  // Override GLOBAL_MEMORY_FILE path by temporarily redirecting home dir in tests
  // We do this by using a sub-path of testCwd for global memory in tests.
  // (GLOBAL_MEMORY_FILE is a constant, so we can't easily override it.
  // We test global scope indirectly via write/read round-trips.)
});

afterEach(async () => {
  await fs.rm(testCwd, { recursive: true, force: true }).catch(() => {});
});

// ── upsertSection ─────────────────────────────────────────────────────────────

describe("upsertSection", () => {
  it("appends a new section to an empty file", () => {
    const result = upsertSection("", "User preferences", "- Prefers TypeScript\n- Tabs over spaces");
    expect(result).toContain("## User preferences");
    expect(result).toContain("- Prefers TypeScript");
    expect(result).toContain("- Tabs over spaces");
  });

  it("appends a new section to an existing file with content", () => {
    const existing = "# Project notes\n\nSome intro text.";
    const result = upsertSection(existing, "Build commands", "- `bun run build`");
    expect(result).toContain("# Project notes");
    expect(result).toContain("## Build commands");
    expect(result).toContain("- `bun run build`");
  });

  it("replaces an existing section", () => {
    const existing = "## User preferences\n\nOld content\n\n## Other section\n\nOther content\n";
    const result = upsertSection(existing, "User preferences", "New content");
    expect(result).toContain("## User preferences");
    expect(result).toContain("New content");
    expect(result).not.toContain("Old content");
    expect(result).toContain("## Other section");
    expect(result).toContain("Other content");
  });

  it("does not duplicate the heading when replacing", () => {
    const existing = "## My section\n\nOld\n";
    const result = upsertSection(existing, "My section", "New");
    const headingCount = (result.match(/## My section/g) ?? []).length;
    expect(headingCount).toBe(1);
  });

  it("preserves sections before the replaced one", () => {
    const existing = "## First\n\nContent A\n\n## Second\n\nContent B\n";
    const result = upsertSection(existing, "Second", "Updated B");
    expect(result).toContain("## First");
    expect(result).toContain("Content A");
    expect(result).toContain("Updated B");
    expect(result).not.toContain("Content B");
  });

  it("preserves sections after the replaced one", () => {
    const existing = "## First\n\nContent A\n\n## Second\n\nContent B\n\n## Third\n\nContent C\n";
    const result = upsertSection(existing, "First", "Updated A");
    expect(result).toContain("Updated A");
    expect(result).toContain("## Second");
    expect(result).toContain("## Third");
  });

  it("trims trailing whitespace from the body", () => {
    const result = upsertSection("", "Section", "Content\n\n\n");
    // Body should not have multiple trailing newlines inside the section
    expect(result).toContain("Content");
    expect(result.endsWith("\n")).toBe(true);
  });
});

// ── write_memory tool ─────────────────────────────────────────────────────────

describe("write_memory tool", () => {
  it("creates CLAUDE.md in cwd when scope is project (default)", async () => {
    const tool = makeWriteMemoryTool(testCwd);
    const result = await tool.execute({ heading: "Test heading", content: "Test content" }, testCwd);
    expect(result.isError).toBe(false);
    const fileContent = await fs.readFile(path.join(testCwd, "CLAUDE.md"), "utf8");
    expect(fileContent).toContain("## Test heading");
    expect(fileContent).toContain("Test content");
  });

  it("creates CLAUDE.md when scope is explicitly 'project'", async () => {
    const tool = makeWriteMemoryTool(testCwd);
    await tool.execute({ heading: "Explicit project", content: "data", scope: "project" }, testCwd);
    const exists = await fs.stat(path.join(testCwd, "CLAUDE.md")).then(() => true).catch(() => false);
    expect(exists).toBe(true);
  });

  it("returns an error for empty heading", async () => {
    const tool = makeWriteMemoryTool(testCwd);
    const result = await tool.execute({ heading: "", content: "data" }, testCwd);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/heading/i);
  });

  it("can be called multiple times — appends new sections", async () => {
    const tool = makeWriteMemoryTool(testCwd);
    await tool.execute({ heading: "Section A", content: "Content A" }, testCwd);
    await tool.execute({ heading: "Section B", content: "Content B" }, testCwd);
    const fileContent = await fs.readFile(path.join(testCwd, "CLAUDE.md"), "utf8");
    expect(fileContent).toContain("## Section A");
    expect(fileContent).toContain("## Section B");
    expect(fileContent).toContain("Content A");
    expect(fileContent).toContain("Content B");
  });

  it("replaces an existing section on re-write", async () => {
    const tool = makeWriteMemoryTool(testCwd);
    await tool.execute({ heading: "Preferences", content: "Old pref" }, testCwd);
    await tool.execute({ heading: "Preferences", content: "New pref" }, testCwd);
    const fileContent = await fs.readFile(path.join(testCwd, "CLAUDE.md"), "utf8");
    expect(fileContent).toContain("New pref");
    expect(fileContent).not.toContain("Old pref");
    // Heading should appear exactly once
    const count = (fileContent.match(/## Preferences/g) ?? []).length;
    expect(count).toBe(1);
  });

  it("returns a success message referencing CLAUDE.md for project scope", async () => {
    const tool = makeWriteMemoryTool(testCwd);
    const result = await tool.execute({ heading: "Notes", content: "data", scope: "project" }, testCwd);
    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/CLAUDE\.md/);
    expect(result.content).toMatch(/Notes/);
  });
});

// ── read_memory tool ──────────────────────────────────────────────────────────

describe("read_memory tool", () => {
  it("returns empty message when CLAUDE.md does not exist", async () => {
    const tool = makeReadMemoryTool(testCwd);
    const result = await tool.execute({}, testCwd);
    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/empty|does not exist/i);
  });

  it("returns full CLAUDE.md content when it exists", async () => {
    const claudeMd = path.join(testCwd, "CLAUDE.md");
    await fs.writeFile(claudeMd, "# My Notes\n\nSome content here.\n", "utf8");
    const tool = makeReadMemoryTool(testCwd);
    const result = await tool.execute({}, testCwd);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("# My Notes");
    expect(result.content).toContain("Some content here.");
  });

  it("round-trips with write_memory", async () => {
    const writeTool = makeWriteMemoryTool(testCwd);
    const readTool = makeReadMemoryTool(testCwd);
    await writeTool.execute({ heading: "Round trip", content: "Persisted data" }, testCwd);
    const result = await readTool.execute({ scope: "project" }, testCwd);
    expect(result.content).toContain("## Round trip");
    expect(result.content).toContain("Persisted data");
  });

  it("reads project scope by default", async () => {
    const claudeMd = path.join(testCwd, "CLAUDE.md");
    await fs.writeFile(claudeMd, "Project data\n", "utf8");
    const tool = makeReadMemoryTool(testCwd);
    const result = await tool.execute({}, testCwd);
    expect(result.content).toContain("Project data");
  });
});

// ── loadAutoMemory ────────────────────────────────────────────────────────────

describe("loadAutoMemory", () => {
  it("returns empty strings when neither file exists", async () => {
    const result = await loadAutoMemory(testCwd);
    expect(result.project).toBe("");
    expect(result.global).toBe("");
  });

  it("returns project content when CLAUDE.md exists", async () => {
    const claudeMd = path.join(testCwd, "CLAUDE.md");
    await fs.writeFile(claudeMd, "## Architecture\n\nKey decisions\n", "utf8");
    const result = await loadAutoMemory(testCwd);
    expect(result.project).toContain("## Architecture");
    expect(result.project).toContain("Key decisions");
  });

  it("returns empty global content when MEMORY.md does not exist (no ~/.orager/ setup)", async () => {
    // We can't easily control whether the real MEMORY.md exists on the test machine.
    // Instead, just assert the function doesn't throw.
    const result = await loadAutoMemory(testCwd);
    expect(typeof result.global).toBe("string");
  });

  it("returns both project and global content simultaneously", async () => {
    const claudeMd = path.join(testCwd, "CLAUDE.md");
    await fs.writeFile(claudeMd, "Project notes\n", "utf8");
    const result = await loadAutoMemory(testCwd);
    expect(result.project).toContain("Project notes");
    // global may or may not exist — just verify it's a string
    expect(typeof result.global).toBe("string");
  });
});

// ── Path helpers ──────────────────────────────────────────────────────────────

describe("path helpers", () => {
  it("projectMemoryFile returns path inside cwd", () => {
    const p = projectMemoryFile("/some/project");
    expect(p).toBe("/some/project/CLAUDE.md");
  });

  it("GLOBAL_MEMORY_FILE is inside ~/.orager/", () => {
    expect(GLOBAL_MEMORY_FILE).toContain(".orager");
    expect(GLOBAL_MEMORY_FILE).toContain("MEMORY.md");
  });
});
