/**
 * Tests for forkSession() in src/session.ts.
 * Uses a temp ORAGER_SESSIONS_DIR so we don't pollute ~/.orager/sessions.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  forkSession,
  saveSession,
  loadSession,
  newSessionId,
  _resetStoreForTesting,
} from "../src/session.js";
import type { SessionData } from "../src/types.js";

// ── Test isolation ─────────────────────────────────────────────────────────────

let testDir: string;
let savedEnv: string | undefined;

beforeEach(async () => {
  savedEnv = process.env["ORAGER_SESSIONS_DIR"];
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), "orager-fork-"));
  testDir = await fs.realpath(raw);
  process.env["ORAGER_SESSIONS_DIR"] = testDir;
  _resetStoreForTesting();
});

afterEach(async () => {
  _resetStoreForTesting();
  if (savedEnv === undefined) delete process.env["ORAGER_SESSIONS_DIR"];
  else process.env["ORAGER_SESSIONS_DIR"] = savedEnv;
  await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
});

// ── Helpers ────────────────────────────────────────────────────────────────────

type Role = "system" | "user" | "assistant" | "tool";

function msg(role: Role, content = ""): SessionData["messages"][number] {
  if (role === "tool") {
    return { role: "tool", tool_call_id: "tc-1", content: content || "tool result" };
  }
  return { role, content: content || `${role} message` } as SessionData["messages"][number];
}

/** Build a minimal session with N completed turns (user+assistant each). */
async function makeSession(turns: number): Promise<SessionData> {
  const sessionId = newSessionId();
  const messages: SessionData["messages"] = [msg("system")];
  for (let i = 0; i < turns; i++) {
    messages.push(msg("user", `user turn ${i + 1}`));
    messages.push(msg("assistant", `assistant turn ${i + 1}`));
  }
  const data: SessionData = {
    sessionId,
    model: "openai/gpt-4o",
    messages,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    turnCount: turns,
    cwd: testDir,
    cumulativeCostUsd: 1.23,
  };
  await saveSession(data);
  return data;
}

// ── Basic fork ─────────────────────────────────────────────────────────────────

describe("forkSession — basic behaviour", () => {
  it("returns a new unique sessionId and the forkedFrom source id", async () => {
    const src = await makeSession(3);
    const result = await forkSession(src.sessionId);
    expect(result.sessionId).not.toBe(src.sessionId);
    expect(result.forkedFrom).toBe(src.sessionId);
  });

  it("saves the forked session so loadSession returns it", async () => {
    const src = await makeSession(2);
    const { sessionId: forkId } = await forkSession(src.sessionId);
    const loaded = await loadSession(forkId);
    expect(loaded).not.toBeNull();
    expect(loaded!.sessionId).toBe(forkId);
  });

  it("forks with full message history when atTurn is not specified", async () => {
    const src = await makeSession(3);
    const { sessionId: forkId } = await forkSession(src.sessionId);
    const loaded = await loadSession(forkId);
    expect(loaded!.messages).toHaveLength(src.messages.length);
    expect(loaded!.turnCount).toBe(src.turnCount);
  });

  it("resets cumulativeCostUsd to 0 on the fork", async () => {
    const src = await makeSession(2);
    const { sessionId: forkId } = await forkSession(src.sessionId);
    const loaded = await loadSession(forkId);
    expect(loaded!.cumulativeCostUsd).toBe(0);
  });

  it("clears pendingApproval on the fork", async () => {
    const src = await makeSession(1);
    // Manually inject a pendingApproval into the source
    const withPending: SessionData = {
      ...src,
      pendingApproval: {
        toolCallId: "tc-1",
        toolName: "bash",
        input: { command: "ls" },
        assistantMessage: { role: "assistant", content: null, tool_calls: [] },
        toolCalls: [],
      },
    };
    await saveSession(withPending);

    const { sessionId: forkId } = await forkSession(src.sessionId);
    const loaded = await loadSession(forkId);
    expect(loaded!.pendingApproval).toBeNull();
  });

  it("preserves model, cwd, source from the original session", async () => {
    const src = await makeSession(2);
    const { sessionId: forkId } = await forkSession(src.sessionId);
    const loaded = await loadSession(forkId);
    expect(loaded!.model).toBe(src.model);
    expect(loaded!.cwd).toBe(src.cwd);
  });

  it("sets fresh createdAt and updatedAt timestamps", async () => {
    const src = await makeSession(1);
    const before = Date.now();
    const { sessionId: forkId } = await forkSession(src.sessionId);
    const after = Date.now();
    const loaded = await loadSession(forkId);
    const created = new Date(loaded!.createdAt).getTime();
    expect(created).toBeGreaterThanOrEqual(before);
    expect(created).toBeLessThanOrEqual(after);
  });

  it("throws when source session does not exist", async () => {
    await expect(forkSession("nonexistent-session-id")).rejects.toThrow(/not found/i);
  });
});

