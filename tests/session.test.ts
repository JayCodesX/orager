import { describe, it, expect, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { saveSession, loadSession, newSessionId } from "../src/session.js";
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
