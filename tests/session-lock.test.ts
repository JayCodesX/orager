import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { acquireSessionLock, SESSIONS_DIR } from "../src/session.js";

// Helpers
const sessionsDir = path.join(os.homedir(), ".orager", "sessions");

function lockFilePath(sessionId: string): string {
  return path.join(sessionsDir, `${sessionId}.run.lock`);
}

async function cleanupLock(sessionId: string): Promise<void> {
  try {
    await fs.unlink(lockFilePath(sessionId));
  } catch {
    // ignore if already gone
  }
}

const createdIds: string[] = [];

beforeEach(() => {
  createdIds.length = 0;
});

afterEach(async () => {
  for (const id of createdIds) {
    await cleanupLock(id);
  }
});

function uniqueId(): string {
  return "lock-test-" + Math.random().toString(36).slice(2);
}

describe("acquireSessionLock", () => {
  it("acquires lock, lock file exists, release removes it", async () => {
    const sessionId = uniqueId();
    createdIds.push(sessionId);

    const release = await acquireSessionLock(sessionId);

    // Lock file should exist after acquire
    const lp = lockFilePath(sessionId);
    await expect(fs.access(lp)).resolves.toBeUndefined();

    await release();

    // Lock file should be gone after release
    await expect(fs.access(lp)).rejects.toThrow();
  });

  it("double-acquire on same session throws with 'already being resumed'", async () => {
    const sessionId = uniqueId();
    createdIds.push(sessionId);

    const release = await acquireSessionLock(sessionId);
    try {
      await expect(acquireSessionLock(sessionId)).rejects.toThrow(
        /already being resumed/,
      );
    } finally {
      await release();
    }
  });

  it("release is idempotent — calling it twice does not throw", async () => {
    const sessionId = uniqueId();
    createdIds.push(sessionId);

    const release = await acquireSessionLock(sessionId);
    await release();
    await expect(release()).resolves.toBeUndefined();
  });

  it("stale lock (10 minutes old) is overwritten and acquire succeeds", async () => {
    const sessionId = uniqueId();
    createdIds.push(sessionId);

    // Write a stale lock file manually
    await fs.mkdir(sessionsDir, { recursive: true });
    const lp = lockFilePath(sessionId);
    const staleLock = JSON.stringify({ pid: 99999, at: Date.now() - 10 * 60 * 1000 });
    await fs.writeFile(lp, staleLock, "utf8");

    // Should succeed because the lock is stale (older than 5-minute threshold)
    const release = await acquireSessionLock(sessionId);
    try {
      const lp2 = lockFilePath(sessionId);
      await expect(fs.access(lp2)).resolves.toBeUndefined();
    } finally {
      await release();
    }
  });

  it("corrupted lock file (non-JSON) is treated as stale and acquire succeeds", async () => {
    const sessionId = uniqueId();
    createdIds.push(sessionId);

    // Write a corrupted lock file
    await fs.mkdir(sessionsDir, { recursive: true });
    const lp = lockFilePath(sessionId);
    await fs.writeFile(lp, "not json", "utf8");

    // Should succeed because corrupted = stale
    const release = await acquireSessionLock(sessionId);
    try {
      await expect(fs.access(lp)).resolves.toBeUndefined();
    } finally {
      await release();
    }
  });

  it("lock file path ends with .run.lock", async () => {
    const sessionId = uniqueId();
    createdIds.push(sessionId);

    const release = await acquireSessionLock(sessionId);
    try {
      const lp = lockFilePath(sessionId);
      expect(lp.endsWith(".run.lock")).toBe(true);

      // Also verify via SESSIONS_DIR export that it's in the sessions directory
      const expectedDir = SESSIONS_DIR;
      expect(path.dirname(lp)).toBe(expectedDir);
    } finally {
      await release();
    }
  });
});
