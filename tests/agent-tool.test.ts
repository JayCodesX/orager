/**
 * Tests for the dynamic Agent tool (ADR-0010).
 *
 * makeAgentTool() and buildAgentsSystemPrompt() are exercised here.
 * runAgentLoop is mocked — these tests verify:
 *   - Agent tool definition (schema) is built correctly from agent definitions
 *   - Unknown subagent_type returns an error result
 *   - Depth limit is enforced (default 3)
 *   - Sub-agent receives correct inherited options
 *   - Sub-agent collects and returns final text output
 *   - Memory write is suppressed by default; opt-in via memoryWrite: true
 *   - Skills are inherited; opt-out via skills: false
 *   - Tool allow-list is forwarded via _allowedTools
 *   - onEmit events are tagged with _subagentType
 *   - buildAgentsSystemPrompt returns empty string for no agents
 *   - buildAgentsSystemPrompt includes agent names and descriptions
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentLoopOptions, EmitEvent } from "../src/types.js";
import { makeAgentTool, buildAgentsSystemPrompt } from "../src/tools/agent.js";
import { mocked } from "./mock-helpers.js";

// ── Mock runAgentLoop (lazy-imported inside execute) ─────────────────────────

vi.mock("../src/loop.js", () => ({
  runAgentLoop: vi.fn(),
}));

import { runAgentLoop } from "../src/loop.js";
const mockRunAgentLoop = mocked(runAgentLoop);

// ── Mock telemetry so withSpan is transparent ─────────────────────────────────
vi.mock("../src/telemetry.js", () => ({
  withSpan: async (_name: string, _attrs: unknown, fn: () => Promise<unknown>) => fn(),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeParentOpts(overrides: Partial<AgentLoopOptions> = {}): AgentLoopOptions {
  return {
    prompt: "parent prompt",
    model: "anthropic/claude-sonnet-4-6",
    apiKey: "test-key",
    sessionId: null,
    addDirs: [],
    maxTurns: 10,
    cwd: "/tmp",
    dangerouslySkipPermissions: false,
    verbose: false,
    onEmit: vi.fn(),
    ...overrides,
  };
}

/** Make runAgentLoop emit an assistant text event then resolve. */
function stubOutput(text: string) {
  mockRunAgentLoop.mockImplementationOnce(async (opts: AgentLoopOptions) => {
    opts.onEmit({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text }] },
    } as EmitEvent);
  });
}

const EXEC_OPTS = { toolCallId: "call-123" };

