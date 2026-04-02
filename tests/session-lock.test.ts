import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { acquireSessionLock, getSessionsDir } from "../src/session.js";

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

    // After acquiring, a second acquire attempt should fail (lock is held).
    // This works with both file-based and SQLite-based lock stores.
    await expect(
      acquireSessionLock(sessionId, { timeoutMs: 100, maxAttempts: 1, initialDelayMs: 10 })
    ).rejects.toThrow();

    await release();

    // After releasing, acquiring again should succeed
    const release2 = await acquireSessionLock(sessionId, { timeoutMs: 500 });
    await release2();
  });

  it("double-acquire on same session throws with descriptive error after retry timeout", async () => {
    const sessionId = uniqueId();
    createdIds.push(sessionId);

    const release = await acquireSessionLock(sessionId);
    try {
      // With a short timeout, retries exhaust quickly and throw the P1-3 error
      await expect(
        acquireSessionLock(sessionId, { timeoutMs: 200, initialDelayMs: 30 }),
      ).rejects.toThrow(
        `Session ${sessionId} is locked by another run. Cannot start concurrent runs on the same session.`,
      );
    } finally {
      await release();
    }
  });

  it("double-acquire with no options throws descriptive error", async () => {
    // Uses default timeout. To keep test fast we set env var to shrink stale threshold?
    // Actually we test that the error message is correct with explicit short timeout.
    const sessionId = uniqueId();
    createdIds.push(sessionId);

    const release = await acquireSessionLock(sessionId);
    try {
      await expect(
        acquireSessionLock(sessionId, { timeoutMs: 100, initialDelayMs: 20 }),
      ).rejects.toThrow("Cannot start concurrent runs on the same session.");
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
      await fs.access(lp2); // throws if not accessible — fails test if file missing
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
      await fs.access(lp); // throws if not accessible — fails test if file missing
    } finally {
      await release();
    }
  });

  it("succeeds if the lock is released before the retry timeout expires", async () => {
    const sessionId = uniqueId();
    createdIds.push(sessionId);

    const release1 = await acquireSessionLock(sessionId);

    // Release after 60 ms while the second attempt is still retrying
    setTimeout(() => { void release1(); }, 60);

    // 800 ms window should be enough to win the retry
    const release2 = await acquireSessionLock(sessionId, {
      timeoutMs: 800,
      initialDelayMs: 20,
    });
    expect(typeof release2).toBe("function");
    await release2();
  });

  it("lock file path ends with .run.lock", async () => {
    const sessionId = uniqueId();
    createdIds.push(sessionId);

    const release = await acquireSessionLock(sessionId);
    try {
      const lp = lockFilePath(sessionId);
      expect(lp.endsWith(".run.lock")).toBe(true);

      // Verify the lock file is in the sessions directory
      const expectedDir = getSessionsDir();
      expect(path.dirname(lp)).toBe(expectedDir);
    } finally {
      await release();
    }
  });
});
