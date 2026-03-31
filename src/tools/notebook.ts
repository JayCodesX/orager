/**
 * Notebook tools — read and edit Jupyter .ipynb files.
 * NotebookRead: renders all cells as readable text.
 * NotebookEdit: applies cell-level patches (insert, delete, replace).
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { ToolExecutor, ToolExecuteOptions, ToolResult } from "../types.js";
import { assertPathAllowed } from "../sandbox.js";

const MAX_OUTPUT_CHARS_PER_CELL = 2000;
const MAX_TOTAL_CHARS = 20_000;

interface NotebookCell {
  cell_type: "code" | "markdown" | "raw";
  source: string | string[];
  outputs?: Array<{
    output_type: string;
    text?: string | string[];
    data?: Record<string, string | string[]>;
  }>;
  execution_count?: number | null;
}

interface Notebook {
  nbformat: number;
  cells: NotebookCell[];
}

function joinSource(source: string | string[]): string {
  return Array.isArray(source) ? source.join("") : source;
}

function renderCell(cell: NotebookCell, index: number): string {
  const source = joinSource(cell.source);
  const lines: string[] = [];

  if (cell.cell_type === "markdown") {
    lines.push(`[Cell ${index} — markdown]`);
    lines.push(source);
  } else if (cell.cell_type === "code") {
    const execNum = cell.execution_count != null ? ` In[${cell.execution_count}]` : "";
    lines.push(`[Cell ${index} — code${execNum}]`);
    lines.push(source);
    if (cell.outputs && cell.outputs.length > 0) {
      let outputText = "";
      for (const out of cell.outputs) {
        if (out.text) {
          outputText += Array.isArray(out.text) ? out.text.join("") : out.text;
        } else if (out.data?.["text/plain"]) {
          const d = out.data["text/plain"];
          outputText += Array.isArray(d) ? d.join("") : d;
        }
      }
      if (outputText) {
        if (outputText.length > MAX_OUTPUT_CHARS_PER_CELL) {
          outputText = outputText.slice(0, MAX_OUTPUT_CHARS_PER_CELL) + `\n…(truncated)`;
        }
        lines.push(`[Output]\n${outputText}`);
      }
    }
  } else {
    lines.push(`[Cell ${index} — raw]`);
    lines.push(source);
  }

  return lines.join("\n");
}

export const notebookReadTool: ToolExecutor = {
  definition: {
    type: "function",
    readonly: true,
    function: {
      name: "notebook_read",
      description: "Read a Jupyter notebook (.ipynb) and return its cells as formatted text.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the .ipynb file" },
        },
        required: ["path"],
      },
    },
  },
  async execute(input: Record<string, unknown>, cwd: string, opts?: ToolExecuteOptions): Promise<ToolResult> {
    const filePath = input["path"] as string;
    if (typeof filePath !== "string") {
      return { toolCallId: "", content: "path must be a string", isError: true };
    }
    const abs = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
    if (opts?.sandboxRoot) {
      try { assertPathAllowed(abs, opts.sandboxRoot); } catch (e) {
        return { toolCallId: "", content: String(e), isError: true };
      }
    }
    let nb: Notebook;
    try {
      const raw = await fs.readFile(abs, "utf8");
      nb = JSON.parse(raw) as Notebook;
    } catch (e) {
      return { toolCallId: "", content: `Cannot read notebook: ${e instanceof Error ? e.message : String(e)}`, isError: true };
    }
    if (!Array.isArray(nb.cells)) {
      return { toolCallId: "", content: "Invalid notebook: missing cells array", isError: true };
    }
    const parts = nb.cells.map((cell, i) => renderCell(cell, i));
    let result = parts.join("\n\n");
    if (result.length > MAX_TOTAL_CHARS) {
      result = result.slice(0, MAX_TOTAL_CHARS) + "\n…(truncated)";
    }
    return { toolCallId: "", content: result || "(empty notebook)", isError: false };
  },
};

export interface NotebookEditOperation {
  /** Index of the cell to operate on (for replace/delete). */
  cell_index?: number;
  /** For insert: index to insert before (0 = beginning, omit or use cells.length = append). */
  insert_before?: number;
  type: "replace" | "delete" | "insert";
  /** New source for replace/insert operations. */
  source?: string;
  /** Cell type for insert operations. Default: "code". */
  cell_type?: "code" | "markdown" | "raw";
}

