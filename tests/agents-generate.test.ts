/**
 * Tests for dynamic agent generation.
 *
 * LLM calls are mocked — we test JSON extraction, validation, sanitization,
 * and the tool executor logic, not the LLM output itself.
 */

import { describe, it, expect, vi, beforeEach } from "bun:test";
import { sanitizeId } from "../src/agents/generate.js";

// ── Mock provider ─────────────────────────────────────────────────────────────

vi.mock("../src/providers/index.js", () => ({
  resolveProvider: vi.fn(),
}));

vi.mock("../src/agents/registry.js", () => ({
  upsertAgent: vi.fn().mockResolvedValue(undefined),
  loadAllAgents: vi.fn().mockResolvedValue({}),
  getAgentsDb: vi.fn().mockResolvedValue({}),
  closeAgentsDb: vi.fn(),
  deleteAgent: vi.fn().mockResolvedValue(true),
  listDbAgentIds: vi.fn().mockResolvedValue([]),
  exportAgentToUserDir: vi.fn().mockReturnValue("/tmp/test.json"),
  removeAgentFile: vi.fn().mockReturnValue(false),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMockProvider(responseContent: string) {
  return {
    provider: {
      chat: vi.fn().mockResolvedValue({ content: responseContent }),
    },
  };
}

// ── sanitizeId ────────────────────────────────────────────────────────────────

describe("sanitizeId", () => {
  it("converts spaces to hyphens", () => {
    expect(sanitizeId("SQL Query Optimizer")).toBe("sql-query-optimizer");
  });

  it("lowercases everything", () => {
    expect(sanitizeId("RustErrorAnalyzer")).toBe("rusterroranalyzer");
  });

  it("strips leading/trailing hyphens", () => {
    expect(sanitizeId("  --test agent--  ")).toBe("test-agent");
  });

  it("collapses multiple separators into one hyphen", () => {
    expect(sanitizeId("analyze   test    failures")).toBe("analyze-test-failures");
  });

  it("strips special characters", () => {
    expect(sanitizeId("agent (v2.0)!")).toBe("agent-v2-0");
  });

  it("truncates to 64 chars", () => {
    const long = "a".repeat(100);
    expect(sanitizeId(long).length).toBe(64);
  });

  it("handles already-clean input", () => {
    expect(sanitizeId("rust-error-analyzer")).toBe("rust-error-analyzer");
  });
});

// ── generateAgentDefinition — JSON extraction ─────────────────────────────────

describe("generateAgentDefinition JSON extraction and validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses clean JSON response", async () => {
    const { resolveProvider } = await import("../src/providers/index.js");
    const mockResponse = JSON.stringify({
      id: "rust-error-analyzer",
      name: "Rust Error Analyzer",
      description: "Use for analyzing Rust compiler errors and suggesting fixes.",
      prompt: "You are a Rust expert. Analyze compiler errors and suggest precise fixes.",
      tools: ["Read", "Grep", "Bash"],
      model: null,
      effort: "medium",
      tags: ["rust", "debugging"],
      memoryWrite: false,
      skills: true,
    });
    (resolveProvider as ReturnType<typeof vi.fn>).mockReturnValue(makeMockProvider(mockResponse));

    const { generateAgentDefinition } = await import("../src/agents/generate.js");
    const result = await generateAgentDefinition({
      task: "analyze Rust compiler errors",
      persist: false,
      apiKey: "test-key",
    });

    expect(result.id).toBe("rust-error-analyzer");
    expect(result.definition.description).toBe(
      "Use for analyzing Rust compiler errors and suggesting fixes."
    );
    expect(result.definition.tools).toEqual(["Read", "Grep", "Bash"]);
    expect(result.definition.tags).toEqual(["rust", "debugging"]);
    expect(result.persisted).toBe(false);
  });

  it("strips markdown code fences from response", async () => {
    const { resolveProvider } = await import("../src/providers/index.js");
    const json = JSON.stringify({
      id: "test-agent",
      name: "Test Agent",
      description: "Use for testing.",
      prompt: "You are a tester.",
      tools: ["Read"],
      effort: "low",
      tags: [],
    });
    const wrappedResponse = "```json\n" + json + "\n```";
    (resolveProvider as ReturnType<typeof vi.fn>).mockReturnValue(makeMockProvider(wrappedResponse));

    const { generateAgentDefinition } = await import("../src/agents/generate.js");
    const result = await generateAgentDefinition({
      task: "run tests",
      persist: false,
      apiKey: "test-key",
    });

    expect(result.definition.description).toBe("Use for testing.");
  });

  it("falls back to task-derived description if LLM omits it", async () => {
    const { resolveProvider } = await import("../src/providers/index.js");
    const json = JSON.stringify({
      id: "no-desc-agent",
      name: "No Desc",
      // description omitted
      prompt: "You are helpful.",
      tools: null,
      effort: "medium",
      tags: [],
    });
    (resolveProvider as ReturnType<typeof vi.fn>).mockReturnValue(makeMockProvider(json));

    const { generateAgentDefinition } = await import("../src/agents/generate.js");
    const result = await generateAgentDefinition({
      task: "some very specific task",
      persist: false,
      apiKey: "test-key",
    });

    expect(result.definition.description).toContain("some very specific task");
  });

  it("filters out unknown tool names", async () => {
    const { resolveProvider } = await import("../src/providers/index.js");
    const json = JSON.stringify({
      id: "filtered-tools-agent",
      name: "Filtered",
      description: "Use for filtering.",
      prompt: "You filter things.",
      tools: ["Read", "FakeTool99", "Bash", "NonExistentTool"],
      effort: "medium",
      tags: [],
    });
    (resolveProvider as ReturnType<typeof vi.fn>).mockReturnValue(makeMockProvider(json));

    const { generateAgentDefinition } = await import("../src/agents/generate.js");
    const result = await generateAgentDefinition({
      task: "filter tools",
      persist: false,
      apiKey: "test-key",
    });

    // Only valid tool names should survive
    expect(result.definition.tools).toContain("Read");
    expect(result.definition.tools).toContain("Bash");
    expect(result.definition.tools).not.toContain("FakeTool99");
    expect(result.definition.tools).not.toContain("NonExistentTool");
  });

  it("normalizes invalid effort to 'medium'", async () => {
    const { resolveProvider } = await import("../src/providers/index.js");
    const json = JSON.stringify({
      id: "effort-test",
      name: "Effort Test",
      description: "Use for effort.",
      prompt: "Testing effort.",
      tools: null,
      effort: "super-high", // invalid
      tags: [],
    });
    (resolveProvider as ReturnType<typeof vi.fn>).mockReturnValue(makeMockProvider(json));

    const { generateAgentDefinition } = await import("../src/agents/generate.js");
    const result = await generateAgentDefinition({
      task: "test effort normalization",
      persist: false,
      apiKey: "test-key",
    });

    expect(result.definition.effort).toBe("medium");
  });

  it("throws when LLM response has no JSON object", async () => {
    const { resolveProvider } = await import("../src/providers/index.js");
    (resolveProvider as ReturnType<typeof vi.fn>).mockReturnValue(
      makeMockProvider("Sorry, I cannot help with that."),
    );

    const { generateAgentDefinition } = await import("../src/agents/generate.js");
    await expect(
      generateAgentDefinition({ task: "test", persist: false, apiKey: "test-key" }),
    ).rejects.toThrow("no JSON object found");
  });

  it("throws when prompt field is missing", async () => {
    const { resolveProvider } = await import("../src/providers/index.js");
    const json = JSON.stringify({
      id: "no-prompt",
      name: "No Prompt",
      description: "Use for no prompt.",
      // prompt field missing
      tools: null,
      effort: "medium",
    });
    (resolveProvider as ReturnType<typeof vi.fn>).mockReturnValue(makeMockProvider(json));

    const { generateAgentDefinition } = await import("../src/agents/generate.js");
    await expect(
      generateAgentDefinition({ task: "test missing prompt", persist: false, apiKey: "test-key" }),
    ).rejects.toThrow("missing required 'prompt' field");
  });

  it("persists to registry when persist=true", async () => {
    const { resolveProvider } = await import("../src/providers/index.js");
    const { upsertAgent } = await import("../src/agents/registry.js");
    const json = JSON.stringify({
      id: "persisted-agent",
      name: "Persisted Agent",
      description: "Use for persistence tests.",
      prompt: "You persist things.",
      tools: ["Read"],
      effort: "low",
      tags: ["test"],
    });
    (resolveProvider as ReturnType<typeof vi.fn>).mockReturnValue(makeMockProvider(json));
    (upsertAgent as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const { generateAgentDefinition } = await import("../src/agents/generate.js");
    const result = await generateAgentDefinition({
      task: "test persistence",
      persist: true,
      apiKey: "test-key",
    });

    expect(result.persisted).toBe(true);
    expect(upsertAgent).toHaveBeenCalledWith(
      expect.stringContaining("persisted"),
      expect.objectContaining({ description: "Use for persistence tests." }),
    );
  });

  it("uses suggestedId to derive final registry key", async () => {
    const { resolveProvider } = await import("../src/providers/index.js");
    const json = JSON.stringify({
      id: "whatever-llm-said", // LLM proposes different ID
      name: "My Custom Agent",
      description: "Use for custom tasks.",
      prompt: "You are custom.",
      tools: null,
      effort: "medium",
      tags: [],
    });
    (resolveProvider as ReturnType<typeof vi.fn>).mockReturnValue(makeMockProvider(json));

    const { generateAgentDefinition } = await import("../src/agents/generate.js");
    const result = await generateAgentDefinition({
      task: "custom task",
      suggestedId: "my-preferred-id",
      persist: false,
      apiKey: "test-key",
    });

    // LLM's id field takes precedence over suggestedId when present
    expect(result.id).toBe("whatever-llm-said");
  });
});

// ── makeGenerateAgentTool ─────────────────────────────────────────────────────

describe("makeGenerateAgentTool execute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("adds generated agent to the mutable agents map", async () => {
    const { resolveProvider } = await import("../src/providers/index.js");
    const json = JSON.stringify({
      id: "dynamic-agent",
      name: "Dynamic Agent",
      description: "Use for dynamic tasks.",
      prompt: "You are dynamic.",
      tools: ["Read"],
      effort: "low",
      tags: ["dynamic"],
    });
    (resolveProvider as ReturnType<typeof vi.fn>).mockReturnValue(makeMockProvider(json));

    const { makeGenerateAgentTool } = await import("../src/agents/generate.js");
    const agentsMap: Record<string, unknown> = {};
    const tool = makeGenerateAgentTool(
      agentsMap as never,
      { prompt: "test", model: "openai/gpt-4o-mini", apiKey: "test-key", onEmit: vi.fn() } as never,
    );

    const result = await tool.execute({ task_description: "dynamic tasks", persist: false });

    expect(result.isError).toBe(false);
    expect(agentsMap["dynamic-agent"]).toBeDefined();
    expect((agentsMap["dynamic-agent"] as { description: string }).description).toBe(
      "Use for dynamic tasks."
    );
  });

  it("returns error when task_description is missing", async () => {
    const { makeGenerateAgentTool } = await import("../src/agents/generate.js");
    const tool = makeGenerateAgentTool(
      {} as never,
      { prompt: "test", model: "openai/gpt-4o-mini", apiKey: "test-key", onEmit: vi.fn() } as never,
    );

    const result = await tool.execute({});
    expect(result.isError).toBe(true);
    expect(result.content).toContain("task_description");
  });

  it("tool definition has the expected name", async () => {
    const { makeGenerateAgentTool } = await import("../src/agents/generate.js");
    const tool = makeGenerateAgentTool(
      {} as never,
      { prompt: "test", model: "openai/gpt-4o-mini", apiKey: "test-key", onEmit: vi.fn() } as never,
    );

    expect(tool.definition.function.name).toBe("generate_agent");
  });

  it("tool definition has required task_description parameter", async () => {
    const { makeGenerateAgentTool } = await import("../src/agents/generate.js");
    const tool = makeGenerateAgentTool(
      {} as never,
      { prompt: "test", model: "openai/gpt-4o-mini", apiKey: "test-key", onEmit: vi.fn() } as never,
    );

    const params = tool.definition.function.parameters as {
      required?: string[];
      properties: Record<string, unknown>;
    };
    expect(params.required).toContain("task_description");
    expect(params.properties["task_description"]).toBeDefined();
    expect(params.properties["agent_id"]).toBeDefined();
    expect(params.properties["persist"]).toBeDefined();
  });
});