// ── Fork at turn boundary ──────────────────────────────────────────────────────

describe("forkSession — atTurn slicing", () => {
  it("fork at turn 0 keeps only the system message", async () => {
    const src = await makeSession(3);
    const { sessionId: forkId, atTurn } = await forkSession(src.sessionId, { atTurn: 0 });
    const loaded = await loadSession(forkId);
    expect(atTurn).toBe(0);
    // Only system message survives
    expect(loaded!.messages).toHaveLength(1);
    expect(loaded!.messages[0]!.role).toBe("system");
    expect(loaded!.turnCount).toBe(0);
  });

  it("fork at turn 1 keeps system + first user + first assistant", async () => {
    const src = await makeSession(3);
    const { sessionId: forkId, atTurn } = await forkSession(src.sessionId, { atTurn: 1 });
    const loaded = await loadSession(forkId);
    expect(atTurn).toBe(1);
    // system, user-1, assistant-1
    expect(loaded!.messages).toHaveLength(3);
    expect(loaded!.messages[0]!.role).toBe("system");
    expect(loaded!.messages[1]!.role).toBe("user");
    expect(loaded!.messages[2]!.role).toBe("assistant");
    expect(loaded!.turnCount).toBe(1);
  });

  it("fork at turn 2 out of 3 includes first two turns", async () => {
    const src = await makeSession(3);
    const { sessionId: forkId } = await forkSession(src.sessionId, { atTurn: 2 });
    const loaded = await loadSession(forkId);
    // system + 2×(user+assistant) = 5
    expect(loaded!.messages).toHaveLength(5);
    expect(loaded!.turnCount).toBe(2);
  });

  it("fork at turn >= turnCount uses all messages", async () => {
    const src = await makeSession(3);
    const { sessionId: forkId, atTurn } = await forkSession(src.sessionId, { atTurn: 99 });
    const loaded = await loadSession(forkId);
    expect(atTurn).toBe(src.turnCount); // capped at source turnCount
    expect(loaded!.messages).toHaveLength(src.messages.length);
  });

  it("fork at exact turnCount uses all messages", async () => {
    const src = await makeSession(2);
    const { sessionId: forkId } = await forkSession(src.sessionId, { atTurn: 2 });
    const loaded = await loadSession(forkId);
    expect(loaded!.messages).toHaveLength(src.messages.length);
  });

  it("includes tool-result messages attached to the target assistant turn", async () => {
    // Build a session where turn 1 has tool calls and results
    const sessionId = newSessionId();
    const messages: SessionData["messages"] = [
      msg("system"),
      msg("user"),
      { role: "assistant", content: null, tool_calls: [{ id: "tc-1", type: "function", function: { name: "bash", arguments: "{}" } }] },
      msg("tool"),          // tool result for tc-1
      msg("user", "user 2"),
      msg("assistant", "assistant 2"),
    ];
    const data: SessionData = {
      sessionId,
      model: "openai/gpt-4o",
      messages,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      turnCount: 2,
      cwd: testDir,
    };
    await saveSession(data);

    const { sessionId: forkId } = await forkSession(sessionId, { atTurn: 1 });
    const loaded = await loadSession(forkId);
    // system, user, assistant (with tool_calls), tool result = 4 messages
    expect(loaded!.messages).toHaveLength(4);
    expect(loaded!.messages[3]!.role).toBe("tool");
    expect(loaded!.turnCount).toBe(1);
  });
});

// ── Return value ───────────────────────────────────────────────────────────────

describe("forkSession — return value", () => {
  it("returns { sessionId, forkedFrom, atTurn } with correct shape", async () => {
    const src = await makeSession(2);
    const result = await forkSession(src.sessionId, { atTurn: 1 });
    expect(typeof result.sessionId).toBe("string");
    expect(result.sessionId.length).toBeGreaterThan(0);
    expect(result.forkedFrom).toBe(src.sessionId);
    expect(result.atTurn).toBe(1);
  });
});