export const notebookEditTool: ToolExecutor = {
  definition: {
    type: "function",
    function: {
      name: "notebook_edit",
      description:
        "Edit a Jupyter notebook (.ipynb) by replacing, deleting, or inserting cells. " +
        "Returns the updated cell list summary.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the .ipynb file" },
          operations: {
            type: "array",
            description: "List of edit operations to apply in order",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["replace", "delete", "insert"], description: "Operation type" },
                cell_index: { type: "number", description: "Cell index for replace/delete" },
                insert_before: { type: "number", description: "Insert before this index (insert op)" },
                source: { type: "string", description: "New cell source for replace/insert" },
                cell_type: { type: "string", enum: ["code", "markdown", "raw"], description: "Cell type for insert (default: code)" },
              },
              required: ["type"],
            },
          },
        },
        required: ["path", "operations"],
      },
    },
  },
  async execute(input: Record<string, unknown>, cwd: string, opts?: ToolExecuteOptions): Promise<ToolResult> {
    const filePath = input["path"] as string;
    const operations = input["operations"] as NotebookEditOperation[];
    if (typeof filePath !== "string") return { toolCallId: "", content: "path must be a string", isError: true };
    if (!Array.isArray(operations)) return { toolCallId: "", content: "operations must be an array", isError: true };

    const abs = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
    if (opts?.sandboxRoot) {
      try { assertPathAllowed(abs, opts.sandboxRoot); } catch (e) {
        return { toolCallId: "", content: String(e), isError: true };
      }
    }

    let nb: Notebook;
    try {
      const raw = await fs.readFile(abs, "utf8");
      nb = JSON.parse(raw) as Notebook;
    } catch (e) {
      return { toolCallId: "", content: `Cannot read notebook: ${e instanceof Error ? e.message : String(e)}`, isError: true };
    }

    // N-07: Apply operations in two passes to avoid index drift.
    // First pass: replaces and inserts use original indices (non-destructive).
    // Second pass: deletes are sorted in descending index order so each splice
    // only affects cells at higher indices (which are already processed).
    const replaceOps = operations.filter((op) => op.type === "replace");
    const insertOps = operations.filter((op) => op.type === "insert");
    const deleteOps = operations.filter((op) => op.type === "delete");

    // Pass 1: Apply replaces (in-place, no index shift)
    for (const op of replaceOps) {
      const idx = op.cell_index ?? -1;
      if (idx < 0 || idx >= nb.cells.length) return { toolCallId: "", content: `cell_index ${idx} out of range`, isError: true };
      nb.cells[idx] = { ...nb.cells[idx], source: op.source ?? "" };
    }

    // Pass 2: Apply deletes in descending index order to avoid index drift
    const sortedDeletes = [...deleteOps].sort(
      (a, b) => (b.cell_index ?? -1) - (a.cell_index ?? -1),
    );
    for (const op of sortedDeletes) {
      const idx = op.cell_index ?? -1;
      if (idx < 0 || idx >= nb.cells.length) return { toolCallId: "", content: `cell_index ${idx} out of range`, isError: true };
      nb.cells.splice(idx, 1);
    }

    // Pass 3: Apply inserts in ascending index order (they reference post-delete positions)
    const sortedInserts = [...insertOps].sort(
      (a, b) => (a.insert_before ?? nb.cells.length) - (b.insert_before ?? nb.cells.length),
    );
    for (let i = 0; i < sortedInserts.length; i++) {
      const op = sortedInserts[i];
      const insertAt = (op.insert_before ?? nb.cells.length) + i; // offset by prior inserts
      const newCell: NotebookCell = {
        cell_type: op.cell_type ?? "code",
        source: op.source ?? "",
        outputs: op.cell_type !== "code" ? undefined : [],
        execution_count: null,
      };
      nb.cells.splice(insertAt, 0, newCell);
    }

    try {
      await fs.writeFile(abs, JSON.stringify(nb, null, 1), "utf8");
    } catch (e) {
      return { toolCallId: "", content: `Cannot write notebook: ${e instanceof Error ? e.message : String(e)}`, isError: true };
    }

    return {
      toolCallId: "",
      content: `Notebook updated: ${nb.cells.length} cells (${operations.length} operation(s) applied)`,
      isError: false,
    };
  },
};
