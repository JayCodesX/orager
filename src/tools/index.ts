import { bashTool } from "./bash.js";
import { readFileTool } from "./read-file.js";
import { writeFileTool, strReplaceTool } from "./write-file.js";
import { listDirTool } from "./list-dir.js";
import { webFetchTool } from "./web-fetch.js";
import { finishTool } from "./finish.js";
import type { ToolExecutor } from "../types.js";

export const ALL_TOOLS: ToolExecutor[] = [
  bashTool,
  readFileTool,
  writeFileTool,
  strReplaceTool,
  listDirTool,
  webFetchTool,
];

export function getToolByName(name: string): ToolExecutor | undefined {
  return ALL_TOOLS.find((t) => t.definition.function.name === name);
}

export { bashTool, readFileTool, writeFileTool, strReplaceTool, listDirTool, webFetchTool, finishTool };
