/**
 * Claude CLI tool name aliases.
 *
 * Exposes orager tools under their Claude CLI-compatible names so that
 * CLAUDE.md files and prompts referencing Claude CLI tools work without
 * modification. Each alias delegates entirely to the corresponding
 * orager tool's execute function — no logic duplication.
 */
import type { ToolExecutor } from "../types.js";
import { readFileTool } from "./read-file.js";
import { writeFileTool } from "./write-file.js";
import { editFileTool } from "./edit.js";
import { bashTool } from "./bash.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { webFetchTool } from "./web-fetch.js";
import { listDirTool } from "./list-dir.js";

function alias(claudeName: string, original: ToolExecutor): ToolExecutor {
  return {
    definition: {
      ...original.definition,
      function: {
        ...original.definition.function,
        name: claudeName,
      },
    },
    execute: original.execute,
  };
}

export const toolAliases: ToolExecutor[] = [
  alias("Read", readFileTool),
  alias("Write", writeFileTool),
  alias("Edit", editFileTool),
  alias("Bash", bashTool),
  alias("Glob", globTool),
  alias("Grep", grepTool),
  alias("WebFetch", webFetchTool),
  alias("LS", listDirTool),
];
