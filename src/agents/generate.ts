/**
 * Dynamic agent generation — synthesize an AgentDefinition on demand.
 *
 * Uses a single LLM call with seed agents as few-shot examples to produce a
 * tailored AgentDefinition for any task type. The generated definition can be:
 *   - Used immediately (ephemeral, no persistence)
 *   - Persisted to the registry for future reuse (default)
 *
 * Integration points:
 *   1. Agent tool fallback — unknown subagent_type triggers generation
 *   2. generate_agent tool — parent LLM proactively synthesizes before delegating
 *   3. orager agents generate — CLI for offline generation and inspection
 *
 * Model selection: uses a cheap, capable default (gpt-4o-mini) so generation
 * doesn't cost more than the task itself. Override via GenerateAgentOptions.model.
 */

import { resolveProvider } from "../providers/index.js";
import type { ChatCallOptions } from "../providers/index.js";
import { SEED_AGENTS } from "./seeds.js";
import { upsertAgent } from "./registry.js";
import type { AgentDefinition } from "../types.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_GENERATION_MODEL = "openai/gpt-4o-mini";

// Tool names available for generated agents to reference.
// Resolved lazily (via getAvailableToolNames) to avoid the circular import:
//   tools/agent.ts → agents/generate.ts → tools/index.ts → tools/agent.ts
let _cachedToolNames: string[] | null = null;

async function getAvailableToolNames(): Promise<string[]> {
  if (_cachedToolNames) return _cachedToolNames;
  // Dynamic import breaks the circular dependency at runtime
  const { ALL_TOOLS } = await import("../tools/index.js");
  _cachedToolNames = ALL_TOOLS.map((t) => t.definition.function.name).filter(Boolean);
  return _cachedToolNames;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GenerateAgentOptions {
  /** Natural language description of the tasks this agent will handle. */
  task: string;
  /**
   * Model to use for the generation LLM call.
   * Defaults to gpt-4o-mini (cheap + capable for structured JSON output).
   */
  model?: string;
  /** OpenRouter / provider API key. Reads from env if omitted. */
  apiKey?: string;
  /**
   * Persist the generated definition to the DB registry.
   * Default true — generated agents are reused across sessions.
   */
  persist?: boolean;
  /**
   * Suggested registry key. Auto-derived from the generated name if omitted.
   * Sanitized to lowercase-with-hyphens.
   */
  suggestedId?: string;
  /**
   * Number of seed agents to include as few-shot examples.
   * Default 3 (explorer, planner, coder — covers the range of tool complexity).
   */
  numExamples?: number;
}

export interface GenerateAgentResult {
  /** Registry key (lowercase-with-hyphens). */
  id: string;
  /** The generated definition. */
  definition: AgentDefinition;
  /** Whether this was persisted to the registry. */
  persisted: boolean;
  /** Raw LLM response (useful for debugging). */
  rawResponse: string;
}

// Raw shape the LLM returns (before validation/normalization)
interface RawGenerated {
  id?: string;
  name?: string;
  description?: string;
  prompt?: string;
  tools?: string[] | null;
  disallowedTools?: string[] | null;
  model?: string | null;
  effort?: string | null;
  maxTurns?: number | null;
  maxCostUsd?: number | null;
  tags?: string[] | null;
  memoryWrite?: boolean | null;
  skills?: boolean | null;
  readProjectInstructions?: boolean | null;
}

// ── Core generation function ──────────────────────────────────────────────────

/**
 * Synthesize an AgentDefinition for the given task using a single LLM call.
 *
 * Uses seed agents as few-shot examples so the model understands the expected
 * structure and quality bar. Validates required fields and sanitizes tool names.
 *
 * Never throws for LLM/parse failures — returns an error in the result instead.
 */
export async function generateAgentDefinition(
  opts: GenerateAgentOptions,
): Promise<GenerateAgentResult> {
  const {
    task,
    model = DEFAULT_GENERATION_MODEL,
    apiKey = process.env["OPENROUTER_API_KEY"] ?? process.env["PROTOCOL_API_KEY"] ?? "",
    persist = true,
    suggestedId,
    numExamples = 3,
  } = opts;

  const systemPrompt = await buildGenerationSystemPrompt(numExamples);
  const userPrompt = buildGenerationUserPrompt(task, suggestedId);

  const callOpts: ChatCallOptions = {
    apiKey,
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: userPrompt },
    ],
    temperature: 0.3, // low temperature for deterministic JSON
    max_completion_tokens: 1500,
  };

  let rawResponse = "";
  try {
    const { provider } = resolveProvider(callOpts);
    const result = await provider.chat(callOpts);
    rawResponse = result.content ?? "";
  } catch (err) {
    throw new Error(
      `generateAgentDefinition: LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Parse and validate
  const toolNames = await getAvailableToolNames();
  const raw = extractJson(rawResponse);
  const definition = validateAndNormalize(raw, task, toolNames);

  // Derive final ID
  const id = sanitizeId(raw.id ?? suggestedId ?? definition.name ?? task);

  // Set source
  definition.source = persist ? "db" : undefined;

  // Persist
  let persisted = false;
  if (persist) {
    try {
      await upsertAgent(id, definition);
      persisted = true;
    } catch {
      // Non-fatal — return the definition even if we can't persist
    }
  }

  return { id, definition, persisted, rawResponse };
}

// ── Prompt builders ───────────────────────────────────────────────────────────

async function buildGenerationSystemPrompt(numExamples: number): Promise<string> {
  const toolNames = await getAvailableToolNames();
  const exampleSeeds = pickExamples(numExamples);
  const examplesJson = exampleSeeds
    .map(([id, defn]) =>
      `### Example: "${id}"\n${JSON.stringify(
        {
          id,
          name: defn.name,
          description: defn.description,
          prompt: defn.prompt,
          tools: defn.tools ?? null,
          model: defn.model ?? null,
          effort: defn.effort ?? "medium",
          tags: defn.tags ?? [],
          memoryWrite: defn.memoryWrite ?? false,
          skills: defn.skills ?? true,
          readProjectInstructions: defn.readProjectInstructions ?? false,
        },
        null,
        2,
      )}`
    )
    .join("\n\n");

  return `You are an agent architect for orager, an AI agent orchestration framework.

