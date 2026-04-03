/**
 * agent.ts — Dynamic agent spawning tool (ADR-0010)
 *
 * Registers the "Agent" tool when AgentLoopOptions.agents is configured.
 * The parent model reads each agent's `description` field and calls this
 * tool to delegate tasks. Multiple Agent tool calls in a single turn run
 * concurrently via the standard tool executor.
 *
 * Spawn model:
 *   - Sub-agent gets a fresh context (no session history)
 *   - Inherits parent's memoryKey (read-only) unless AgentDefinition overrides it
 *   - <memory_update> writes suppressed by default; opt-in via memoryWrite: true
 *   - Skills injected by default; opt-out via skills: false
 *   - Tool set restricted to AgentDefinition.tools (or all tools minus Agent)
 *   - Depth limited by maxSpawnDepth (default 3)
 *
 * OTEL: Because runAgentLoop uses withSpan("agent_loop", ...) and withSpan calls
 * startActiveSpan (which propagates via AsyncLocalStorage), the sub-agent's
 * agent_loop span is automatically a child of this tool's span. No manual
 * context wiring required.
 */

import type { ToolExecutor, ToolExecuteOptions, AgentDefinition, AgentLoopOptions } from "../types.js";
import { withSpan } from "../telemetry.js";

// ── Tool factory ──────────────────────────────────────────────────────────────

/**
 * Build the Agent ToolExecutor given the parent's agent definitions map and
 * the parent's full AgentLoopOptions (for context inheritance).
 *
 * Called once during loop initialisation when opts.agents is non-empty.
 */
