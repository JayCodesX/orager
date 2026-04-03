import { bashTool } from "./bash.js";
import { readFileTool } from "./read-file.js";
import { writeFileTool, strReplaceTool } from "./write-file.js";
import { editFileTool } from "./edit.js";
import { editFilesTool } from "./edit-files.js";
import { listDirTool } from "./list-dir.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { webFetchTool } from "./web-fetch.js";
import { webSearchTool } from "./web-search.js";
import { deleteFileTool, moveFileTool, createDirTool } from "./file-ops.js";
import { finishTool } from "./finish.js";
import { notebookReadTool, notebookEditTool } from "./notebook.js";
import { toolAliases } from "./aliases.js";
import { BROWSER_TOOLS } from "./browser.js";
import type { ToolExecutor } from "../types.js";

export const ALL_TOOLS: ToolExecutor[] = [
  bashTool,
  readFileTool,
  writeFileTool,
  strReplaceTool,
  editFileTool,
  editFilesTool,
  listDirTool,
  globTool,
  grepTool,
  webFetchTool,
  webSearchTool,
  deleteFileTool,
  moveFileTool,
  createDirTool,
  notebookReadTool,
  notebookEditTool,
  ...toolAliases,
];

export function getToolByName(name: string): ToolExecutor | undefined {
  return ALL_TOOLS.find((t) => t.definition.function.name === name);
}

export { makeAgentTool, buildAgentsSystemPrompt } from "./agent.js";
export { bashTool, readFileTool, writeFileTool, strReplaceTool, editFileTool, editFilesTool, listDirTool, globTool, grepTool, webFetchTool, webSearchTool, deleteFileTool, moveFileTool, createDirTool, finishTool, notebookReadTool, notebookEditTool, toolAliases, BROWSER_TOOLS };
