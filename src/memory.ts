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
import {
  isSqliteMemoryEnabled,
  loadMemoryStoreSqlite,
  saveMemoryStoreSqlite,
} from "./memory-sqlite.js";

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
  _embedding?: number[];    // cached embedding vector
  _embeddingModel?: string; // model used to generate it
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

// ── Retrieval ─────────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "the","a","an","is","it","to","of","and","or","in","on","at","for","with",
  "this","that","was","are","be","by","as","from","but","not","has","have",
  "had","do","did","will","would","could","should","can","may","might",
]);

/**
 * Lowercases, splits on whitespace and punctuation, removes stop words,
 * and returns unique tokens with length >= 3.
 */
export function buildQuery(text: string): string[] {
  const tokens = text.toLowerCase().split(/[\s\p{P}]+/u);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tok of tokens) {
    if (tok.length >= 3 && !STOP_WORDS.has(tok) && !seen.has(tok)) {
      seen.add(tok);
      result.push(tok);
    }
  }
  return result;
}

/**
 * Scores a memory entry against a set of query tokens.
 * Combines term overlap, importance weight, and recency decay.
 */
export function scoreEntry(entry: MemoryEntry, queryTokens: string[]): number {
  const contentLower = entry.content.toLowerCase();
  const matchCount = queryTokens.filter((tok) => contentLower.includes(tok)).length;
  const termOverlap = matchCount / Math.max(queryTokens.length, 1);

  const importanceWeight = entry.importance === 3 ? 1.5 : entry.importance === 2 ? 1.0 : 0.6;

  const days = (Date.now() - Date.parse(entry.createdAt)) / 86400000;
  const recencyDecay = 1 / (1 + days / 30);

  return termOverlap * importanceWeight * recencyDecay;
}

/**
 * Retrieves the most relevant entries for a query.
 * Falls back to importance+recency sort when queryTokens is empty.
 */
export function retrieveEntries(
  store: MemoryStore,
  query: string,
  opts?: { topK?: number; minScore?: number },
): MemoryEntry[] {
  const topK = opts?.topK ?? 12;
  const minScore = opts?.minScore ?? 0.0;
  const queryTokens = buildQuery(query);

  if (queryTokens.length === 0) {
    // Fall back to importance+recency sort
    return [...store.entries]
      .sort((a, b) => {
        if (b.importance !== a.importance) return b.importance - a.importance;
        return b.createdAt.localeCompare(a.createdAt);
      })
      .slice(0, topK);
  }

  return store.entries
    .map((entry) => ({ entry, score: scoreEntry(entry, queryTokens) }))
    .filter(({ score }) => score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ entry }) => entry);
}

/**
 * Same format as renderMemoryBlock but operates on a pre-filtered list.
 * Re-numbers entries [1], [2], ...
 */
export function renderRetrievedBlock(entries: MemoryEntry[], maxChars = 6000): string {
  if (entries.length === 0) return "";

  const lines: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const tagPart = e.tags && e.tags.length > 0 ? `, tags: ${e.tags.join(", ")}` : "";
    lines.push(`[${i + 1}] (id: ${e.id}, importance: ${e.importance}${tagPart}) ${e.content}`);
  }

  let result = lines.join("\n");
  if (result.length <= maxChars) return result;

  const truncated = result.slice(0, maxChars);
  const lastNewline = truncated.lastIndexOf("\n");
  return lastNewline > 0 ? truncated.slice(0, lastNewline) : "";
}

// ── Embedding-based retrieval (Phase 2) ───────────────────────────────────────

/**
 * Compute cosine similarity between two vectors.
 * Returns 0 if either vector has zero magnitude.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  if (denom === 0) return 0;
  return dot / denom;
}

/**
 * Returns a new MemoryEntry with _embedding and _embeddingModel set.
 * Pure — no side effects.
 */
export function embedEntryIfNeeded(
  entry: MemoryEntry,
  embedding: number[],
  model: string,
): MemoryEntry {
  return { ...entry, _embedding: embedding, _embeddingModel: model };
}

/**
 * Retrieve entries ranked by embedding cosine similarity combined with
 * importance weight and recency decay.
 * Entries without a cached _embedding fall back to Phase 1 scoreEntry
 * with an empty query (importance+recency only).
 */
export function retrieveEntriesWithEmbeddings(
  store: MemoryStore,
  queryEmbedding: number[],
  opts?: { topK?: number; minScore?: number },
): MemoryEntry[] {
  const topK = opts?.topK ?? 12;
  const minScore = opts?.minScore ?? 0.0;

  const scored = store.entries.map((entry) => {
    const importanceWeight = entry.importance === 3 ? 1.5 : entry.importance === 2 ? 1.0 : 0.6;
    const days = (Date.now() - Date.parse(entry.createdAt)) / 86400000;
    const recencyDecay = 1 / (1 + days / 30);

    let score: number;
    if (entry._embedding && entry._embedding.length > 0) {
      const sim = cosineSimilarity(entry._embedding, queryEmbedding);
      score = sim * importanceWeight * recencyDecay;
    } else {
      score = scoreEntry(entry, []);
    }

    return { entry, score };
  });

  return scored
    .filter(({ score }) => score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ entry }) => entry);
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

// ── Per-key write lock ────────────────────────────────────────────────────────
//
// Prevents concurrent writes from silently dropping entries via last-write-wins.
// Uses a promise-chaining mutex pattern: each lock operation chains on the
// previous one for the same key so writes are always serialised.

const _memoryWriteLocks = new Map<string, Promise<void>>();

/**
 * Acquire a per-key advisory lock, run fn(), then release.
 * Concurrent callers with the same key are queued in order.
 * Exported for testing; _clearMemoryLocksForTesting() resets state.
 */
export async function withMemoryLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = _memoryWriteLocks.get(key) ?? Promise.resolve();
  let resolve!: () => void;
  const next = new Promise<void>((res) => { resolve = res; });
  // Store a non-rejecting sentinel so failures don't block subsequent waiters
  _memoryWriteLocks.set(key, next.catch(() => {}));

  await prev.catch(() => {}); // wait for any in-flight operation on this key
  try {
    return await fn();
  } finally {
    resolve();
    // Clean up map entry if no newer waiter has replaced it
    if (_memoryWriteLocks.get(key) === next.catch(() => {})) {
      // Best-effort cleanup — map may have been updated by a queued waiter
    }
  }
}

/** Reset lock state — for testing only. */
export function _clearMemoryLocksForTesting(): void {
  _memoryWriteLocks.clear();
}

// ── Storage router ────────────────────────────────────────────────────────────

/**
 * Load memory store from SQLite when ORAGER_DB_PATH is set, otherwise from JSON file.
 */
export async function loadMemoryStoreAny(memoryKey: string): Promise<MemoryStore> {
  if (isSqliteMemoryEnabled()) return loadMemoryStoreSqlite(memoryKey);
  return loadMemoryStore(memoryKey);
}

/**
 * Save memory store to SQLite when ORAGER_DB_PATH is set, otherwise to JSON file.
 */
export async function saveMemoryStoreAny(memoryKey: string, store: MemoryStore): Promise<void> {
  if (isSqliteMemoryEnabled()) { saveMemoryStoreSqlite(memoryKey, store); return; }
  await saveMemoryStore(memoryKey, store);
}
