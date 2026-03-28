/**
 * P3-3: Concurrency / load tests for memory writes and session locks.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { withMemoryLock, _clearMemoryLocksForTesting } from "../src/memory.js";
import { acquireSessionLock } from "../src/session.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const sessionsDir = path.join(os.homedir(), ".orager", "sessions");

function lockFilePath(sessionId: string): string {
  return path.join(sessionsDir, `${sessionId}.run.lock`);
}

const createdIds: string[] = [];

beforeEach(() => {
  _clearMemoryLocksForTesting();
  createdIds.length = 0;
});

afterEach(async () => {
  for (const id of createdIds) {
    try { await fs.unlink(lockFilePath(id)); } catch { /* ignore */ }
  }
});

function uniqueId(): string {
  return "conc-test-" + Math.random().toString(36).slice(2);
}

describe("Memory concurrency", () => {
  it("10 concurrent writes to same key — all entries persist", async () => {
    const key = "high-concurrency-key";
    const shared: number[] = [];

    async function write(value: number): Promise<void> {
      await withMemoryLock(key, async () => {
        const snapshot = [...shared];
        await new Promise<void>((r) => setTimeout(r, 5));
        shared.length = 0;
        for (const v of snapshot) shared.push(v);
        shared.push(value);
      });
    }

    const ops = Array.from({ length: 10 }, (_, i) => write(i));
    await Promise.all(ops);

    expect(shared).toHaveLength(10);
    for (let i = 0; i < 10; i++) {
      expect(shared).toContain(i);
    }
  });

  it("5 concurrent writes to different keys — all complete without interference", async () => {
    const results: Map<string, number> = new Map();

    async function writeKey(key: string, value: number): Promise<void> {
      await withMemoryLock(key, async () => {
        await new Promise<void>((r) => setTimeout(r, 5));
        results.set(key, value);
      });
    }

    const ops = Array.from({ length: 5 }, (_, i) => writeKey(`key-${i}`, i * 10));
    await Promise.all(ops);

    expect(results.size).toBe(5);
    for (let i = 0; i < 5; i++) {
      expect(results.get(`key-${i}`)).toBe(i * 10);
    }
  });

  it("20 concurrent operations serialized by withMemoryLock — no lost writes", async () => {
    const key = "lock-serialization-key";
    let counter = 0;
    const order: number[] = [];

    const ops = Array.from({ length: 20 }, (_, i) =>
      withMemoryLock(key, async () => {
        const current = counter;
        await new Promise<void>((r) => setTimeout(r, 1));
        counter = current + 1;
        order.push(i);
      }),
    );

    await Promise.all(ops);

    // Counter must equal 20 — no lost increments due to races
    expect(counter).toBe(20);
    expect(order).toHaveLength(20);
  });
});

describe("Session lock concurrency", () => {
  it("two concurrent attempts to lock same session — second throws expected error", async () => {
    const sessionId = uniqueId();
    createdIds.push(sessionId);

    const release = await acquireSessionLock(sessionId);
    try {
      await expect(
        acquireSessionLock(sessionId, { timeoutMs: 150, initialDelayMs: 30 }),
      ).rejects.toThrow("Cannot start concurrent runs on the same session.");
    } finally {
      await release();
    }
  });

  it("after first holder releases, second attempt succeeds", async () => {
    const sessionId = uniqueId();
    createdIds.push(sessionId);

    const release1 = await acquireSessionLock(sessionId);

    // Release after 60ms while the second is still retrying
    setTimeout(() => { void release1(); }, 60);

    const release2 = await acquireSessionLock(sessionId, {
      timeoutMs: 800,
      initialDelayMs: 20,
    });
    expect(typeof release2).toBe("function");
    await release2();
  });
});