beforeEach(() => {
  mockRunAgentLoop.mockReset();
  mockRunAgentLoop.mockResolvedValue(undefined);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("makeAgentTool", () => {
  describe("tool definition", () => {
    it("uses the name 'Agent'", () => {
      const tool = makeAgentTool({ researcher: { description: "Does research", prompt: "" } }, makeParentOpts());
      expect(tool.definition.function.name).toBe("Agent");
    });

    it("includes each agent name in the subagent_type enum", () => {
      const tool = makeAgentTool(
        {
          researcher: { description: "Does research", prompt: "" },
          coder: { description: "Writes code", prompt: "" },
        },
        makeParentOpts(),
      );
      const schema = tool.definition.function.parameters as Record<string, unknown>;
      const props = schema["properties"] as Record<string, { enum?: string[] }>;
      expect(props["subagent_type"]?.enum).toEqual(["researcher", "coder"]);
    });

    it("lists agent descriptions in the tool description", () => {
      const tool = makeAgentTool(
        { analyst: { description: "Analyses data", prompt: "" } },
        makeParentOpts(),
      );
      expect(tool.definition.function.description).toContain("analyst");
      expect(tool.definition.function.description).toContain("Analyses data");
    });
  });

  describe("execute — error cases", () => {
    it("returns error for unknown subagent_type", async () => {
      const tool = makeAgentTool({ researcher: { description: "R", prompt: "" } }, makeParentOpts());
      const result = await (tool.execute as Function)({ subagent_type: "ghost", prompt: "hi" }, "/tmp", EXEC_OPTS);
      expect(result.isError).toBe(true);
      expect(result.content).toContain("ghost");
      expect(result.toolCallId).toBe("call-123");
    });

    it("enforces default depth limit of 3", async () => {
      const parentOpts = makeParentOpts({ _spawnDepth: 3 });
      const tool = makeAgentTool({ researcher: { description: "R", prompt: "" } }, parentOpts);
      const result = await (tool.execute as Function)({ subagent_type: "researcher", prompt: "hi" }, "/tmp", EXEC_OPTS);
      expect(result.isError).toBe(true);
      expect(result.content).toContain("depth limit");
      expect(result.toolCallId).toBe("call-123");
    });

    it("respects custom maxSpawnDepth", async () => {
      const parentOpts = makeParentOpts({ _spawnDepth: 2, maxSpawnDepth: 2 });
      const tool = makeAgentTool({ researcher: { description: "R", prompt: "" } }, parentOpts);
      const result = await (tool.execute as Function)({ subagent_type: "researcher", prompt: "hi" }, "/tmp", EXEC_OPTS);
      expect(result.isError).toBe(true);
    });

    it("allows spawn when depth is below limit", async () => {
      const parentOpts = makeParentOpts({ _spawnDepth: 0, maxSpawnDepth: 3 });
      const tool = makeAgentTool({ researcher: { description: "R", prompt: "" } }, parentOpts);
      const result = await (tool.execute as Function)({ subagent_type: "researcher", prompt: "hi" }, "/tmp", EXEC_OPTS);
      expect(result.isError).toBe(false);
    });
  });

  describe("execute — sub-agent spawning", () => {
    it("passes toolCallId through to successful result", async () => {
      stubOutput("done");
      const tool = makeAgentTool({ researcher: { description: "R", prompt: "" } }, makeParentOpts());
      const result = await (tool.execute as Function)({ subagent_type: "researcher", prompt: "hi" }, "/tmp", { toolCallId: "xyz-999" });
      expect(result.toolCallId).toBe("xyz-999");
      expect(result.isError).toBe(false);
    });

    it("returns sub-agent's final text output", async () => {
      stubOutput("the final answer");
      const tool = makeAgentTool({ researcher: { description: "R", prompt: "" } }, makeParentOpts());
      const result = await (tool.execute as Function)({ subagent_type: "researcher", prompt: "question" }, "/tmp", EXEC_OPTS);
      expect(result.content).toBe("the final answer");
    });

    it("returns fallback message when sub-agent emits no text", async () => {
      const tool = makeAgentTool({ researcher: { description: "R", prompt: "" } }, makeParentOpts());
      const result = await (tool.execute as Function)({ subagent_type: "researcher", prompt: "hi" }, "/tmp", EXEC_OPTS);
      expect(result.content).toContain("completed with no text output");
    });

    it("concatenates agent system prompt with user prompt", async () => {
      const tool = makeAgentTool(
        { researcher: { description: "R", prompt: "You are a research expert." } },
        makeParentOpts(),
      );
      await (tool.execute as Function)({ subagent_type: "researcher", prompt: "find facts" }, "/tmp", EXEC_OPTS);
      const subOpts = mockRunAgentLoop.mock.calls[0]![0];
      expect(subOpts.prompt).toContain("You are a research expert.");
      expect(subOpts.prompt).toContain("find facts");
    });

    it("uses agent-defined model override", async () => {
      const tool = makeAgentTool(
        { fast: { description: "F", prompt: "", model: "deepseek/deepseek-r1" } },
        makeParentOpts({ model: "anthropic/claude-sonnet-4-6" }),
      );
      await (tool.execute as Function)({ subagent_type: "fast", prompt: "go" }, "/tmp", EXEC_OPTS);
      const subOpts = mockRunAgentLoop.mock.calls[0]![0];
      expect(subOpts.model).toBe("deepseek/deepseek-r1");
    });

    it("falls back to parent model when agent has no model override", async () => {
      const tool = makeAgentTool(
        { plain: { description: "P", prompt: "" } },
        makeParentOpts({ model: "anthropic/claude-opus" }),
      );
      await (tool.execute as Function)({ subagent_type: "plain", prompt: "go" }, "/tmp", EXEC_OPTS);
      const subOpts = mockRunAgentLoop.mock.calls[0]![0];
      expect(subOpts.model).toBe("anthropic/claude-opus");
    });

    it("increments _spawnDepth by 1", async () => {
      const parentOpts = makeParentOpts({ _spawnDepth: 1 });
      const tool = makeAgentTool({ child: { description: "C", prompt: "" } }, parentOpts);
      await (tool.execute as Function)({ subagent_type: "child", prompt: "go" }, "/tmp", EXEC_OPTS);
      const subOpts = mockRunAgentLoop.mock.calls[0]![0];
      expect(subOpts._spawnDepth).toBe(2);
    });

    it("sub-agent has no agents map (no recursive spawning)", async () => {
      const tool = makeAgentTool(
        { worker: { description: "W", prompt: "" } },
        makeParentOpts(),
      );
      await (tool.execute as Function)({ subagent_type: "worker", prompt: "go" }, "/tmp", EXEC_OPTS);
      const subOpts = mockRunAgentLoop.mock.calls[0]![0];
      expect(subOpts.agents).toBeUndefined();
    });

    it("sub-agent has sessionId: null", async () => {
      const tool = makeAgentTool({ worker: { description: "W", prompt: "" } }, makeParentOpts());
      await (tool.execute as Function)({ subagent_type: "worker", prompt: "go" }, "/tmp", EXEC_OPTS);
      const subOpts = mockRunAgentLoop.mock.calls[0]![0];
      expect(subOpts.sessionId).toBeNull();
    });

    it("sub-agent has readProjectInstructions: false", async () => {
      const tool = makeAgentTool({ worker: { description: "W", prompt: "" } }, makeParentOpts());
      await (tool.execute as Function)({ subagent_type: "worker", prompt: "go" }, "/tmp", EXEC_OPTS);
      const subOpts = mockRunAgentLoop.mock.calls[0]![0];
      expect(subOpts.readProjectInstructions).toBe(false);
    });
  });

  describe("memory behaviour", () => {
    it("suppresses memory writes by default (_suppressMemoryWrite: true)", async () => {
      const tool = makeAgentTool({ a: { description: "A", prompt: "" } }, makeParentOpts());
      await (tool.execute as Function)({ subagent_type: "a", prompt: "go" }, "/tmp", EXEC_OPTS);
      const subOpts = mockRunAgentLoop.mock.calls[0]![0];
      expect(subOpts._suppressMemoryWrite).toBe(true);
    });

    it("opts in to memory writes when memoryWrite: true", async () => {
      const tool = makeAgentTool(
        { writer: { description: "W", prompt: "", memoryWrite: true } },
        makeParentOpts(),
      );
      await (tool.execute as Function)({ subagent_type: "writer", prompt: "go" }, "/tmp", EXEC_OPTS);
      const subOpts = mockRunAgentLoop.mock.calls[0]![0];
      expect(subOpts._suppressMemoryWrite).toBe(false);
    });

    it("inherits parent memoryKey by default", async () => {
      const tool = makeAgentTool(
        { a: { description: "A", prompt: "" } },
        makeParentOpts({ memoryKey: "parent-ns" }),
      );
      await (tool.execute as Function)({ subagent_type: "a", prompt: "go" }, "/tmp", EXEC_OPTS);
      const subOpts = mockRunAgentLoop.mock.calls[0]![0];
      expect(subOpts.memoryKey).toBe("parent-ns");
    });

    it("uses agent-defined memoryKey when provided", async () => {
      const tool = makeAgentTool(
        { a: { description: "A", prompt: "", memoryKey: "agent-ns" } },
        makeParentOpts({ memoryKey: "parent-ns" }),
      );
      await (tool.execute as Function)({ subagent_type: "a", prompt: "go" }, "/tmp", EXEC_OPTS);
      const subOpts = mockRunAgentLoop.mock.calls[0]![0];
      expect(subOpts.memoryKey).toBe("agent-ns");
    });
  });

  describe("skills behaviour", () => {
    it("inherits skillbank by default", async () => {
      const skillbank = { enabled: true, path: "/skills" } as AgentLoopOptions["skillbank"];
      const tool = makeAgentTool(
        { a: { description: "A", prompt: "" } },
        makeParentOpts({ skillbank }),
      );
      await (tool.execute as Function)({ subagent_type: "a", prompt: "go" }, "/tmp", EXEC_OPTS);
      const subOpts = mockRunAgentLoop.mock.calls[0]![0];
      expect(subOpts.skillbank).toEqual(skillbank);
    });

    it("disables skills when skills: false", async () => {
      const skillbank = { enabled: true, path: "/skills" } as AgentLoopOptions["skillbank"];
      const tool = makeAgentTool(
        { a: { description: "A", prompt: "", skills: false } },
        makeParentOpts({ skillbank }),
      );
      await (tool.execute as Function)({ subagent_type: "a", prompt: "go" }, "/tmp", EXEC_OPTS);
      const subOpts = mockRunAgentLoop.mock.calls[0]![0];
      expect((subOpts.skillbank as { enabled: boolean })?.enabled).toBe(false);
    });
  });

  describe("tool filtering", () => {
    it("forwards _allowedTools when tools list is set on AgentDefinition", async () => {
      const tool = makeAgentTool(
        { coder: { description: "C", prompt: "", tools: ["Bash", "Read"] } },
        makeParentOpts(),
      );
      await (tool.execute as Function)({ subagent_type: "coder", prompt: "go" }, "/tmp", EXEC_OPTS);
      const subOpts = mockRunAgentLoop.mock.calls[0]![0] as AgentLoopOptions & { _allowedTools?: string[] };
      expect(subOpts._allowedTools).toEqual(["Bash", "Read"]);
    });

    it("does not set _allowedTools when tools list is undefined", async () => {
      const tool = makeAgentTool({ coder: { description: "C", prompt: "" } }, makeParentOpts());
      await (tool.execute as Function)({ subagent_type: "coder", prompt: "go" }, "/tmp", EXEC_OPTS);
      const subOpts = mockRunAgentLoop.mock.calls[0]![0] as AgentLoopOptions & { _allowedTools?: string[] };
      expect(subOpts._allowedTools).toBeUndefined();
    });
  });

  describe("event tagging", () => {
    it("tags forwarded events with _subagentType", async () => {
      const emitted: unknown[] = [];
      const parentOnEmit = vi.fn((e: unknown) => emitted.push(e));
      const parentOpts = makeParentOpts({ onEmit: parentOnEmit });

      mockRunAgentLoop.mockImplementationOnce(async (opts: AgentLoopOptions) => {
        opts.onEmit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } } as EmitEvent);
      });

      const tool = makeAgentTool({ reporter: { description: "R", prompt: "" } }, parentOpts);
      await (tool.execute as Function)({ subagent_type: "reporter", prompt: "go" }, "/tmp", EXEC_OPTS);

      expect(parentOnEmit).toHaveBeenCalled();
      const tagged = emitted[0] as Record<string, unknown>;
      expect(tagged["_subagentType"]).toBe("reporter");
    });
  });
});

// ── buildAgentsSystemPrompt ───────────────────────────────────────────────────

describe("buildAgentsSystemPrompt", () => {
  it("returns empty string when agents map is empty", () => {
    expect(buildAgentsSystemPrompt({})).toBe("");
  });

  it("includes section header and agent names", () => {
    const result = buildAgentsSystemPrompt({
      researcher: { description: "Finds information", prompt: "" },
    });
    expect(result).toContain("Sub-Agents");
    expect(result).toContain("researcher");
    expect(result).toContain("Finds information");
  });

  it("includes model hint when agent has a model override", () => {
    const result = buildAgentsSystemPrompt({
      fast: { description: "Quick tasks", prompt: "", model: "deepseek/deepseek-r1" },
    });
    expect(result).toContain("deepseek/deepseek-r1");
  });

  it("includes delegation guidelines", () => {
    const result = buildAgentsSystemPrompt({
      a: { description: "A", prompt: "" },
    });
    expect(result).toContain("Delegation");
  });
});
