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
  loadMemoryStoreAny,
  saveMemoryStoreAny,
  addMemoryEntry,
  removeMemoryEntry,
  pruneExpired,
  renderMemoryBlock,
  embedEntryIfNeeded,
  withMemoryLock,
} from "../memory.js";
import {
  isSqliteMemoryEnabled,
  addMemoryEntrySqlite,
  removeMemoryEntrySqlite,
  loadMasterContext,
  upsertMasterContext,
  MASTER_CONTEXT_MAX_CHARS,
} from "../memory-sqlite.js";
import { callEmbeddings } from "../openrouter.js";
import { withSpan } from "../telemetry.js";
import type { MemoryStore } from "../memory.js";
import type { ToolExecutor, ToolResult } from "../types.js";

const MAX_CONTENT_CHARS = 500;
const DEFAULT_MAX_CHARS = 6000;

export function makeRememberTool(
  memoryKey: string,
  maxChars = DEFAULT_MAX_CHARS,
  embeddingOpts?: { apiKey: string; model: string } | null,
  contextId?: string,
  /** All namespaces the agent may read from or write to. Defaults to [memoryKey]. */
  allowedNamespaces?: string[],
): ToolExecutor {
  // contextId defaults to memoryKey — they share the same namespace.
  const effectiveContextId = contextId ?? memoryKey;
  // Namespaces the agent is permitted to read or write.
  const readNamespaces: string[] =
    allowedNamespaces && allowedNamespaces.length > 0 ? allowedNamespaces : [memoryKey];

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
          "  add          — store a new memory entry\n" +
          "  remove       — delete an entry by its id\n" +
          "  list         — show all current memory entries (across all namespaces)\n" +
          "  view_master  — show the persistent product/project context (Layer 1)\n" +
          "  set_master   — update the persistent product/project context (max ~2k tokens)" +
          (readNamespaces.length > 1
            ? `\n\nAvailable namespaces: ${readNamespaces.join(", ")}. ` +
              `Default write target: ${memoryKey}. ` +
              `Use target_namespace to write to a specific shared namespace.`
            : ""),
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["add", "remove", "list", "view_master", "set_master"],
              description:
                "add: store a new memory. remove: delete by id. list: show all memories. " +
                "view_master: show master context. set_master: update master context.",
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
            target_namespace: {
              type: "string",
              description:
                readNamespaces.length > 1
                  ? `Optional. Namespace to write to for action=add or remove. ` +
                    `Must be one of: ${readNamespaces.join(", ")}. Defaults to ${memoryKey}.`
                  : "Optional. Namespace to write to. Defaults to the agent's primary namespace.",
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

      // Resolve target namespace for write operations (add / remove).
      // Validated against the allowedNamespaces list — rejects unknown keys.
      const rawTarget = typeof input["target_namespace"] === "string" ? input["target_namespace"].trim() : "";
      const writeTarget: string = (() => {
        if (!rawTarget) return memoryKey;
        if (readNamespaces.includes(rawTarget)) return rawTarget;
        return memoryKey; // silently fall back to primary rather than error
      })();

      // Load + prune the primary store for operations that need it.
      // For multi-namespace list we load all stores below.
      let store = pruneExpired(await loadMemoryStoreAny(writeTarget));

      if (action === "list") {
        if (readNamespaces.length === 1) {
          const block = renderMemoryBlock(store, maxChars);
          return {
            toolCallId: "",
            content: block || "No memories stored yet.",
            isError: false,
          };
        }
        // Multi-namespace: load all namespaces, merge entries, render.
        const allStores = await Promise.all(
          readNamespaces.map((k) => loadMemoryStoreAny(k).then(pruneExpired))
        );
        const merged: MemoryStore = {
          memoryKey: memoryKey,
          updatedAt: new Date().toISOString(),
          entries: allStores.flatMap((s) => s.entries),
        };
        const block = renderMemoryBlock(merged, maxChars);
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

        if (isSqliteMemoryEnabled()) {
          // Fast path: direct INSERT without load→mutate→save round-trip
          let embedding: number[] | undefined;
          let embeddingModel: string | undefined;
          if (embeddingOpts) {
            try {
              const vectors = await callEmbeddings(embeddingOpts.apiKey, embeddingOpts.model, [content]);
              embedding = vectors[0];
              embeddingModel = embeddingOpts.model;
            } catch {
              // Embedding failure must never block the memory save — fall through
            }
          }
          const entryData = {
            content,
            ...(tags && tags.length > 0 ? { tags } : {}),
            ...(expiresAt ? { expiresAt } : {}),
            importance,
            ...(embedding ? { _embedding: embedding, _embeddingModel: embeddingModel } : {}),
          };
          const saved = await withSpan("memory.save", { memoryKey: writeTarget, action: "add" }, () =>
            addMemoryEntrySqlite(writeTarget, entryData)
          );
          return {
            toolCallId: "",
            content: `Memory saved (id: ${saved.id}, namespace: ${writeTarget}, importance: ${importance}${tags && tags.length > 0 ? `, tags: ${tags.join(", ")}` : ""}): ${content}`,
            isError: false,
          };
        }

        // Wrap the entire load→mutate→save round-trip in a per-key lock to prevent
        // concurrent adds from silently dropping each other's entries (last-write-wins).
        let savedEntry: { id: string };
        await withMemoryLock(writeTarget, async () => {
          // Re-load inside the lock so we start from the latest persisted state
          let lockedStore = pruneExpired(await loadMemoryStoreAny(writeTarget));
          lockedStore = addMemoryEntry(lockedStore, {
            content,
            ...(tags && tags.length > 0 ? { tags } : {}),
            ...(expiresAt ? { expiresAt } : {}),
            importance,
          });

          // Attempt to embed the new entry if embeddingOpts provided
          if (embeddingOpts) {
            try {
              const vectors = await callEmbeddings(embeddingOpts.apiKey, embeddingOpts.model, [content]);
              const lastIdx = lockedStore.entries.length - 1;
              const updatedEntry = embedEntryIfNeeded(lockedStore.entries[lastIdx], vectors[0], embeddingOpts.model);
              lockedStore = {
                ...lockedStore,
                entries: [
                  ...lockedStore.entries.slice(0, lastIdx),
                  updatedEntry,
                ],
              };
            } catch {
              // Embedding failure must never block the memory save — fall through
            }
          }

          await withSpan("memory.save", { memoryKey: writeTarget, action: "add" }, async () =>
            saveMemoryStoreAny(writeTarget, lockedStore)
          );
          savedEntry = lockedStore.entries[lockedStore.entries.length - 1];
        });

        return {
          toolCallId: "",
          content: `Memory saved (id: ${savedEntry!.id}, namespace: ${writeTarget}, importance: ${importance}${tags && tags.length > 0 ? `, tags: ${tags.join(", ")}` : ""}): ${content}`,
          isError: false,
        };
      }

      if (action === "remove") {
        const id = typeof input["id"] === "string" ? input["id"].trim() : "";
        if (!id) {
          return { toolCallId: "", content: "id is required for action=remove", isError: true };
        }

        if (isSqliteMemoryEnabled()) {
          // Fast path: direct DELETE
          const deleted = await removeMemoryEntrySqlite(writeTarget, id);
          if (!deleted) {
            return { toolCallId: "", content: `No memory entry found with id: ${id}`, isError: false };
          }
          return { toolCallId: "", content: `Memory removed: ${id}`, isError: false };
        }

        let removeResult: { found: boolean } = { found: false };
        await withMemoryLock(writeTarget, async () => {
          let lockedStore = pruneExpired(await loadMemoryStoreAny(writeTarget));
          const before = lockedStore.entries.length;
          lockedStore = removeMemoryEntry(lockedStore, id);
          if (lockedStore.entries.length < before) {
            await saveMemoryStoreAny(writeTarget, lockedStore);
            removeResult = { found: true };
          }
        });
        if (!removeResult.found) {
          return { toolCallId: "", content: `No memory entry found with id: ${id}`, isError: false };
        }
        return { toolCallId: "", content: `Memory removed: ${id}`, isError: false };
      }

      // ── view_master ────────────────────────────────────────────────────────
      if (action === "view_master") {
        if (!isSqliteMemoryEnabled()) {
          return { toolCallId: "", content: "Master context requires SQLite (ORAGER_DB_PATH must not be 'none').", isError: true };
        }
        const ctx = await loadMasterContext(effectiveContextId);
        if (!ctx) {
          return { toolCallId: "", content: "No master context set yet. Use action=set_master to define it.", isError: false };
        }
        const tokenEstimate = Math.round(ctx.length / 4);
        return {
          toolCallId: "",
          content: `## Master Context (context_id: ${effectiveContextId}, ~${tokenEstimate} tokens)\n\n${ctx}`,
          isError: false,
        };
      }

      // ── set_master ─────────────────────────────────────────────────────────
      if (action === "set_master") {
        if (!isSqliteMemoryEnabled()) {
          return { toolCallId: "", content: "Master context requires SQLite (ORAGER_DB_PATH must not be 'none').", isError: true };
        }
        const raw = typeof input["content"] === "string" ? input["content"].trim() : "";
        if (!raw) {
          return { toolCallId: "", content: "content is required for action=set_master.", isError: true };
        }
        if (raw.length > MASTER_CONTEXT_MAX_CHARS) {
          return {
            toolCallId: "",
            content: `Content exceeds the ${MASTER_CONTEXT_MAX_CHARS}-char (~2k token) budget for master context. ` +
              `Please shorten it (current: ${raw.length} chars, limit: ${MASTER_CONTEXT_MAX_CHARS} chars).`,
            isError: true,
          };
        }
        await upsertMasterContext(effectiveContextId, raw);
        const tokenEstimate = Math.round(raw.length / 4);
        return {
          toolCallId: "",
          content: `Master context saved (~${tokenEstimate} tokens). It will be injected at the start of every future session.`,
          isError: false,
        };
      }

      return { toolCallId: "", content: `Unknown action: ${action}`, isError: true };
    },
  };
}
