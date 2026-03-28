/**
 * Abstract session store interface.
 * Both the file-based store (default) and SQLite store implement this.
 */
import type { SessionData, SessionSummary, PruneResult } from "./types.js";

export interface SessionStore {
  save(data: SessionData): Promise<void>;
  load(sessionId: string): Promise<SessionData | null>;
  loadRaw(sessionId: string): Promise<SessionData | null>;
  delete(sessionId: string): Promise<void>;
  list(opts?: { offset?: number; limit?: number }): Promise<SessionSummary[]>;
  prune(olderThanMs: number): Promise<PruneResult>;
  deleteTrash(): Promise<PruneResult>;
  acquireLock(sessionId: string): Promise<() => Promise<void>>;
}
