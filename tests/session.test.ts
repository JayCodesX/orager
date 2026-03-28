import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import {
  saveSession,
  loadSession,
  newSessionId,
  acquireSessionLock,
  getSessionsDir,
  pruneOldSessions,
} from "../src/session.js";
import type { SessionData } from "../src/types.js";

// We let the real saveSession/loadSession write to ~/.orager/sessions/
// but use a unique session ID per test so runs don't collide, then clean up.

const createdIds: string[] = [];

async function cleanupSession(sessionId: string): Promise<void> {
  const sessionsDir = path.join(os.homedir(), ".orager", "sessions");
  try {
    await fs.unlink(path.join(sessionsDir, `${sessionId}.json`));
  } catch {
    // ignore if already gone
  }
}

afterEach(async () => {
  for (const id of createdIds) {
    await cleanupSession(id);
  }
  createdIds.length = 0;
});

describe("session persistence", () => {
  it("saveSession + loadSession round-trip", async () => {
    const sessionId = `test-${newSessionId()}`;
    createdIds.push(sessionId);

    const data: SessionData = {
      sessionId,
      model: "deepseek/deepseek-chat-v3-2",
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!", tool_calls: undefined },
      ],
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:01:00.000Z",
      turnCount: 1,
      cwd: "/tmp/test",
    };

    await saveSession(data);
    const loaded = await loadSession(sessionId);

    expect(loaded).not.toBeNull();
    expect(loaded!.sessionId).toBe(sessionId);
    expect(loaded!.model).toBe("deepseek/deepseek-chat-v3-2");
    expect(loaded!.messages).toHaveLength(2);
    expect(loaded!.messages[0]).toEqual({ role: "user", content: "Hello" });
    expect(loaded!.createdAt).toBe("2024-01-01T00:00:00.000Z");
    expect(loaded!.updatedAt).toBe("2024-01-01T00:01:00.000Z");
    expect(loaded!.turnCount).toBe(1);
    expect(loaded!.cwd).toBe("/tmp/test");
  });

  it("loadSession returns null for unknown session ID", async () => {
    const result = await loadSession("this-session-does-not-exist-12345");
    expect(result).toBeNull();
  });

  it("saved session file has restricted 0o600 permissions", async () => {
    const sessionId = `test-${newSessionId()}`;
    createdIds.push(sessionId);

    const data: SessionData = {
      sessionId,
      model: "deepseek/deepseek-chat-v3-2",
      messages: [],
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      turnCount: 0,
      cwd: "/tmp",
    };

    await saveSession(data);

    const sessionsDir = path.join(os.homedir(), ".orager", "sessions");
    const stat = await fs.stat(path.join(sessionsDir, `${sessionId}.json`));
    // 0o600 = owner read+write only
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("newSessionId returns a non-empty UUID-like string containing hyphens", () => {
    const id = newSessionId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
    expect(id).toContain("-");
    // UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

// ── Path traversal rejection ──────────────────────────────────────────────────

describe("session path traversal prevention", () => {
  const traversalIds = [
    "../evil",
    "../../etc/passwd",
    "/absolute/path",
    "a/b",
    "has space",
    "has\nnewline",
    "x".repeat(257), // over 256-char limit
    "",
  ];

  for (const badId of traversalIds) {
    it(`rejects sessionId "${badId.slice(0, 30).replace(/\n/, "\\n")}"`, async () => {
      await expect(loadSession(badId)).rejects.toThrow(/invalid sessionid/i);
    });
  }

  it("accepts a valid UUID session ID", async () => {
    // A normal UUID from newSessionId() must not throw
    const id = newSessionId();
    await expect(loadSession(id)).resolves.toBeNull(); // null = not found, but no error
  });

  it("accepts alphanumeric IDs with hyphens and underscores", async () => {
    await expect(loadSession("my-session_01")).resolves.toBeNull();
  });
});

// ── acquireSessionLock path traversal rejection ───────────────────────────────

describe("acquireSessionLock path traversal prevention", () => {
  const badIds = [
    "../evil",
    "../../etc/passwd",
    "/absolute/path",
    "a/b",
    "has space",
    "has\nnewline",
    "x".repeat(257),
    "",
  ];

  for (const badId of badIds) {
    it(`rejects acquireSessionLock for "${badId.slice(0, 30).replace(/\n/, "\\n")}"`, async () => {
      await expect(acquireSessionLock(badId)).rejects.toThrow(/invalid sessionid/i);
    });
  }

  it("accepts a valid UUID in acquireSessionLock and returns a release function", async () => {
    const id = newSessionId();
    // acquireSessionLock should resolve (not throw) for a valid ID
    const release = await acquireSessionLock(id);
    expect(typeof release).toBe("function");
    // Release the lock to clean up
    await release();
  });
});

// ── getSessionsDir() default and env override ─────────────────────────────────

describe("getSessionsDir()", () => {
  it("returns default path when ORAGER_SESSIONS_DIR is not set", () => {
    const saved = process.env["ORAGER_SESSIONS_DIR"];
    delete process.env["ORAGER_SESSIONS_DIR"];
    try {
      expect(getSessionsDir()).toBe(path.join(os.homedir(), ".orager", "sessions"));
    } finally {
      if (saved !== undefined) process.env["ORAGER_SESSIONS_DIR"] = saved;
    }
  });

  it("returns env var path when ORAGER_SESSIONS_DIR is set", () => {
    const saved = process.env["ORAGER_SESSIONS_DIR"];
    process.env["ORAGER_SESSIONS_DIR"] = "/tmp/custom-sessions-dir";
    try {
      expect(getSessionsDir()).toBe("/tmp/custom-sessions-dir");
    } finally {
      if (saved === undefined) delete process.env["ORAGER_SESSIONS_DIR"];
      else process.env["ORAGER_SESSIONS_DIR"] = saved;
    }
  });
});

// ── ORAGER_SESSIONS_DIR integration — save/load in a custom directory ─────────

describe("ORAGER_SESSIONS_DIR env override — file I/O", () => {
  let customDir: string;
  let savedDir: string | undefined;

  beforeEach(async () => {
    savedDir = process.env["ORAGER_SESSIONS_DIR"];
    const raw = await fs.mkdtemp(path.join(os.tmpdir(), "orager-sessdir-"));
    customDir = await fs.realpath(raw);
    process.env["ORAGER_SESSIONS_DIR"] = customDir;
  });

  afterEach(async () => {
    if (savedDir === undefined) delete process.env["ORAGER_SESSIONS_DIR"];
    else process.env["ORAGER_SESSIONS_DIR"] = savedDir;
    await fs.rm(customDir, { recursive: true, force: true }).catch(() => {});
  });

  it("saves session file to the custom directory", async () => {
    const sessionId = `env-test-${newSessionId()}`;
    const data: SessionData = {
      sessionId,
      model: "openai/gpt-4o",
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      turnCount: 0,
      cwd: customDir,
    };
    await saveSession(data);

    const expectedFile = path.join(customDir, `${sessionId}.json`);
    const stat = await fs.stat(expectedFile);
    expect(stat.isFile()).toBe(true);
  });

  it("loads session back from the custom directory", async () => {
    const sessionId = `env-test-${newSessionId()}`;
    const data: SessionData = {
      sessionId,
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      turnCount: 1,
      cwd: customDir,
    };
    await saveSession(data);
    const loaded = await loadSession(sessionId);
    expect(loaded?.sessionId).toBe(sessionId);
    expect(loaded?.model).toBe("openai/gpt-4o");
  });

  it("does not write session to the default ~/.orager/sessions directory", async () => {
    const sessionId = `env-test-${newSessionId()}`;
    await saveSession({
      sessionId,
      model: "openai/gpt-4o",
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      turnCount: 0,
      cwd: customDir,
    });

    const defaultFile = path.join(os.homedir(), ".orager", "sessions", `${sessionId}.json`);
    const inDefault = await fs.stat(defaultFile).then(() => true).catch(() => false);
    expect(inDefault).toBe(false);
  });
});

// ── Session pruning ───────────────────────────────────────────────────────────

describe("pruneOldSessions", () => {
  let pruneDir: string;
  let savedDir: string | undefined;

  beforeEach(async () => {
    savedDir = process.env["ORAGER_SESSIONS_DIR"];
    const raw = await fs.mkdtemp(path.join(os.tmpdir(), "orager-prune-"));
    pruneDir = await fs.realpath(raw);
    process.env["ORAGER_SESSIONS_DIR"] = pruneDir;
  });

  afterEach(async () => {
    if (savedDir === undefined) delete process.env["ORAGER_SESSIONS_DIR"];
    else process.env["ORAGER_SESSIONS_DIR"] = savedDir;
    await fs.rm(pruneDir, { recursive: true, force: true }).catch(() => {});
  });

  it("deletes session files older than the cutoff and reports correct counts", async () => {
    const oldId = `prune-old-${newSessionId()}`;
    const newId = `prune-new-${newSessionId()}`;

    for (const sessionId of [oldId, newId]) {
      await saveSession({
        sessionId,
        model: "openai/gpt-4o",
        messages: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        turnCount: 0,
        cwd: pruneDir,
      });
    }

    // Back-date the old session's file mtime to 2 hours ago
    const oldFile = path.join(pruneDir, `${oldId}.json`);
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.utimes(oldFile, twoHoursAgo, twoHoursAgo);

    // Prune sessions older than 1 hour
    const result = await pruneOldSessions(60 * 60 * 1000);

    expect(result.deleted).toBe(1);
    expect(result.kept).toBe(1);
    expect(result.errors).toBe(0);

    // Old session is gone, new session survives
    expect(await loadSession(oldId)).toBeNull();
    expect(await loadSession(newId)).not.toBeNull();
  });

  it("returns zero counts when directory is empty", async () => {
    const result = await pruneOldSessions(1000);
    expect(result).toEqual({ deleted: 0, kept: 0, errors: 0 });
  });

  it("keeps sessions newer than the cutoff", async () => {
    const sessionId = `prune-keep-${newSessionId()}`;
    await saveSession({
      sessionId,
      model: "openai/gpt-4o",
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      turnCount: 0,
      cwd: pruneDir,
    });

    // Prune with a very long cutoff — newly created session should survive
    const result = await pruneOldSessions(24 * 60 * 60 * 1000); // 24 hours
    expect(result.kept).toBeGreaterThanOrEqual(1);
    expect(await loadSession(sessionId)).not.toBeNull();
  });
});

// ── Stale lock detection ──────────────────────────────────────────────────────

describe("stale lock detection", () => {
  let lockDir: string;
  let savedDir: string | undefined;

  beforeEach(async () => {
    savedDir = process.env["ORAGER_SESSIONS_DIR"];
    const raw = await fs.mkdtemp(path.join(os.tmpdir(), "orager-stalelock-"));
    lockDir = await fs.realpath(raw);
    process.env["ORAGER_SESSIONS_DIR"] = lockDir;
    // Pre-create the custom directory so lock operations can find it
    await fs.mkdir(lockDir, { recursive: true });
  });

  afterEach(async () => {
    if (savedDir === undefined) delete process.env["ORAGER_SESSIONS_DIR"];
    else process.env["ORAGER_SESSIONS_DIR"] = savedDir;
    await fs.rm(lockDir, { recursive: true, force: true }).catch(() => {});
  });

  it("acquires lock when existing lock is stale (older than 5 minutes)", async () => {
    const sessionId = `stale-${newSessionId()}`;
    const lockFile = path.join(lockDir, `${sessionId}.run.lock`);

    // Write a lock with a timestamp 6 minutes ago (older than default 5-min threshold)
    const staleAt = Date.now() - 6 * 60 * 1000;
    await fs.writeFile(lockFile, JSON.stringify({ pid: 99999, at: staleAt, host: "old-host" }), "utf8");

    // Should succeed — the stale lock is overwritten
    const release = await acquireSessionLock(sessionId);
    expect(typeof release).toBe("function");

    // New lock content should have the current pid
    const content = JSON.parse(await fs.readFile(lockFile, "utf8")) as { pid: number; at: number };
    expect(content.pid).toBe(process.pid);
    expect(content.at).toBeGreaterThan(staleAt);

    await release();
    // Lock file removed after release
    await expect(fs.stat(lockFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects concurrent acquisition when lock is fresh (less than 5 minutes old)", async () => {
    const sessionId = `fresh-${newSessionId()}`;
    const lockFile = path.join(lockDir, `${sessionId}.run.lock`);

    // Write a lock with a timestamp 10 seconds ago — well within the 5-min window
    const freshAt = Date.now() - 10 * 1000;
    await fs.writeFile(lockFile, JSON.stringify({ pid: 12345, at: freshAt, host: "other-host" }), "utf8");

    await expect(acquireSessionLock(sessionId)).rejects.toThrow(/already being resumed/i);
  });
});
