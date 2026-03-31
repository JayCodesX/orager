/**
 * TodoWrite and TodoRead tools — per-session structured task tracking.
 * Files are stored at ~/.orager/todos/<sessionId>.json
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { ToolExecutor, ToolResult } from "../types.js";

export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: "high" | "medium" | "low";
}

function todoPath(sessionId: string): string {
  // N-05: Sanitize sessionId to prevent path traversal via ../../ sequences.
  // path.basename strips directory components, leaving only the filename part.
  const safe = path.basename(sessionId);
  if (!safe || safe === "." || safe === "..") {
    throw new Error(`Invalid session ID: ${sessionId}`);
  }
  return path.join(os.homedir(), ".orager", "todos", `${safe}.json`);
}

async function readTodos(sessionId: string): Promise<TodoItem[]> {
  try {
    const raw = await fs.readFile(todoPath(sessionId), "utf8");
    return JSON.parse(raw) as TodoItem[];
  } catch {
    return [];
  }
}

async function writeTodos(sessionId: string, todos: TodoItem[]): Promise<void> {
  const p = todoPath(sessionId);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(todos, null, 2), "utf8");
}

// The tools need the sessionId from the loop closure.
// We use a factory function that the loop calls with the sessionId.
export function makeTodoTools(sessionId: string): ToolExecutor[] {
  const todoWriteTool: ToolExecutor = {
    definition: {
      type: "function",
      function: {
        name: "todo_write",
        description:
          "Write the full list of todos for this session. Replaces the entire list. " +
          "Use this to track tasks, mark progress, and stay organized during long runs.",
        parameters: {
          type: "object",
          properties: {
            todos: {
              type: "array",
              description: "The complete list of todos",
              items: {
                type: "object",
                properties: {
                  id: { type: "string", description: "Unique identifier (e.g. '1', '2', 'task-setup')" },
                  content: { type: "string", description: "Description of the task" },
                  status: { type: "string", enum: ["pending", "in_progress", "completed"], description: "Current status" },
                  priority: { type: "string", enum: ["high", "medium", "low"], description: "Task priority" },
                },
                required: ["id", "content", "status", "priority"],
              },
            },
          },
          required: ["todos"],
        },
      },
    },
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const todos = input["todos"] as TodoItem[];
      if (!Array.isArray(todos)) {
        return { toolCallId: "", content: "todos must be an array", isError: true };
      }
      await writeTodos(sessionId, todos);
      const pending = todos.filter((t) => t.status === "pending").length;
      const inProgress = todos.filter((t) => t.status === "in_progress").length;
      const completed = todos.filter((t) => t.status === "completed").length;
      return {
        toolCallId: "",
        content: `Todos updated: ${todos.length} total (${pending} pending, ${inProgress} in progress, ${completed} completed)`,
        isError: false,
      };
    },
  };

  const todoReadTool: ToolExecutor = {
    definition: {
      type: "function",
      readonly: true,
      function: {
        name: "todo_read",
        description: "Read the current todo list for this session.",
        parameters: { type: "object", properties: {} },
      },
    },
    async execute(): Promise<ToolResult> {
      const todos = await readTodos(sessionId);
      if (todos.length === 0) {
        return { toolCallId: "", content: "No todos yet.", isError: false };
      }
      const lines = todos.map(
        (t) => `[${t.status}] (${t.priority}) ${t.id}: ${t.content}`,
      );
      return { toolCallId: "", content: lines.join("\n"), isError: false };
    },
  };

  return [todoWriteTool, todoReadTool];
}
