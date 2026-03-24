import type { ToolExecutor, ToolResult } from "../types.js";

export const FINISH_TOOL_NAME = "finish";

/**
 * Built-in finish tool. When the model calls this, the agent loop detects it
 * and uses the `result` argument as the final output, then stops.
 *
 * Only included in the tools list when `AgentLoopOptions.useFinishTool` is true.
 */
export const finishTool: ToolExecutor = {
  definition: {
    type: "function",
    function: {
      name: FINISH_TOOL_NAME,
      description:
        "Signal that you have completed the task. Call this when all work is done. " +
        "The result field will be used as the final output summary.",
      parameters: {
        type: "object",
        properties: {
          result: {
            type: "string",
            description: "A concise summary of what was accomplished.",
          },
        },
        required: ["result"],
      },
    },
  },

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const result = typeof input.result === "string" ? input.result : "(no result provided)";
    return { toolCallId: "", content: result, isError: false };
  },
};
