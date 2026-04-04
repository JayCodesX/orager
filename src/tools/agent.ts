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
import { getAgentsDb } from "../agents/registry.js";
import { recordAgentScore } from "../agents/score.js";
import { generateAgentDefinition, sanitizeId } from "../agents/generate.js";

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
  // NOTE: agents is a mutable reference — generate_agent tool adds to this map
  // at runtime, and the execute() closure reads agents[subagentType] fresh on
  // each call. No enum is used so dynamically added agents are immediately valid.

  // Build a snapshot of names for the description (refreshed on each schema read
  // via a getter so new agents appear in future tool_choice descriptions).
  const buildDescription = () => {
    const names = Object.keys(agents);
    const list = names.map((n) => `  • ${n}: ${agents[n]!.description}`).join("\n");
    return (
      "Spawn a named sub-agent to handle a specialised task. " +
      "The sub-agent runs to completion and returns its final output. " +
      "You can call Agent multiple times in one turn — they run concurrently. " +
      "If none of the named agents fit, use generate_agent first to synthesize one.\n" +
      "Available agents:\n" + list
    );
  };

  return {
    definition: {
      type: "function",
      function: {
        name: "Agent",
        get description() { return buildDescription(); },
        parameters: {
          type: "object",
          properties: {
            subagent_type: {
              type: "string",
              // No enum — agents can be added dynamically by generate_agent.
              // The description lists all available agents. Unknown types trigger
              // dynamic generation as a fallback.
              description:
                "The agent to spawn. Must match a name from the list above, " +
                "or a name you just registered with generate_agent.",
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

      let defn = agents[subagentType];

      // ── Dynamic generation fallback ───────────────────────────────────────
      // Unknown subagent_type: synthesize a definition on the fly using the
      // task description as the generation prompt. The generated definition is
      // added to the mutable agents map and optionally persisted to the registry.
      if (!defn) {
        try {
          process.stderr.write(
            `[orager/agent] "${subagentType}" not in catalog — generating definition...\n`,
          );
          const generated = await generateAgentDefinition({
            task: prompt,
            suggestedId: sanitizeId(subagentType),
            model: parentOpts.model,
            apiKey: parentOpts.apiKey,
            persist: true,
          });
          // Add to live map (visible to future Agent tool calls this session)
          agents[generated.id] = generated.definition;
          // Resolve: if our sanitized ID differs from the original call, use it
          defn = generated.definition;
          process.stderr.write(
            `[orager/agent] generated "${generated.id}" (${generated.persisted ? "persisted" : "ephemeral"})\n`,
          );
        } catch (genErr) {
          const knownNames = Object.keys(agents).join(", ") || "(none)";
          return {
            toolCallId,
            content:
              `[Agent] Unknown sub-agent type: "${subagentType}". ` +
              `Auto-generation failed: ${genErr instanceof Error ? genErr.message : String(genErr)}. ` +
              `Known types: ${knownNames}`,
            isError: true,
          };
        }
      }

      // ── Depth guard ──────────────────────────────────────────────────────
      const currentDepth = parentOpts._spawnDepth ?? 0;
      const maxDepth = parentOpts.maxSpawnDepth ?? 2;
      if (currentDepth >= maxDepth) {
        return {
          toolCallId,
          content: `[Agent] Spawn depth limit (${maxDepth}) reached. Cannot spawn "${subagentType}".`,
          isError: true,
        };
      }

      // ── Session spawn count guard ─────────────────────────────────────────
      const spawnCounter = parentOpts._sessionSpawnCount ?? { value: 0 };
      const maxSpawns = parentOpts.maxSpawnsPerSession ?? 50;
      if (maxSpawns > 0 && spawnCounter.value >= maxSpawns) {
        return {
          toolCallId,
          content: `[Agent] Session spawn limit (${maxSpawns}) reached. Cannot spawn "${subagentType}".`,
          isError: true,
        };
      }
      spawnCounter.value += 1;

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
          // If defn.tools is set, use as allowlist; otherwise inherit all tools
          // from the parent (minus the Agent tool — sub-agents don't recurse).
          const allowedTools: string[] | undefined = defn.tools;

          // Apply the denylist on top of the allowlist.
          // We pass allowed tools resolved minus denied ones when both are set.
          const effectiveAllowedTools: string[] | undefined =
            allowedTools && defn.disallowedTools
              ? allowedTools.filter(
                  (t) =>
                    !defn.disallowedTools!.map((d) => d.toLowerCase()).includes(
                      t.toLowerCase(),
                    ),
                )
              : allowedTools;

          // Resolve model based on effort when defn.model is not set.
          // "high" effort agents get a reasoning-capable model hint via the model
          // selection (the loop itself handles model capability routing).
          const subModel = defn.model ?? parentOpts.model;

          const startMs = Date.now();
          let subTurns = 0;
          let subCostUsd = 0;

          const subOpts: AgentLoopOptions = {
            // Core
            prompt: defn.prompt ? `${defn.prompt}\n\n${prompt}` : prompt,
            model: subModel,
            apiKey: parentOpts.apiKey,
            cwd: parentOpts.cwd,

            // Depth tracking
            _spawnDepth: currentDepth + 1,
            maxSpawnDepth: maxDepth,
            _sessionSpawnCount: spawnCounter,
            maxSpawnsPerSession: parentOpts.maxSpawnsPerSession,

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

            // Tool filtering: pass the effective allow-list so loop can filter
            ...(effectiveAllowedTools ? { _allowedTools: effectiveAllowedTools } : {}),
            // Pass denylist separately so loop can apply it even without an allowlist
            ...(defn.disallowedTools && !allowedTools
              ? { _disallowedTools: defn.disallowedTools }
              : {}),

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
              const tagged = event as unknown as Record<string, unknown>;
              tagged["_subagentType"] = subagentType;
              parentOpts.onEmit(event);
            },

            // Project instructions: opt-in per definition (default false for sub-agents)
            readProjectInstructions: defn.readProjectInstructions ?? false,

            // No recursive agent spawning — sub-agents don't get the agents map
            agents: undefined,
          };

          // ── Run ──────────────────────────────────────────────────────────
          let finalText = "";
          let runSuccess = true;
          const collectingEmit = subOpts.onEmit;
          subOpts.onEmit = (event) => {
            if (event.type === "assistant") {
              for (const block of event.message.content) {
                if (block.type === "text") finalText += block.text;
              }
            }
            if (event.type === "result") {
              subTurns = event.turnCount ?? 0;
              subCostUsd = event.total_cost_usd ?? 0;
              if (event.subtype !== "success") runSuccess = false;
            }
            collectingEmit(event);
          };

          try {
            await runAgentLoop(subOpts);
          } finally {
            // Record score regardless of success/failure
            const durationMs = Date.now() - startMs;
            getAgentsDb().then((db) => {
              recordAgentScore(db, {
                agentId: subagentType,
                sessionId: null,
                success: runSuccess,
                turns: subTurns,
                costUsd: subCostUsd,
                durationMs,
              });
            }).catch(() => { /* non-fatal */ });
          }

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
    "- If no existing agent fits, call generate_agent to synthesize one, then use Agent.",
    "  The generated agent is saved to the catalog and available in future sessions.",
  ];

  return lines.join("\n");
}
