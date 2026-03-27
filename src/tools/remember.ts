/**
 * remember — persistent cross-session memory tool.
 *
 * Uses a factory pattern (like makeTodoTools) so the memoryKey is captured
 * in a closure and available to all three actions without passing it through
 * ToolExecuteOptions.
 *
 * Storage: ~/.orager/memory/<memoryKey>.json (atomic writes, mode 0o600)
 */
import {
  loadMemoryStore,
  saveMemoryStore,
  addMemoryEntry,
  removeMemoryEntry,
  pruneExpired,
  renderMemoryBlock,
} from "../memory.js";
import type { ToolExecutor, ToolResult } from "../types.js";

const MAX_CONTENT_CHARS = 500;
const DEFAULT_MAX_CHARS = 6000;

export function makeRememberTool(memoryKey: string, maxChars = DEFAULT_MAX_CHARS): ToolExecutor {
  return {
    definition: {
      type: "function",
      readonly: false,
      function: {
        name: "remember",
        description:
          "Read and write your persistent memory — facts that survive session resets and " +
          "carry forward into future runs. Use this proactively when you learn something " +
          "worth remembering (user preferences, codebase quirks, recurring bugs, patterns) " +
          "and to recall prior context when starting a new task.\n\n" +
          "Actions:\n" +
          "  add    — store a new memory entry\n" +
          "  remove — delete an entry by its id\n" +
          "  list   — show all current memory entries",
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["add", "remove", "list"],
              description: "add: store a new memory. remove: delete by id. list: show all current memories.",
            },
            content: {
              type: "string",
              description: `Required for action=add. Concise natural language fact (max ${MAX_CONTENT_CHARS} chars).`,
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Optional category tags for action=add (e.g. ['auth', 'user-pref', 'bug']).",
            },
            ttl_days: {
              type: "number",
              description: "Optional TTL in days for action=add. Omit for permanent storage.",
            },
            importance: {
              type: "string",
              enum: ["1", "2", "3"],
              description: "1=low, 2=normal (default), 3=high. Affects display order.",
            },
            id: {
              type: "string",
              description: "Required for action=remove. The memory entry id.",
            },
          },
          required: ["action"],
        },
      },
    },

    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const action = typeof input["action"] === "string" ? input["action"] : null;
      if (!action) {
        return { toolCallId: "", content: "action is required", isError: true };
      }

      // Load + prune on every call so the view is always fresh
      let store = pruneExpired(await loadMemoryStore(memoryKey));

      if (action === "list") {
        const block = renderMemoryBlock(store, maxChars);
        return {
          toolCallId: "",
          content: block || "No memories stored yet.",
          isError: false,
        };
      }

      if (action === "add") {
        const raw = typeof input["content"] === "string" ? input["content"].trim() : "";
        if (!raw) {
          return { toolCallId: "", content: "content is required for action=add", isError: true };
        }
        const content = raw.slice(0, MAX_CONTENT_CHARS);

        const tags = Array.isArray(input["tags"])
          ? (input["tags"] as unknown[]).filter((t): t is string => typeof t === "string")
          : undefined;

        const ttlDays =
          typeof input["ttl_days"] === "number" && Number.isFinite(input["ttl_days"])
            ? (input["ttl_days"] as number)
            : undefined;

        const rawImportance = Number(input["importance"]);
        const importance: 1 | 2 | 3 =
          rawImportance === 1 || rawImportance === 2 || rawImportance === 3 ? rawImportance : 2;

        const expiresAt =
          ttlDays !== undefined
            ? new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString()
            : undefined;

        store = addMemoryEntry(store, {
          content,
          ...(tags && tags.length > 0 ? { tags } : {}),
          ...(expiresAt ? { expiresAt } : {}),
          importance,
        });

        await saveMemoryStore(memoryKey, store);

        const saved = store.entries[store.entries.length - 1];
        return {
          toolCallId: "",
          content: `Memory saved (id: ${saved.id}, importance: ${importance}${tags && tags.length > 0 ? `, tags: ${tags.join(", ")}` : ""}): ${content}`,
          isError: false,
        };
      }

      if (action === "remove") {
        const id = typeof input["id"] === "string" ? input["id"].trim() : "";
        if (!id) {
          return { toolCallId: "", content: "id is required for action=remove", isError: true };
        }
        const before = store.entries.length;
        store = removeMemoryEntry(store, id);
        if (store.entries.length === before) {
          return { toolCallId: "", content: `No memory entry found with id: ${id}`, isError: false };
        }
        await saveMemoryStore(memoryKey, store);
        return { toolCallId: "", content: `Memory removed: ${id}`, isError: false };
      }

      return { toolCallId: "", content: `Unknown action: ${action}`, isError: true };
    },
  };
}
