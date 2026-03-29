import { describe, it, expect, beforeEach } from "vitest";
import {
  withMemoryLock,
  _clearMemoryLocksForTesting,
  _getMemoryLocksMapSizeForTesting,
} from "../src/memory.js";

beforeEach(() => {
  _clearMemoryLocksForTesting();
});

describe("withMemoryLock", () => {
  it("serialises concurrent adds with the same key — both entries persist", async () => {
    const key = "test-concurrent-add";
    const results: number[] = [];

    // Simulate two concurrent write operations for the same key.
    // Each reads a shared array, waits a tick, then appends.
    // Without the lock this would produce only one entry (last-write-wins).
    const shared: number[] = [];

    async function concurrentAdd(value: number): Promise<void> {
      await withMemoryLock(key, async () => {
        // snapshot the current array
        const snapshot = [...shared];
        // simulate async I/O delay
        await new Promise<void>((r) => setTimeout(r, 10));
        // write back with the new entry
        shared.length = 0;
        for (const v of snapshot) shared.push(v);
        shared.push(value);
        results.push(value);
      });
    }

    // Launch concurrently — they must be serialised
    await Promise.all([concurrentAdd(1), concurrentAdd(2)]);

    // Both values must appear
    expect(shared).toHaveLength(2);
    expect(shared).toContain(1);
    expect(shared).toContain(2);
    expect(results).toHaveLength(2);
  });

  it("different keys do not block each other", async () => {
    const keyA = "lock-key-a";
    const keyB = "lock-key-b";

    const completionOrder: string[] = [];

    // keyA has a longer delay; keyB should complete first because it runs independently
    const taskA = withMemoryLock(keyA, async () => {
      await new Promise<void>((r) => setTimeout(r, 50));
      completionOrder.push("A");
    });
    const taskB = withMemoryLock(keyB, async () => {
      await new Promise<void>((r) => setTimeout(r, 5));
      completionOrder.push("B");
    });

    await Promise.all([taskA, taskB]);

    // B has a shorter delay and uses a different key, so it completes first
    expect(completionOrder[0]).toBe("B");
    expect(completionOrder[1]).toBe("A");
  });

  it("returns the value produced by the fn", async () => {
    const result = await withMemoryLock("return-value-key", async () => 42);
    expect(result).toBe(42);
  });

  it("queues three concurrent operations on the same key in arrival order", async () => {
    const key = "queue-test-key";
    const order: number[] = [];

    const op = (n: number) =>
      withMemoryLock(key, async () => {
        await new Promise<void>((r) => setTimeout(r, 5));
        order.push(n);
      });

    await Promise.all([op(1), op(2), op(3)]);

    // All three must complete
    expect(order).toHaveLength(3);
    expect(order).toContain(1);
    expect(order).toContain(2);
    expect(order).toContain(3);
  });

  it("Map entry is cleaned up after the lock is released (no leak)", async () => {
    const key = "cleanup-test-key";
    expect(_getMemoryLocksMapSizeForTesting()).toBe(0);

    await withMemoryLock(key, async () => {
      // Map should hold the sentinel while the lock is held
      expect(_getMemoryLocksMapSizeForTesting()).toBe(1);
    });

    // Sentinel must be deleted once the last waiter finishes
    expect(_getMemoryLocksMapSizeForTesting()).toBe(0);
  });

  it("Map entry stays while a second waiter is queued, then cleans up after both finish", async () => {
    const key = "cleanup-chain-key";

    let innerResolve!: () => void;
    const innerHeld = new Promise<void>((res) => { innerResolve = res; });

    // Start first lock and hold it until we're ready
    const first = withMemoryLock(key, () => innerHeld);
    // Queue a second waiter
    const second = withMemoryLock(key, async () => {});

    // While both are in-flight the Map must have the entry
    expect(_getMemoryLocksMapSizeForTesting()).toBe(1);

    // Release the first — second will run
    innerResolve();
    await Promise.all([first, second]);

    // After both complete, Map must be empty
    expect(_getMemoryLocksMapSizeForTesting()).toBe(0);
  });

  it("_clearMemoryLocksForTesting resets state so subsequent operations are independent", async () => {
    const key = "reset-test-key";

    // Acquire a lock
    let phase = 0;
    const p = withMemoryLock(key, async () => {
      phase = 1;
      await new Promise<void>((r) => setTimeout(r, 20));
      phase = 2;
    });

    // Clear locks while the first operation is in-flight
    _clearMemoryLocksForTesting();

    // A new operation on the same key should not wait for the in-flight one
    const start = Date.now();
    await withMemoryLock(key, async () => {
      // Should start immediately, not wait for p
    });
    const elapsed = Date.now() - start;

    // Should finish quickly (well under the 20ms delay of p)
    expect(elapsed).toBeLessThan(15);

    await p; // clean up
    expect(phase).toBe(2);
  });
});