export function makeAgentTool(
  agents: Record<string, AgentDefinition>,
  parentOpts: AgentLoopOptions,
): ToolExecutor {
  // Build the enum of valid agent names for the JSON schema.
  const agentNames = Object.keys(agents);

  return {
    definition: {
      type: "function",
      function: {
        name: "Agent",
        description:
          "Spawn a sub-agent to handle a specialised task. " +
          "The sub-agent runs to completion and returns its final output. " +
          "You can call Agent multiple times in one turn — they run concurrently. " +
          "Available agents:\n" +
          agentNames.map((n) => `  • ${n}: ${agents[n]!.description}`).join("\n"),
        parameters: {
          type: "object",
          properties: {
            subagent_type: {
              type: "string",
              enum: agentNames,
              description: "The agent to spawn.",
            },
            prompt: {
              type: "string",
              description:
                "Full task description for the sub-agent. Include all context it needs — " +
                "the sub-agent has no access to this conversation history.",
            },
          },
          required: ["subagent_type", "prompt"],
        },
      },
    },

    execute: async (input, _cwd, execOpts?: ToolExecuteOptions) => {
      const toolCallId = (execOpts as { toolCallId?: string } | undefined)?.toolCallId ?? "";
      const subagentType = input["subagent_type"] as string;
      const prompt = input["prompt"] as string;

      const defn = agents[subagentType];
      if (!defn) {
        return {
          toolCallId,
          content: `[Agent] Unknown sub-agent type: "${subagentType}". Valid types: ${agentNames.join(", ")}`,
          isError: true,
        };
      }

      // ── Depth guard ──────────────────────────────────────────────────────
      const currentDepth = parentOpts._spawnDepth ?? 0;
      const maxDepth = parentOpts.maxSpawnDepth ?? 3;
      if (currentDepth >= maxDepth) {
        return {
          toolCallId,
          content: `[Agent] Spawn depth limit (${maxDepth}) reached. Cannot spawn "${subagentType}".`,
          isError: true,
        };
      }

      return withSpan(
        "agent.spawn",
        {
          "orager.agent_type": subagentType,
          "orager.spawn_depth": currentDepth + 1,
          "orager.model": defn.model ?? parentOpts.model,
        },
        async () => {
          // Lazy import to avoid circular dependency (loop imports tools; agent
          // tool imports loop). Dynamic import breaks the cycle at runtime.
          const { runAgentLoop } = await import("../loop.js");

          // ── Build sub-agent options ──────────────────────────────────────
          // Start from scratch (no session history). Selectively inherit from
          // parent opts.

          // Resolve the tool allow-list for the sub-agent.
          // If defn.tools is set, filter; otherwise pass undefined (inherit all
          // tools via the parent's extraTools minus the Agent tool itself — the
          // Agent tool is not added to sub-agents to prevent recursive spawning).
          const allowedTools: string[] | undefined = defn.tools;

          const subOpts: AgentLoopOptions = {
            // Core
            prompt: defn.prompt ? `${defn.prompt}\n\n${prompt}` : prompt,
            model: defn.model ?? parentOpts.model,
            apiKey: parentOpts.apiKey,
            cwd: parentOpts.cwd,

            // Depth tracking
            _spawnDepth: currentDepth + 1,
            maxSpawnDepth: maxDepth,

            // Memory: inherit parent's namespace for reads; suppress writes by default
            memoryKey: defn.memoryKey ?? parentOpts.memoryKey,
            _suppressMemoryWrite: !(defn.memoryWrite ?? false),

            // Skills: inherit by default
            skillbank: (defn.skills === false)
              ? { ...parentOpts.skillbank, enabled: false }
              : parentOpts.skillbank,
            memoryEmbeddingModel: parentOpts.memoryEmbeddingModel,

            // Limits
            maxTurns: defn.maxTurns ?? parentOpts.maxTurns,
            maxCostUsd: defn.maxCostUsd ?? undefined,
            maxRetries: parentOpts.maxRetries,

            // Tool filtering: pass the allowed list so loop can filter extraTools
            ...(allowedTools ? { _allowedTools: allowedTools } : {}),

            // Filesystem
            addDirs: parentOpts.addDirs ?? [],

            // No session persistence for sub-agents
            sessionId: null,
            forceResume: false,

            // Propagate safety/config
            dangerouslySkipPermissions: parentOpts.dangerouslySkipPermissions,
            sandboxRoot: parentOpts.sandboxRoot,
            bashPolicy: parentOpts.bashPolicy,
            verbose: parentOpts.verbose,
            tagToolOutputs: parentOpts.tagToolOutputs,

            // Tag events with the sub-agent role
            siteName: subagentType,

            // Collect output silently — forward to parent's onEmit tagged with role
            onEmit: (event) => {
              // Tag with subagent identity so consumers can filter/display.
              // Cast through unknown because _subagentType is not part of the
              // EmitEvent discriminated union — it's an out-of-band annotation.
              const tagged = event as unknown as Record<string, unknown>;
              tagged["_subagentType"] = subagentType;
              parentOpts.onEmit(event);
            },

            // Sub-agents don't read project instructions (already in parent context)
            readProjectInstructions: false,

            // No recursive agent spawning — sub-agents don't get the agents map
            agents: undefined,
          };

          // ── Run ──────────────────────────────────────────────────────────
          let finalText = "";
          const collectingEmit = subOpts.onEmit;
          subOpts.onEmit = (event) => {
            if (event.type === "assistant") {
              for (const block of event.message.content) {
                if (block.type === "text") finalText += block.text;
              }
            }
            collectingEmit(event);
          };

          await runAgentLoop(subOpts);

          return {
            toolCallId,
            content: finalText.trim() || `[Agent: ${subagentType}] completed with no text output.`,
            isError: false,
          };
        },
      );
    },
  };
}

// ── System prompt section builder ─────────────────────────────────────────────

/**
 * Build the frozen system prompt section that describes available sub-agents.
 * Injected before the cache boundary so it's stable and cacheable.
 */
export function buildAgentsSystemPrompt(agents: Record<string, AgentDefinition>): string {
  const entries = Object.entries(agents);
  if (entries.length === 0) return "";

  const lines = [
    "## Available Sub-Agents",
    "",
    "You can delegate tasks to specialised sub-agents using the Agent tool.",
    "Sub-agents run to completion and return their output. Multiple Agent calls",
    "in the same turn execute concurrently.",
    "",
    ...entries.map(([name, defn]) =>
      `**${name}**: ${defn.description}` +
      (defn.model ? ` *(model: ${defn.model})*` : "")
    ),
    "",
    "Delegation guidelines:",
    "- Delegate when a sub-agent's specialisation clearly matches the task.",
    "- Pass all necessary context in the prompt — sub-agents have no conversation history.",
    "- For independent parallel tasks, call Agent multiple times in one response.",
    "- Do the work yourself when a task is straightforward or needs your full context.",
  ];

  return lines.join("\n");
}
