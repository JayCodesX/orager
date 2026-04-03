/**
 * Tests for operational quality improvements:
 *   1. logToolCall() — structured audit log entry for every tool execution
 *   2. _filePrune — compacted (summarized) sessions get 3× retention
 *   3. SQLite prune — compacted sessions use 3× cutoff
 *   4. vitest.config.ts testTimeout set (verified at config level)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// ── Shared isolation ───────────────────────────────────────────────────────────

let tmpDir: string;
let savedSessionsDir: string | undefined;
let savedAuditLog: string | undefined;

beforeEach(async () => {
  savedSessionsDir = process.env["ORAGER_SESSIONS_DIR"];
  savedAuditLog = process.env["ORAGER_AUDIT_LOG"];
  const raw = await fsPromises.mkdtemp(path.join(os.tmpdir(), "orager-opq-"));
  tmpDir = await fsPromises.realpath(raw);
  process.env["ORAGER_SESSIONS_DIR"] = tmpDir;
  process.env["ORAGER_AUDIT_LOG"] = path.join(tmpDir, "audit.log");
  vi.resetModules();
  // Under bun, vi.resetModules() is a no-op. Reset the audit stream
  // singleton so it picks up the new ORAGER_AUDIT_LOG path.
  const { _resetStreamForTesting } = await import("../src/audit.js");
  _resetStreamForTesting?.();
});

afterEach(async () => {
  if (savedSessionsDir === undefined) delete process.env["ORAGER_SESSIONS_DIR"];
  else process.env["ORAGER_SESSIONS_DIR"] = savedSessionsDir;
  if (savedAuditLog === undefined) delete process.env["ORAGER_AUDIT_LOG"];
  else process.env["ORAGER_AUDIT_LOG"] = savedAuditLog;
  await fsPromises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  vi.resetModules();
});

// ── 1. logToolCall ─────────────────────────────────────────────────────────────

describe("logToolCall", () => {
  it("writes a valid NDJSON line with event: tool_call", async () => {
    const { logToolCall } = await import("../src/audit.js");
    const auditPath = process.env["ORAGER_AUDIT_LOG"]!;

    logToolCall({
      event: "tool_call",
      ts: "2026-03-30T10:00:00.000Z",
      sessionId: "sess-abc",
      toolName: "bash",
      inputSummary: { command: "echo hello" },
      isError: false,
      durationMs: 42,
      resultSummary: "hello",
    });

    await new Promise((r) => setTimeout(r, 60));

    const contents = fs.readFileSync(auditPath, "utf8");
    const line = JSON.parse(contents.trim());

    expect(line.event).toBe("tool_call");
    expect(line.sessionId).toBe("sess-abc");
    expect(line.toolName).toBe("bash");
    expect(line.isError).toBe(false);
    expect(line.durationMs).toBe(42);
    expect(line.resultSummary).toBe("hello");
    expect(line.inputSummary.command).toBe("echo hello");
  });

  it("truncates long input values to 500 chars in the log", async () => {
    const { logToolCall } = await import("../src/audit.js");
    const auditPath = process.env["ORAGER_AUDIT_LOG"]!;
    const longVal = "x".repeat(1000);

    logToolCall({
      event: "tool_call",
      ts: new Date().toISOString(),
      sessionId: "sess-trunc",
      toolName: "write_file",
      inputSummary: { content: longVal },
      isError: false,
      durationMs: 10,
    });

    await new Promise((r) => setTimeout(r, 60));

    const contents = fs.readFileSync(auditPath, "utf8");
    const line = JSON.parse(contents.trim());
    expect(typeof line.inputSummary.content).toBe("string");
    expect(line.inputSummary.content.length).toBeLessThanOrEqual(530); // 500 + "…(500 more chars)" label
    expect(line.inputSummary.content).toContain("more chars");
  });

  it("records isError: true for failed tool calls", async () => {
    const { logToolCall } = await import("../src/audit.js");
    const auditPath = process.env["ORAGER_AUDIT_LOG"]!;

    logToolCall({
      event: "tool_call",
      ts: new Date().toISOString(),
      sessionId: "sess-err",
      toolName: "bash",
      inputSummary: { command: "cat /nonexistent" },
      isError: true,
      durationMs: 5,
      resultSummary: "error: No such file",
    });

    await new Promise((r) => setTimeout(r, 60));

    const line = JSON.parse(fs.readFileSync(auditPath, "utf8").trim());
    expect(line.event).toBe("tool_call");
    expect(line.isError).toBe(true);
    expect(line.resultSummary).toContain("No such file");
  });

  it("multiple tool_call entries are each on their own line (NDJSON)", async () => {
    const { logToolCall } = await import("../src/audit.js");
    const auditPath = process.env["ORAGER_AUDIT_LOG"]!;

    for (let i = 0; i < 3; i++) {
      logToolCall({
        event: "tool_call",
        ts: new Date().toISOString(),
        sessionId: "sess-multi",
        toolName: `tool-${i}`,
        inputSummary: { i },
        isError: false,
        durationMs: i * 10,
      });
    }

    await new Promise((r) => setTimeout(r, 80));

    const lines = fs.readFileSync(auditPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    const names = lines.map((l) => JSON.parse(l).toolName);
    expect(names).toEqual(["tool-0", "tool-1", "tool-2"]);
  });
});

// ── 2. File-based prune: compacted sessions get 3× retention ──────────────────

describe("_filePrune: compacted sessions use 3× retention", () => {
  // Force file-based session store so pruneOldSessions() scans the JSON files
  // written by writeSession() above. Under bun, vi.resetModules() is a no-op,
  // so we must manually reset the store singleton and set ORAGER_DB_PATH=none.
  let savedDbPath: string | undefined;
  beforeEach(() => {
    savedDbPath = process.env["ORAGER_DB_PATH"];
    process.env["ORAGER_DB_PATH"] = "none";
    // Lazy import — _resetStoreForTesting must be called after env is set
    return import("../src/session.js").then(({ _resetStoreForTesting }) => _resetStoreForTesting());
  });
  afterEach(() => {
    if (savedDbPath === undefined) delete process.env["ORAGER_DB_PATH"];
    else process.env["ORAGER_DB_PATH"] = savedDbPath;
    return import("../src/session.js").then(({ _resetStoreForTesting }) => _resetStoreForTesting());
  });
  async function writeSession(
    sessionId: string,
    summarized: boolean,
    mtimeOffsetMs: number,
  ): Promise<string> {
    const dir = process.env["ORAGER_SESSIONS_DIR"]!;
    await fsPromises.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${sessionId}.json`);
    const data = {
      sessionId,
      model: "test",
      messages: [],
      createdAt: new Date(Date.now() - mtimeOffsetMs).toISOString(),
      updatedAt: new Date(Date.now() - mtimeOffsetMs).toISOString(),
      turnCount: 1,
      cwd: "/tmp",
      summarized,
    };
    await fsPromises.writeFile(filePath, JSON.stringify(data));
    // Back-date mtime to simulate age
    const oldTime = new Date(Date.now() - mtimeOffsetMs);
    await fsPromises.utimes(filePath, oldTime, oldTime);
    return filePath;
  }

  it("deletes a regular session older than the TTL but keeps a compacted one of the same age", async () => {
    const TTL = 30 * 24 * 60 * 60 * 1000; // 30 days
    // Both sessions are 35 days old — older than normal TTL but within compacted TTL (90 days)
    const age35days = 35 * 24 * 60 * 60 * 1000;

    await writeSession("regular-old", false, age35days);
    await writeSession("compacted-old", true, age35days);

    const { pruneOldSessions } = await import("../src/session.js");
    const result = await pruneOldSessions(TTL);

    expect(result.deleted).toBe(1);
    expect(result.kept).toBe(1);

    // Regular session should be gone
    const regularPath = path.join(tmpDir, "regular-old.json");
    await expect(fsPromises.access(regularPath)).rejects.toThrow();

    // Compacted session should still exist
    const compactedPath = path.join(tmpDir, "compacted-old.json");
    // fsPromises.access resolves with undefined (node) or null (bun)
    await fsPromises.access(compactedPath); // throws if file doesn't exist
  });

  it("deletes a compacted session older than 3× the TTL", async () => {
    const TTL = 30 * 24 * 60 * 60 * 1000; // 30 days
    // 95 days old — beyond 3× TTL (90 days)
    const age95days = 95 * 24 * 60 * 60 * 1000;

    await writeSession("compacted-very-old", true, age95days);

    const { pruneOldSessions } = await import("../src/session.js");
    const result = await pruneOldSessions(TTL);

    expect(result.deleted).toBe(1);
    const filePath = path.join(tmpDir, "compacted-very-old.json");
    await expect(fsPromises.access(filePath)).rejects.toThrow();
  });

  it("keeps both regular and compacted sessions that are within their TTL", async () => {
    const TTL = 30 * 24 * 60 * 60 * 1000; // 30 days
    // 10 days old — within both TTLs
    const age10days = 10 * 24 * 60 * 60 * 1000;

    await writeSession("regular-fresh", false, age10days);
    await writeSession("compacted-fresh", true, age10days);

    const { pruneOldSessions } = await import("../src/session.js");
    const result = await pruneOldSessions(TTL);

    expect(result.deleted).toBe(0);
    expect(result.kept).toBe(2);
  });
});

// ── 3. SQLite prune: compacted sessions use 3× retention ──────────────────────

describe("SQLite prune: compacted sessions use 3× retention", () => {
  it("respects 3× retention for summarized sessions", async () => {
    // Import SessionSqliteStore directly to test its prune() method
    const { SqliteSessionStore } = await import("../src/session-sqlite.js");
    const dbPath = path.join(tmpDir, "test.db");
    const store = await SqliteSessionStore.create(dbPath);

    const TTL = 30 * 24 * 60 * 60 * 1000; // 30 days in ms

    // Helper: create a session with a back-dated updated_at
    function makeSession(id: string, summarized: boolean, daysOld: number) {
      const updatedAt = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000).toISOString();
      return store.save({
        sessionId: id,
        model: "test",
        messages: [],
        createdAt: updatedAt,
        updatedAt,
        turnCount: 1,
        cwd: "/tmp",
        summarized,
      });
    }

    await makeSession("regular-35d", false, 35);   // 35 days > 30d TTL — should be pruned
    await makeSession("compacted-35d", true, 35);  // 35 days < 90d compacted TTL — should be kept
    await makeSession("regular-10d", false, 10);   // 10 days < 30d TTL — should be kept
    await makeSession("compacted-95d", true, 95);  // 95 days > 90d compacted TTL — should be pruned

    const result = await store.prune(TTL);

    expect(result.deleted).toBe(2); // regular-35d + compacted-95d
    expect(result.kept).toBe(2);    // compacted-35d + regular-10d
  });
});

// ── 4. bun test preload configured ───────────────────────────────────────────

describe("bunfig.toml has test preload configured", () => {
  it("preload includes bun-setup.ts for test isolation", async () => {
    const configPath = path.resolve(process.cwd(), "bunfig.toml");
    const contents = fs.readFileSync(configPath, "utf8");
    // bunfig.toml must have a [test] section with preload pointing to bun-setup
    expect(contents).toContain("[test]");
    expect(contents).toMatch(/preload\s*=.*bun-setup/);
  });
});
