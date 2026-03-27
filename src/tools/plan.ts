/**
 * exit_plan_mode tool — signals the loop to exit plan mode and
 * enable full tool execution.
 *
 * When planMode is active, only readonly tools are available.
 * Calling exit_plan_mode switches the loop to full execution mode.
 */
import type { ToolExecutor, ToolResult } from "../types.js";

export const PLAN_MODE_TOOL_NAME = "exit_plan_mode";

export const exitPlanModeTool: ToolExecutor = {
  definition: {
    type: "function",
    function: {
      name: PLAN_MODE_TOOL_NAME,
      description:
        "Exit plan mode and switch to full execution mode. " +
        "Call this when you have finished planning and are ready to execute.",
      parameters: {
        type: "object",
        properties: {
          plan_summary: {
            type: "string",
            description: "Brief summary of the plan before executing",
          },
        },
        required: [],
      },
    },
  },
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const summary = typeof input["plan_summary"] === "string" ? input["plan_summary"] : "";
    return {
      toolCallId: "",
      content: summary
        ? `Plan mode exited. Plan summary: ${summary}\nFull tool execution is now enabled.`
        : "Plan mode exited. Full tool execution is now enabled.",
      isError: false,
    };
  },
};
