/**
 * Cross-session persistent memory for orager agents.
 *
 * Entries are stored per-agent at:
 *   ~/.orager/memory/<sanitizedMemoryKey>.json
 *
 * The memoryKey is typically the Paperclip agent ID (passed via config) or,
 * for standalone use, derived from the working directory. This keeps memories
 * stable across session resets, summarizations, and new orager invocations.
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MemoryStore {
  memoryKey: string;
  entries: MemoryEntry[];
  updatedAt: string; // ISO
}

export interface MemoryEntry {
  id: string;           // crypto.randomUUID()
  content: string;      // freeform text, agent-authored
  tags?: string[];      // optional: ["bug", "auth", "user-pref"]
  createdAt: string;    // ISO
  expiresAt?: string;   // ISO — undefined means never expires
  runId?: string;       // orager session ID that created it
  importance: 1 | 2 | 3; // 1=low, 2=normal, 3=high (affects sort order)
}

// ── Storage path ──────────────────────────────────────────────────────────────

export const MEMORY_DIR =
  process.env["ORAGER_MEMORY_DIR"] ??
  path.join(os.homedir(), ".orager", "memory");

function sanitizeKey(memoryKey: string): string {
  return memoryKey.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
}

function memoryFilePath(memoryKey: string): string {
  return path.join(MEMORY_DIR, `${sanitizeKey(memoryKey)}.json`);
}

// ── Storage ───────────────────────────────────────────────────────────────────

export async function loadMemoryStore(memoryKey: string): Promise<MemoryStore> {
  const filePath = memoryFilePath(memoryKey);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as MemoryStore;
  } catch {
    // ENOENT or JSON parse error → return empty store (not an error)
    return { memoryKey, entries: [], updatedAt: new Date().toISOString() };
  }
}

export async function saveMemoryStore(memoryKey: string, store: MemoryStore): Promise<void> {
  const filePath = memoryFilePath(memoryKey);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(store, null, 2), { mode: 0o600 });
  await fs.rename(tmpPath, filePath);
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/**
 * Returns live entries sorted by importance desc, createdAt desc.
 * Truncates to maxChars to stay within token budget.
 *
 * Format (one entry per line):
 *   [1] (id: abc123, importance: 3, tags: auth) Auth tokens expire after 1h
 *   [2] (id: def456, importance: 2) User prefers TypeScript for new files
 */
export function renderMemoryBlock(store: MemoryStore, maxChars = 6000): string {
  if (store.entries.length === 0) return "";

  const sorted = [...store.entries].sort((a, b) => {
    if (b.importance !== a.importance) return b.importance - a.importance;
    return b.createdAt.localeCompare(a.createdAt);
  });

  const lines: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i];
    const tagPart = e.tags && e.tags.length > 0 ? `, tags: ${e.tags.join(", ")}` : "";
    lines.push(`[${i + 1}] (id: ${e.id}, importance: ${e.importance}${tagPart}) ${e.content}`);
  }

  let result = lines.join("\n");
  if (result.length <= maxChars) return result;

  // Truncate at maxChars without leaking a partial entry
  const truncated = result.slice(0, maxChars);
  const lastNewline = truncated.lastIndexOf("\n");
  return lastNewline > 0 ? truncated.slice(0, lastNewline) : "";
}

// ── Writes ────────────────────────────────────────────────────────────────────

/** Adds an entry. Returns a new store — original is unchanged. */
export function addMemoryEntry(
  store: MemoryStore,
  entry: Omit<MemoryEntry, "id" | "createdAt">,
): MemoryStore {
  const now = new Date().toISOString();
  const newEntry: MemoryEntry = {
    ...entry,
    importance: entry.importance ?? 2,
    id: crypto.randomUUID(),
    createdAt: now,
  };
  return {
    ...store,
    entries: [...store.entries, newEntry],
    updatedAt: now,
  };
}

/** Removes an entry by id. No-ops when id doesn't exist. Returns a new store. */
export function removeMemoryEntry(store: MemoryStore, id: string): MemoryStore {
  const entries = store.entries.filter((e) => e.id !== id);
  if (entries.length === store.entries.length) return store;
  return { ...store, entries, updatedAt: new Date().toISOString() };
}

// ── Maintenance ───────────────────────────────────────────────────────────────

/** Removes expired entries. Returns a new store — original is unchanged. */
export function pruneExpired(store: MemoryStore): MemoryStore {
  const now = new Date().toISOString();
  const entries = store.entries.filter((e) => !e.expiresAt || e.expiresAt > now);
  if (entries.length === store.entries.length) return store;
  return { ...store, entries, updatedAt: new Date().toISOString() };
}

// ── Key derivation ────────────────────────────────────────────────────────────

/**
 * Derive a stable memory key from a working directory path for standalone use.
 * Produces a short hash so the filename stays readable on all platforms.
 */
export function memoryKeyFromCwd(cwd: string): string {
  const hash = crypto.createHash("sha1").update(cwd).digest("hex").slice(0, 12);
  const label = path.basename(cwd).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32);
  return `${label}_${hash}`;
}
