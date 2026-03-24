import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadToolsFromFile } from "../src/tools/load-tools.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orager-load-tools-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function writeTools(filename: string, content: unknown): Promise<string> {
  const file = path.join(tmpDir, filename);
  await fs.writeFile(file, JSON.stringify(content), "utf8");
  return file;
}

// ── Error cases ───────────────────────────────────────────────────────────────

describe("loadToolsFromFile — errors", () => {
  it("throws for a missing file", async () => {
    await expect(
      loadToolsFromFile(path.join(tmpDir, "nonexistent.json"))
    ).rejects.toThrow("Cannot read tools file");
  });

  it("throws for invalid JSON", async () => {
    const file = path.join(tmpDir, "bad.json");
    await fs.writeFile(file, "{ not valid json", "utf8");
    await expect(loadToolsFromFile(file)).rejects.toThrow("Invalid JSON");
  });

  it("throws when root is an object, not an array", async () => {
    const file = await writeTools("obj.json", { name: "x", description: "y", exec: "z" });
    await expect(loadToolsFromFile(file)).rejects.toThrow("must contain a JSON array");
  });

  it("throws when a spec is missing name", async () => {
    const file = await writeTools("bad-spec.json", [
      { description: "desc", exec: "echo hi" },
    ]);
    await expect(loadToolsFromFile(file)).rejects.toThrow("name must be a non-empty string");
  });

  it("throws when a spec is missing exec", async () => {
    const file = await writeTools("bad-exec.json", [
      { name: "my_tool", description: "desc" },
    ]);
    await expect(loadToolsFromFile(file)).rejects.toThrow("exec must be a non-empty string");
  });
});

// ── Happy path ────────────────────────────────────────────────────────────────

describe("loadToolsFromFile — success", () => {
  it("returns an array of ToolExecutor objects", async () => {
    const file = await writeTools("tools.json", [
      { name: "greet", description: "Say hello", exec: "echo hello" },
    ]);
    const tools = await loadToolsFromFile(file);
    expect(tools).toHaveLength(1);
    expect(tools[0].definition.function.name).toBe("greet");
    expect(tools[0].definition.function.description).toBe("Say hello");
  });

  it("uses provided parameter schema", async () => {
    const parameters = {
      type: "object",
      properties: { name: { type: "string", description: "The name" } },
      required: ["name"],
    };
    const file = await writeTools("tools.json", [
      { name: "greet", description: "desc", exec: "echo {{name}}", parameters },
    ]);
    const tools = await loadToolsFromFile(file);
    expect(tools[0].definition.function.parameters).toEqual(parameters);
  });

  it("defaults to empty parameters schema when not provided", async () => {
    const file = await writeTools("tools.json", [
      { name: "noop", description: "desc", exec: "true" },
    ]);
    const tools = await loadToolsFromFile(file);
    expect(tools[0].definition.function.parameters).toEqual({ type: "object", properties: {} });
  });

  it("loads multiple tool specs", async () => {
    const file = await writeTools("tools.json", [
      { name: "tool_a", description: "A", exec: "echo a" },
      { name: "tool_b", description: "B", exec: "echo b" },
    ]);
    const tools = await loadToolsFromFile(file);
    expect(tools).toHaveLength(2);
    const names = tools.map((t) => t.definition.function.name);
    expect(names).toContain("tool_a");
    expect(names).toContain("tool_b");
  });
});

// ── Executor behaviour ─────────────────────────────────────────────────────────

describe("loadToolsFromFile — executor", () => {
  it("runs the exec command and returns stdout", async () => {
    const file = await writeTools("tools.json", [
      { name: "echo_tool", description: "Echo input", exec: "echo hello" },
    ]);
    const [tool] = await loadToolsFromFile(file);
    const result = await tool.execute({}, tmpDir);
    expect(result.isError).toBe(false);
    expect(result.content.trim()).toBe("hello");
  });

  it("interpolates {{param}} placeholders in the exec template", async () => {
    const file = await writeTools("tools.json", [
      {
        name: "greet",
        description: "Greet someone",
        exec: "echo 'Hello {{name}}'",
        parameters: {
          type: "object",
          properties: { name: { type: "string", description: "Name" } },
          required: ["name"],
        },
      },
    ]);
    const [tool] = await loadToolsFromFile(file);
    const result = await tool.execute({ name: "World" }, tmpDir);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Hello World");
  });

  it("returns isError=true when command exits non-zero", async () => {
    const file = await writeTools("tools.json", [
      { name: "fail_tool", description: "Fail", exec: "exit 1" },
    ]);
    const [tool] = await loadToolsFromFile(file);
    const result = await tool.execute({}, tmpDir);
    expect(result.isError).toBe(true);
  });
});

// ── Shell injection prevention ──────────────────────────────────────────────

describe("loadToolsFromFile — shell injection prevention", () => {
  it("shell-quotes values so semicolons cannot inject additional commands", async () => {
    const file = await writeTools("tools.json", [
      { name: "greet", description: "Greet", exec: "echo {{name}}", parameters: { type: "object", properties: { name: { type: "string", description: "" } } } },
    ]);
    const [tool] = await loadToolsFromFile(file);
    // Without quoting this would run: echo hello; rm -rf /
    const result = await tool.execute({ name: "hello; echo INJECTED" }, tmpDir);
    expect(result.isError).toBe(false);
    // The output should be the literal string echoed on one line, not two separate commands.
    // Injection would produce "hello\nINJECTED\n"; quoting produces "hello; echo INJECTED\n".
    expect(result.content.trim()).toBe("hello; echo INJECTED");
    // Ensure injection didn't split into a second line starting with INJECTED
    expect(result.content).not.toMatch(/\nINJECTED/);
  });

  it("shell-quotes values containing single quotes", async () => {
    const file = await writeTools("tools.json", [
      { name: "greet", description: "Greet", exec: "echo {{name}}", parameters: { type: "object", properties: { name: { type: "string", description: "" } } } },
    ]);
    const [tool] = await loadToolsFromFile(file);
    const result = await tool.execute({ name: "O'Brien" }, tmpDir);
    expect(result.isError).toBe(false);
    expect(result.content.trim()).toBe("O'Brien");
  });

  it("shell-quotes values containing backtick command substitution", async () => {
    const file = await writeTools("tools.json", [
      { name: "greet", description: "Greet", exec: "echo {{name}}", parameters: { type: "object", properties: { name: { type: "string", description: "" } } } },
    ]);
    const [tool] = await loadToolsFromFile(file);
    const result = await tool.execute({ name: "`id`" }, tmpDir);
    expect(result.isError).toBe(false);
    // Should output the literal backtick string, not the result of `id`
    expect(result.content.trim()).toBe("`id`");
  });

  it("shell-quotes values containing $() substitution", async () => {
    const file = await writeTools("tools.json", [
      { name: "greet", description: "Greet", exec: "echo {{name}}", parameters: { type: "object", properties: { name: { type: "string", description: "" } } } },
    ]);
    const [tool] = await loadToolsFromFile(file);
    const result = await tool.execute({ name: "$(id)" }, tmpDir);
    expect(result.isError).toBe(false);
    expect(result.content.trim()).toBe("$(id)");
  });
});
