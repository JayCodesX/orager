import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { SessionData } from "./types.js";

export const SESSIONS_DIR = path.join(os.homedir(), ".orager", "sessions");

function sessionPath(sessionId: string): string {
  return path.join(SESSIONS_DIR, `${sessionId}.json`);
}

export async function saveSession(data: SessionData): Promise<void> {
  await fs.mkdir(SESSIONS_DIR, { recursive: true });
  const target = sessionPath(data.sessionId);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * Load a session by ID. Returns null if the session does not exist or has
 * been marked as trashed (trashed sessions are skipped on resume).
 */
export async function loadSession(sessionId: string): Promise<SessionData | null> {
  try {
    const raw = await fs.readFile(sessionPath(sessionId), "utf8");
    const data = JSON.parse(raw) as SessionData;
    if (data.trashed) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Load a session regardless of its trashed status. Used for management
 * commands (list, delete) that need to see all sessions including trashed ones.
 */
export async function loadSessionRaw(sessionId: string): Promise<SessionData | null> {
  try {
    const raw = await fs.readFile(sessionPath(sessionId), "utf8");
    return JSON.parse(raw) as SessionData;
  } catch {
    return null;
  }
}

export async function deleteSession(sessionId: string): Promise<void> {
  try {
    await fs.unlink(sessionPath(sessionId));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

/**
 * Mark a session as trashed. It will be preserved on disk but skipped on
 * resume. Use listSessions() to review trashed sessions, deleteSession() to
 * permanently remove them.
 */
export async function trashSession(sessionId: string): Promise<boolean> {
  const data = await loadSessionRaw(sessionId);
  if (!data) return false;
  await saveSession({ ...data, trashed: true });
  return true;
}

/**
 * Restore a trashed session so it can be resumed again.
 */
export async function restoreSession(sessionId: string): Promise<boolean> {
  const data = await loadSessionRaw(sessionId);
  if (!data) return false;
  const { trashed: _removed, ...rest } = data;
  await saveSession(rest as SessionData);
  return true;
}

export function newSessionId(): string {
  return crypto.randomUUID();
}

// ── Session listing ───────────────────────────────────────────────────────────

export interface SessionSummary {
  sessionId: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
  cwd: string;
  trashed: boolean;
}

/**
 * List all sessions. Returns summaries sorted by updatedAt descending (most
 * recent first). Includes trashed sessions so they can be reviewed and deleted.
 */
export async function listSessions(): Promise<SessionSummary[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(SESSIONS_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const summaries: SessionSummary[] = [];

  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const sessionId = entry.slice(0, -5);
    const data = await loadSessionRaw(sessionId);
    if (!data) continue;
    summaries.push({
      sessionId: data.sessionId,
      model: data.model,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      turnCount: data.turnCount,
      cwd: data.cwd,
      trashed: data.trashed === true,
    });
  }

  return summaries.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
}

// ── Pruning ───────────────────────────────────────────────────────────────────

export interface PruneResult {
  deleted: number;
  kept: number;
  errors: number;
}

/**
 * Delete session files that haven't been modified in more than `olderThanMs`
 * milliseconds. Returns counts of deleted, kept, and errored files.
 */
export async function pruneOldSessions(olderThanMs: number): Promise<PruneResult> {
  const cutoff = Date.now() - olderThanMs;
  let deleted = 0;
  let kept = 0;
  let errors = 0;

  let entries: string[];
  try {
    entries = await fs.readdir(SESSIONS_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { deleted: 0, kept: 0, errors: 0 };
    throw err;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const filePath = path.join(SESSIONS_DIR, entry);
    try {
      const stat = await fs.stat(filePath);
      if (stat.mtimeMs < cutoff) {
        await fs.unlink(filePath);
        deleted++;
      } else {
        kept++;
      }
    } catch {
      errors++;
    }
  }

  return { deleted, kept, errors };
}

/**
 * Roll back a session to a given turn number by truncating the message
 * history. Turn 1 = the first assistant reply and its tool results.
 *
 * Returns { ok: false } if the session doesn't exist.
 * Returns { ok: true, originalTurnCount, newTurnCount } on success.
 * If toTurn >= current turnCount the session is unchanged.
 */
export async function rollbackSession(
  sessionId: string,
  toTurn: number,
): Promise<{ ok: boolean; originalTurnCount: number; newTurnCount: number }> {
  const data = await loadSessionRaw(sessionId);
  if (!data) return { ok: false, originalTurnCount: 0, newTurnCount: 0 };

  const { messages } = data;
  const originalTurnCount = data.turnCount;

  if (toTurn >= originalTurnCount) {
    return { ok: true, originalTurnCount, newTurnCount: originalTurnCount };
  }
  if (toTurn <= 0) {
    // Roll back to before any assistant turn — keep only the first user message
    const firstUserIdx = messages.findIndex((m) => m.role === "user");
    const truncated = firstUserIdx >= 0 ? messages.slice(0, firstUserIdx + 1) : [];
    await saveSession({ ...data, messages: truncated, turnCount: 0, updatedAt: new Date().toISOString() });
    return { ok: true, originalTurnCount, newTurnCount: 0 };
  }

  // Find the cut point: end of the tool-message block following the Nth
  // AssistantMessage (turns are 1-indexed).
  let turnsSeen = 0;
  let cutIndex = messages.length;

  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "assistant") {
      turnsSeen++;
      if (turnsSeen === toTurn) {
        // Include all immediately following ToolMessages
        let j = i + 1;
        while (j < messages.length && messages[j].role === "tool") j++;
        cutIndex = j;
        break;
      }
    }
  }

  await saveSession({
    ...data,
    messages: messages.slice(0, cutIndex),
    turnCount: toTurn,
    updatedAt: new Date().toISOString(),
  });

  return { ok: true, originalTurnCount, newTurnCount: toTurn };
}

/**
 * Delete all sessions currently marked as trashed.
 */
export async function deleteTrashedSessions(): Promise<PruneResult> {
  const sessions = await listSessions();
  const trashed = sessions.filter((s) => s.trashed);
  let deleted = 0;
  let errors = 0;

  for (const s of trashed) {
    try {
      await deleteSession(s.sessionId);
      deleted++;
    } catch {
      errors++;
    }
  }

  return { deleted, kept: sessions.length - trashed.length, errors };
}