Your task: design a specialized sub-agent definition for a described task type.

## Output format
Return a single JSON object with these fields (no markdown, no code fences):
{
  "id": "lowercase-with-hyphens registry key",
  "name": "Human-Readable Display Name",
  "description": "When to use this agent. Start with 'Use for' or 'Use when'. 1-2 sentences.",
  "prompt": "System prompt: concise role definition, behavior constraints, and expected output format.",
  "tools": ["ToolName", ...] or null (null = inherit all parent tools),
  "disallowedTools": ["ToolName", ...] or null (explicit denylist),
  "model": "provider/model-id" or null (null = inherit parent model),
  "effort": "low" | "medium" | "high",
  "maxTurns": number or null,
  "tags": ["tag1", "tag2"],
  "memoryWrite": false,
  "skills": true,
  "readProjectInstructions": false
}

## Available tools
${toolNames.join(", ")}

## Design guidelines
- Minimal tool set: only tools the agent actually needs (principle of least privilege)
- Read-only tools (Read, Grep, Glob, ListDir) for any task that doesn't write
- Add Bash only for tasks that need to execute commands
- Add WebSearch/WebFetch only for tasks that need external information
- effort:"low" + model:"openai/gpt-4o-mini" for simple search/read/format tasks
- effort:"high" for complex reasoning, planning, or multi-step analysis
- memoryWrite:false for almost all agents (only true when persistence is the core purpose)
- skills:false for utility agents where skill injection overhead isn't worth it
- readProjectInstructions:true when the agent needs to follow project conventions

## Example definitions (use as quality and style reference)

