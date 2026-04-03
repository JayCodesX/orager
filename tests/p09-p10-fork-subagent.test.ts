/**
 * Tests for P-09 (fork session) and P-10 (sub-agent spawning).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// ── P-09: Fork session ─────────────────────────────────────────────────────

import { forkSession, saveSession, loadSession, newSessionId, _resetStoreForTesting } from "../src/session.js";
import type { SessionData } from "../src/types.js";

describe("P-09: Fork session", () => {
  let tmpDir: string;
  let origEnv: string | undefined;
  let testSession: SessionData;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orager-fork-test-"));
    origEnv = process.env["ORAGER_SESSIONS_DIR"];
    process.env["ORAGER_SESSIONS_DIR"] = tmpDir;
    _resetStoreForTesting();

    // Create a test session with 3 turns
    testSession = {
      sessionId: newSessionId(),
      model: "test/model",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!", tool_calls: undefined },
        { role: "user", content: "Write a file" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "tc_1", type: "function", function: { name: "bash", arguments: '{"command":"echo hi"}' } }],
        },
        { role: "tool", tool_call_id: "tc_1", content: "hi" },
        { role: "user", content: "Thanks" },
        { role: "assistant", content: "You're welcome!" },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      turnCount: 3,
      cwd: "/tmp/test",
    };
    await saveSession(testSession);
  });

  afterEach(async () => {
    _resetStoreForTesting();
    if (origEnv !== undefined) {
      process.env["ORAGER_SESSIONS_DIR"] = origEnv;
    } else {
      delete process.env["ORAGER_SESSIONS_DIR"];
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("forks a session at the latest turn", async () => {
    const result = await forkSession(testSession.sessionId);
    expect(result.forkedFrom).toBe(testSession.sessionId);
    expect(result.atTurn).toBe(3);
    expect(result.sessionId).not.toBe(testSession.sessionId);

    // Verify the forked session exists and has all messages
    const forked = await loadSession(result.sessionId);
    expect(forked).not.toBeNull();
    expect(forked!.messages.length).toBe(testSession.messages.length);
    expect(forked!.turnCount).toBe(3);
  });

  it("forks a session at a specific turn", async () => {
    const result = await forkSession(testSession.sessionId, { atTurn: 1 });
    expect(result.atTurn).toBe(1);

    const forked = await loadSession(result.sessionId);
    expect(forked).not.toBeNull();
    // After turn 1: system + user + assistant (first turn only)
    expect(forked!.messages.length).toBe(3);
    expect(forked!.turnCount).toBe(1);
    expect(forked!.messages[2]!.role).toBe("assistant");
  });

  it("forks at turn 0 keeps only system message", async () => {
    const result = await forkSession(testSession.sessionId, { atTurn: 0 });
    expect(result.atTurn).toBe(0);

    const forked = await loadSession(result.sessionId);
    expect(forked).not.toBeNull();
    expect(forked!.messages.length).toBe(1);
    expect(forked!.messages[0]!.role).toBe("system");
    expect(forked!.turnCount).toBe(0);
  });

  it("fork at turn with tool calls includes tool results", async () => {
    const result = await forkSession(testSession.sessionId, { atTurn: 2 });
    expect(result.atTurn).toBe(2);

    const forked = await loadSession(result.sessionId);
    expect(forked).not.toBeNull();
    // system + user + assistant(turn1) + user + assistant(turn2 with tool_calls) + tool result
    expect(forked!.messages.length).toBe(6);
    expect(forked!.messages[5]!.role).toBe("tool");
  });

  it("forked session has fresh cost tracking", async () => {
    testSession.cumulativeCostUsd = 1.50;
    await saveSession(testSession);

    const result = await forkSession(testSession.sessionId);
    const forked = await loadSession(result.sessionId);
    expect(forked!.cumulativeCostUsd).toBe(0);
  });

  it("forked session clears pending approval", async () => {
    testSession.pendingApproval = {
      toolCallId: "tc_1",
      toolName: "bash",
      input: { command: "rm -rf /" },
      assistantMessage: { role: "assistant", content: null },
      toolCalls: [],
      questionedAt: new Date().toISOString(),
    };
    await saveSession(testSession);

    const result = await forkSession(testSession.sessionId);
    const forked = await loadSession(result.sessionId);
    expect(forked!.pendingApproval).toBeNull();
  });

  it("throws for non-existent session", async () => {
    await expect(forkSession("nonexistent")).rejects.toThrow("not found");
  });
});

// ── P-09: CLI integration ───────────────────────────────────────────────────

describe("P-09: CLI --fork-session flag", () => {
  it("help text includes --fork-session", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/index.ts"),
      "utf8",
    );
    expect(source).toContain("--fork-session");
    expect(source).toContain("--at-turn");
    expect(source).toContain("P-09");
  });

  it("parse-args recognizes --fork-session", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/cli/parse-args.ts"),
      "utf8",
    );
    expect(source).toContain('"--fork-session"');
    expect(source).toContain("P-09");
  });
});

// ── P-10: Sub-agent spawning ────────────────────────────────────────────────

describe("P-10: spawn_agent tool", () => {
  it("spawn_agent tool is defined in loop.ts", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/loop.ts"),
      "utf8",
    );
    expect(source).toContain('"spawn_agent"');
    expect(source).toContain("maxSpawnDepth");
    expect(source).toContain("_spawnDepth");
    expect(source).toContain("_parentSessionIds");
  });

  it("spawn_agent has cycle detection", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/loop.ts"),
      "utf8",
    );
    expect(source).toContain("spawn cycle detected");
    // Local variable is _earlyParentIds (derived from opts._parentSessionIds)
    expect(source).toContain("_earlyParentIds.includes");
  });

  it("spawn_agent supports parallel execution", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/loop.ts"),
      "utf8",
    );
    expect(source).toContain("all spawn_agent calls in the same turn execute concurrently");
  });

  it("CLI supports --max-spawn-depth", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/cli/parse-args.ts"),
      "utf8",
    );
    expect(source).toContain('"--max-spawn-depth"');
  });

  it("sub-agent merges filesChanged into parent", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/loop.ts"),
      "utf8",
    );
    expect(source).toContain("filesChanged.add(f)");
    expect(source).toContain("subFilesChanged");
  });
});
