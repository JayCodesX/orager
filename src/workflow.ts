/**
 * runAgentWorkflow — sequential multi-agent orchestration.
 *
 * Executes an AgentWorkflow step by step, passing each step's output as the
 * next step's prompt via the optional handoff function (default: pass-through).
 *
 * Each step merges AgentWorkflow.base with the step's AgentConfig overrides
 * into a full AgentLoopOptions and calls runAgentLoop. The step's text output
 * is captured via onEmit and forwarded to the caller's onEmit as well.
 */

import { runAgentLoop } from "./loop.js";
import type { AgentLoopOptions, AgentWorkflow, EmitEvent } from "./types.js";

/**
 * Run a sequential multi-agent workflow.
 *
 * @param workflow - The workflow definition (base config + ordered steps).
 * @param initialPrompt - The prompt for the first step.
 */
export async function runAgentWorkflow(
  workflow: AgentWorkflow,
  initialPrompt: string,
): Promise<void> {
  const { base, steps, handoff } = workflow;

  if (steps.length === 0) return;

  let currentPrompt = initialPrompt;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    let stepOutput = "";

    // Collect text output from this step so it can be handed off to the next.
    const collectingOnEmit = (event: EmitEvent) => {
      if (event.type === "assistant") {
        for (const block of event.message.content) {
          if (block.type === "text") stepOutput += block.text;
        }
      }
      // Forward every event to the caller's handler.
      base.onEmit(event);
    };

    // Merge base + step overrides into a full AgentLoopOptions.
    const opts: AgentLoopOptions = {
      ...base,
      model: step.model,
      prompt: currentPrompt,
      onEmit: collectingOnEmit,
      // Per-step overrides — only applied when the step specifies them.
      ...(step.appendSystemPrompt !== undefined && { appendSystemPrompt: step.appendSystemPrompt }),
      ...(step.temperature !== undefined && { temperature: step.temperature }),
      ...(step.memoryKey !== undefined && { memoryKey: step.memoryKey }),
      ...(step.maxTurns !== undefined && { maxTurns: step.maxTurns }),
      ...(step.maxCostUsd !== undefined && { maxCostUsd: step.maxCostUsd }),
      // Tag each step's log events with the role name via siteName.
      siteName: step.role,
    };

    try {
      await runAgentLoop(opts);
    } catch (err) {
      throw new Error(
        `Workflow step ${i} ("${step.role}") failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Prepare the prompt for the next step unless this was the last one.
    if (i < steps.length - 1) {
      currentPrompt = handoff
        ? handoff(i, stepOutput)
        : stepOutput;
    }
  }
}