${examplesJson}`;
}

function buildGenerationUserPrompt(task: string, suggestedId?: string): string {
  let prompt = `Design an agent for this task type:\n\n"${task}"`;
  if (suggestedId) {
    prompt += `\n\nSuggested registry key: "${sanitizeId(suggestedId)}"`;
  }
  prompt += "\n\nReturn ONLY the JSON object. No explanation, no markdown.";
  return prompt;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Pick a representative sample of seed agents for few-shot examples.
 * Always includes explorer (read-only), coder (full tools), and planner
 * (high effort) to cover the spectrum of tool complexity and effort levels.
 */
function pickExamples(n: number): [string, AgentDefinition][] {
  const priority = ["explorer", "planner", "coder", "researcher", "reviewer", "tester"];
  return priority
    .slice(0, n)
    .map((id) => [id, SEED_AGENTS[id]!] as [string, AgentDefinition])
    .filter(([, defn]) => defn !== undefined);
}

/**
 * Extract JSON from the LLM response.
 * Handles: raw JSON, JSON wrapped in ```json...```, leading/trailing whitespace.
 */
function extractJson(raw: string): RawGenerated {
  let text = raw.trim();

  // Strip markdown code fences
  text = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();

  // Find the outermost JSON object
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error(`generateAgentDefinition: no JSON object found in response`);
  }

  const jsonStr = text.slice(start, end + 1);

  try {
    return JSON.parse(jsonStr) as RawGenerated;
  } catch (err) {
    throw new Error(
      `generateAgentDefinition: failed to parse JSON: ${err instanceof Error ? err.message : String(err)}\nRaw: ${jsonStr.slice(0, 200)}`,
    );
  }
}

/**
 * Validate and normalize the raw LLM output into a clean AgentDefinition.
 * Fills in sensible defaults and strips invalid tool names.
 */
function validateAndNormalize(raw: RawGenerated, originalTask: string, toolNames: string[]): AgentDefinition {
  if (!raw.description || typeof raw.description !== "string") {
    // Fall back to a generic description derived from the task
    raw.description = `Use for: ${originalTask.slice(0, 120)}`;
  }
  if (!raw.prompt || typeof raw.prompt !== "string") {
    throw new Error("generateAgentDefinition: generated definition missing required 'prompt' field");
  }

  // Validate and filter tool names against known tools
  const knownToolSet = new Set(toolNames.map((t) => t.toLowerCase()));
  const filterToolList = (tools: string[] | null | undefined): string[] | undefined => {
    if (!tools || !Array.isArray(tools)) return undefined;
    const valid = tools.filter((t) => typeof t === "string" && knownToolSet.has(t.toLowerCase()));
    return valid.length > 0 ? valid : undefined;
  };

  // Normalize effort
  const effort = ["low", "medium", "high"].includes(raw.effort ?? "")
    ? (raw.effort as "low" | "medium" | "high")
    : "medium";

  const definition: AgentDefinition = {
    description: raw.description.trim(),
    prompt: raw.prompt.trim(),
    name: typeof raw.name === "string" ? raw.name.trim() : undefined,
    tools: filterToolList(raw.tools),
    disallowedTools: filterToolList(raw.disallowedTools),
    model: typeof raw.model === "string" && raw.model ? raw.model : undefined,
    effort,
    maxTurns: typeof raw.maxTurns === "number" && raw.maxTurns > 0 ? Math.floor(raw.maxTurns) : undefined,
    maxCostUsd: typeof raw.maxCostUsd === "number" && raw.maxCostUsd > 0 ? raw.maxCostUsd : undefined,
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === "string") : undefined,
    memoryWrite: raw.memoryWrite === true,
    skills: raw.skills !== false,
    readProjectInstructions: raw.readProjectInstructions === true,
  };

  return definition;
}

/**
 * Sanitize a string into a valid registry key: lowercase, hyphens, no spaces.
 * "SQL Query Optimizer" → "sql-query-optimizer"
 */
export function sanitizeId(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64); // max 64 chars
}

// ── generate_agent tool factory ────────────────────────────────────────────────

import type { ToolExecutor, AgentLoopOptions } from "../types.js";

/**
 * Build the generate_agent ToolExecutor.
 *
 * When the parent LLM calls this tool, it synthesizes a new AgentDefinition,
 * adds it to the live agents map (so the Agent tool can spawn it immediately),
 * and optionally persists it to the registry.
 *
 * This is the proactive path — the LLM explicitly requests synthesis before
 * delegating. The Agent tool's fallback handles the reactive path (unknown type).
 *
 * @param agents  Mutable agents map shared with makeAgentTool — mutations here
 *                are immediately visible to Agent tool's runtime lookup.
 * @param parentOpts  Parent loop options for model/apiKey resolution.
 */
export function makeGenerateAgentTool(
  agents: Record<string, AgentDefinition>,
  parentOpts: AgentLoopOptions,
): ToolExecutor {
  return {
    definition: {
      type: "function",
      function: {
        name: "generate_agent",
        description:
          "Synthesize and register a new specialized sub-agent for a task type. " +
          "Use this when you need to repeatedly delegate the same type of task and want " +
          "an optimized, persistent agent — not just a one-off spawn. " +
          "After calling this, use the Agent tool with the returned agent_id to delegate tasks. " +
          "Generated agents are saved to the catalog and reused in future sessions.",
        parameters: {
          type: "object",
          properties: {
            task_description: {
              type: "string",
              description:
                "What kind of tasks this agent will handle. Be specific: " +
                "'Analyze Rust compiler errors and suggest fixes' is better than 'debug code'.",
            },
            agent_id: {
              type: "string",
              description:
                "Registry key for the new agent (lowercase-with-hyphens). " +
                "Auto-derived from name if omitted. Example: 'rust-error-analyzer'.",
            },
            persist: {
              type: "boolean",
              description:
                "Save to catalog for future sessions (default: true). " +
                "Set false for a one-time ephemeral agent.",
            },
          },
          required: ["task_description"],
        },
      },
    },

    async execute(
      input: Record<string, unknown>,
    ): Promise<{ toolCallId: string; content: string; isError: boolean }> {
      const taskDescription = input["task_description"] as string;
      const suggestedId = input["agent_id"] as string | undefined;
      const persist = input["persist"] !== false; // default true

      if (!taskDescription || typeof taskDescription !== "string") {
        return { toolCallId: "", content: "task_description must be a non-empty string", isError: true };
      }

      let result: GenerateAgentResult;
      try {
        result = await generateAgentDefinition({
          task: taskDescription,
          model: parentOpts.model,
          apiKey: parentOpts.apiKey,
          persist,
          suggestedId,
        });
      } catch (err) {
        return {
          toolCallId: "",
          content: `Failed to generate agent: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }

      // Add to the live agents map so Agent tool can use it immediately
      agents[result.id] = result.definition;

      const persistedStr = result.persisted
        ? "Saved to catalog."
        : "Ephemeral (not saved to catalog).";

      const toolsStr = result.definition.tools
        ? `Tools: ${result.definition.tools.join(", ")}`
        : "Tools: inherits all";

      return {
        toolCallId: "",
        content: [
          `Generated agent "${result.id}" (${result.definition.name ?? result.id}).`,
          `Description: ${result.definition.description}`,
          toolsStr,
          `Effort: ${result.definition.effort ?? "medium"}`,
          persistedStr,
          ``,
          `Use Agent tool with subagent_type: "${result.id}" to delegate tasks.`,
        ].join("\n"),
        isError: false,
      };
    },
  };
}
