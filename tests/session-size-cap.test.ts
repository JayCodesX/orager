/**
 * P2-1: Session disk growth cap tests.
 *
 * Verifies that saveSession trims large sessions and that
 * ORAGER_SESSION_MAX_SIZE_BYTES overrides the default.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

// ── Helpers ───────────────────────────────────────────────────────────────────

const TEST_SESSIONS_DIR = path.join(os.tmpdir(), `orager-test-size-${process.pid}`);

let savedDbPath: string | undefined;

beforeEach(async () => {
  await fs.mkdir(TEST_SESSIONS_DIR, { recursive: true, mode: 0o700 });
  process.env["ORAGER_SESSIONS_DIR"] = TEST_SESSIONS_DIR;
  // Force file-based store: size-cap logic lives in _fileSave, not the SQLite store.
  // Under bun vi.resetModules() is a no-op, so explicitly reset the store singleton.
  savedDbPath = process.env["ORAGER_DB_PATH"];
  process.env["ORAGER_DB_PATH"] = "none";
  vi.resetModules();
  const { _resetStoreForTesting } = await import("../src/session.js");
  _resetStoreForTesting();
});

afterEach(async () => {
  delete process.env["ORAGER_SESSIONS_DIR"];
  delete process.env["ORAGER_SESSION_MAX_SIZE_BYTES"];
  if (savedDbPath === undefined) delete process.env["ORAGER_DB_PATH"];
  else process.env["ORAGER_DB_PATH"] = savedDbPath;
  await fs.rm(TEST_SESSIONS_DIR, { recursive: true, force: true });
  vi.resetModules();
  const { _resetStoreForTesting } = await import("../src/session.js");
  _resetStoreForTesting();
});

function makeSessionId(): string {
  return `test-${Math.random().toString(36).slice(2, 10)}`;
}

// Build a SessionData with N user+assistant message pairs
function buildSession(sessionId: string, pairCount: number, msgSizeChars = 100) {
  const messages: Array<{ role: string; content?: string; tool_calls?: undefined }> = [
    { role: "system", content: "You are a helpful assistant." },
  ];
  const content = "x".repeat(msgSizeChars);
  for (let i = 0; i < pairCount; i++) {
    messages.push({ role: "user", content });
    messages.push({ role: "assistant", content, tool_calls: undefined });
  }
  return {
    sessionId,
    model: "test-model",
    messages,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    turnCount: pairCount,
    cwd: "/tmp/test",
    schemaVersion: 1 as const,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("P2-1: session size cap", () => {
  it("session under limit: saved as-is", async () => {
    const { saveSession, loadSession, SESSION_MAX_SIZE_BYTES } = await import("../src/session.js");

    const sessionId = makeSessionId();
    const data = buildSession(sessionId, 2, 50);

    // Verify it's under the limit
    const serialized = JSON.stringify(data);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThan(SESSION_MAX_SIZE_BYTES);

    await saveSession(data as Parameters<typeof saveSession>[0]);
    const loaded = await loadSession(sessionId);

    expect(loaded).not.toBeNull();
    // All messages preserved (system + 2 pairs = 5)
    expect(loaded!.messages).toHaveLength(data.messages.length);
  });

  it("session over limit: oldest messages trimmed, saved successfully", async () => {
    // Set a tiny limit so we can test trimming without massive data
    process.env["ORAGER_SESSION_MAX_SIZE_BYTES"] = "2000";
    vi.resetModules();

    const { saveSession, loadSession, _refreshSessionMaxSize } = await import("../src/session.js");
    _refreshSessionMaxSize?.();

    const sessionId = makeSessionId();
    // Each pair is ~200+ bytes; 20 pairs is well over 2000 bytes when JSON-encoded
    const data = buildSession(sessionId, 20, 50);

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await saveSession(data as Parameters<typeof saveSession>[0]);

    stderrSpy.mockRestore();

    const loaded = await loadSession(sessionId);
    expect(loaded).not.toBeNull();

    // Should have fewer messages than the original
    expect(loaded!.messages.length).toBeLessThan(data.messages.length);
    // System message must be preserved if present
    expect(loaded!.messages[0]!.role).toBe("system");
  });

  it("size limit is respected after trimming", async () => {
    const limitBytes = 3000;
    process.env["ORAGER_SESSION_MAX_SIZE_BYTES"] = String(limitBytes);
    vi.resetModules();

    const { saveSession, _refreshSessionMaxSize } = await import("../src/session.js");
    _refreshSessionMaxSize?.();

    const sessionId = makeSessionId();
    const data = buildSession(sessionId, 30, 50);

    await saveSession(data as Parameters<typeof saveSession>[0]);

    // Read file on disk and check its size
    const filePath = path.join(TEST_SESSIONS_DIR, `${sessionId}.json`);
    const rawBytes = await fs.readFile(filePath);
    expect(rawBytes.byteLength).toBeLessThanOrEqual(limitBytes * 1.1); // 10% tolerance for JSON overhead
  });

  it("ORAGER_SESSION_MAX_SIZE_BYTES env var overrides default", async () => {
    process.env["ORAGER_SESSION_MAX_SIZE_BYTES"] = "1500";
    vi.resetModules();

    const mod = await import("../src/session.js");
    mod._refreshSessionMaxSize?.();
    expect(mod.SESSION_MAX_SIZE_BYTES).toBe(1500);
  });
});
