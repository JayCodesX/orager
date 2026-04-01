/**
 * Tests for Phase 5 — session-end synthesis and cross-session cold-start.
 *
 * Covers:
 *  - loadLatestCheckpointByContextId: returns null when no synthesised checkpoint exists
 *  - loadLatestCheckpointByContextId: ignores raw checkpoints (summary IS NULL)
 *  - loadLatestCheckpointByContextId: returns the most recent synthesised checkpoint
 *  - loadLatestCheckpointByContextId: returns the correct checkpoint when multiple
 *    threads share a context_id (picks newest by updated_at)
 *  - loadLatestCheckpointByContextId: context_id isolation (different namespaces don't bleed)
 *  - MEMORY_HEADER_PRIOR_SESSION constant: exists and is a non-empty string
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteSessionStore } from "../src/session-sqlite.js";
import { MEMORY_HEADER_PRIOR_SESSION } from "../src/loop-helpers.js";

// ── MEMORY_HEADER_PRIOR_SESSION ───────────────────────────────────────────────

describe("MEMORY_HEADER_PRIOR_SESSION", () => {
  it("is a non-empty string starting with ##", () => {
    expect(typeof MEMORY_HEADER_PRIOR_SESSION).toBe("string");
    expect(MEMORY_HEADER_PRIOR_SESSION.length).toBeGreaterThan(0);
    expect(MEMORY_HEADER_PRIOR_SESSION.startsWith("##")).toBe(true);
  });

  it("does not collide with other memory header constants", async () => {
    const { MEMORY_HEADER_MASTER, MEMORY_HEADER_RETRIEVED, MEMORY_HEADER_AUTO } =
      await import("../src/loop-helpers.js");
    expect(MEMORY_HEADER_PRIOR_SESSION).not.toBe(MEMORY_HEADER_MASTER);
    expect(MEMORY_HEADER_PRIOR_SESSION).not.toBe(MEMORY_HEADER_RETRIEVED);
    expect(MEMORY_HEADER_PRIOR_SESSION).not.toBe(MEMORY_HEADER_AUTO);
  });
});

// ── loadLatestCheckpointByContextId ──────────────────────────────────────────

describe("SqliteSessionStore.loadLatestCheckpointByContextId", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orager-phase5-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when no checkpoint exists for the context", async () => {
    const store = await SqliteSessionStore.create(path.join(tmpDir, "p5a.db"));
    expect(store.loadLatestCheckpointByContextId("ctx-unknown")).toBeNull();
  });

  it("returns null when only a raw checkpoint (no summary) exists", async () => {
    const store = await SqliteSessionStore.create(path.join(tmpDir, "p5b.db"));
    const msgs = [{ role: "user", content: "hi" }];

    // Raw checkpoint — summary IS NULL
    store.saveCheckpoint("thread-raw", "ctx-raw", 2, null, msgs);

    const result = store.loadLatestCheckpointByContextId("ctx-raw");
    expect(result).toBeNull();
  });

  it("returns the synthesised checkpoint when one exists", async () => {
    const store = await SqliteSessionStore.create(path.join(tmpDir, "p5c.db"));
    const msgs = [{ role: "user", content: "hello" }, { role: "assistant", content: "world" }];

    store.saveCheckpoint("thread-syn", "ctx-syn", 5, "The agent completed the task.", msgs);

    const result = store.loadLatestCheckpointByContextId("ctx-syn");
    expect(result).not.toBeNull();
    expect(result!.threadId).toBe("thread-syn");
    expect(result!.contextId).toBe("ctx-syn");
    expect(result!.lastTurn).toBe(5);
    expect(result!.summary).toBe("The agent completed the task.");
    expect(result!.fullState).toEqual(msgs);
  });

  it("returns the most recent synthesised checkpoint when a thread has both raw and synthesised", async () => {
    const store = await SqliteSessionStore.create(path.join(tmpDir, "p5d.db"));
    const msgs = [{ role: "user", content: "x" }];

    // Raw checkpoint first, then upgraded with a summary
    store.saveCheckpoint("thread-upg", "ctx-upg", 3, null, msgs);
    store.saveCheckpoint("thread-upg", "ctx-upg", 3, "Synthesised summary here.", msgs);

    const result = store.loadLatestCheckpointByContextId("ctx-upg");
    expect(result).not.toBeNull();
    expect(result!.summary).toBe("Synthesised summary here.");
  });

  it("picks the most recent thread when multiple threads share a context_id", async () => {
    const store = await SqliteSessionStore.create(path.join(tmpDir, "p5e.db"));
    const msgs = [{ role: "user", content: "y" }];

    // Simulate two consecutive sessions for the same project (same contextId)
    store.saveCheckpoint("session-old", "ctx-proj", 4, "Old session summary.", msgs);
    // Slight sleep not possible in sync test — saveCheckpoint upserts so we
    // insert a second thread directly and verify ordering by updated_at.
    // In practice updated_at is the wall clock; here we just confirm that
    // after writing both, the one with the later write is returned.
    store.saveCheckpoint("session-new", "ctx-proj", 8, "New session summary.", msgs);

    const result = store.loadLatestCheckpointByContextId("ctx-proj");
    expect(result).not.toBeNull();
    // The newest write should win (ORDER BY updated_at DESC)
    expect(result!.summary).toBe("New session summary.");
    expect(result!.threadId).toBe("session-new");
  });

  it("context_id isolation — different namespaces do not bleed into each other", async () => {
    const store = await SqliteSessionStore.create(path.join(tmpDir, "p5f.db"));
    const msgs = [{ role: "user", content: "z" }];

    store.saveCheckpoint("thread-X", "ctx-alpha", 3, "Alpha summary.", msgs);
    store.saveCheckpoint("thread-Y", "ctx-beta",  3, "Beta summary.",  msgs);

    expect(store.loadLatestCheckpointByContextId("ctx-alpha")!.summary).toBe("Alpha summary.");
    expect(store.loadLatestCheckpointByContextId("ctx-beta")!.summary).toBe("Beta summary.");
    expect(store.loadLatestCheckpointByContextId("ctx-gamma")).toBeNull();
  });

  it("ignores a raw checkpoint that follows a synthesised one (summary preserved)", async () => {
    // This verifies that when a new session writes a raw checkpoint for the same
    // thread before synthesis fires, the previous synthesised checkpoint is still
    // returned for a *different* thread asking by contextId.
    const store = await SqliteSessionStore.create(path.join(tmpDir, "p5g.db"));
    const msgs = [{ role: "user", content: "abc" }];

    // Session A completes with a synthesised checkpoint
    store.saveCheckpoint("session-A", "ctx-shared", 10, "Session A done.", msgs);

    // Session B starts and writes a raw checkpoint (no summary yet)
    store.saveCheckpoint("session-B", "ctx-shared", 2, null, msgs);

    // loadLatestCheckpointByContextId must only return rows with summary IS NOT NULL
    const result = store.loadLatestCheckpointByContextId("ctx-shared");
    expect(result).not.toBeNull();
    expect(result!.threadId).toBe("session-A");
    expect(result!.summary).toBe("Session A done.");
  });

  it("fullState is returned as an empty array when stored JSON is malformed", async () => {
    const store = await SqliteSessionStore.create(path.join(tmpDir, "p5h.db"));

    // Save a valid checkpoint first to create the row
    store.saveCheckpoint("thread-bad", "ctx-bad", 1, "Valid summary.", []);

    // Corrupt the full_state directly via the underlying database
    store["db"].prepare(
      `UPDATE session_checkpoints SET full_state = 'not-json' WHERE thread_id = 'thread-bad'`
    ).run();

    const result = store.loadLatestCheckpointByContextId("ctx-bad");
    expect(result).not.toBeNull();
    expect(result!.fullState).toEqual([]);
    expect(result!.summary).toBe("Valid summary.");
  });
});
