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
  await fs.writeFile(sessionPath(data.sessionId), JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
}

export async function loadSession(sessionId: string): Promise<SessionData | null> {
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

export function newSessionId(): string {
  return crypto.randomUUID();
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
