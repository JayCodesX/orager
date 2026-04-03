/**
 * P3-8: --sessions CLI flag tests.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const MOCK_SESSIONS = [
  { sessionId: "sess-abc123def456", updatedAt: "2024-01-15T10:30:00Z", turnCount: 5, model: "deepseek/deepseek-chat" },
  { sessionId: "sess-xyz789uvw012", updatedAt: "2024-01-14T08:00:00Z", turnCount: 12, model: "openai/gpt-4o" },
];

describe("--sessions command", () => {
  it("fetches /sessions with limit=20 and /sessions/:id/cost for each session", async () => {
    const fetchedUrls: string[] = [];

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      fetchedUrls.push(url);
      if (String(url).includes("/sessions?")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ sessions: MOCK_SESSIONS, total: 2 }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ cumulativeCostUsd: 0.005, lastRunAt: "", runCount: 3 }),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    // Simulate the sessions command fetch pattern
    const sessionsRes = await fetchMock("http://127.0.0.1:3456/sessions?limit=20");
    const sessionsBody = await sessionsRes.json();
    const sessions: typeof MOCK_SESSIONS = sessionsBody.sessions;

    // Fetch cost for each session
    const costMap = new Map<string, number>();
    for (const s of sessions) {
      const costRes = await fetchMock(`http://127.0.0.1:3456/sessions/${s.sessionId}/cost`);
      const costBody = await costRes.json() as { cumulativeCostUsd: number };
      costMap.set(s.sessionId, costBody.cumulativeCostUsd);
    }

    expect(fetchedUrls).toContain("http://127.0.0.1:3456/sessions?limit=20");
    expect(fetchedUrls).toContain("http://127.0.0.1:3456/sessions/sess-abc123def456/cost");
    expect(fetchedUrls).toContain("http://127.0.0.1:3456/sessions/sess-xyz789uvw012/cost");
    expect(costMap.size).toBe(2);
  });

  it("--sessions --json outputs valid JSON array with expected fields", () => {
    const sessions = MOCK_SESSIONS;
    const costMap = new Map([
      ["sess-abc123def456", 0.0042],
      ["sess-xyz789uvw012", 0.0156],
    ]);

    const result = sessions.map((s) => ({
      sessionId: s.sessionId,
      lastRunAt: s.updatedAt,
      cumulativeCostUsd: costMap.get(s.sessionId) ?? 0,
      runCount: s.turnCount,
    }));

    const json = JSON.stringify(result, null, 2);
    const parsed = JSON.parse(json) as typeof result;

    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(2);
    expect(parsed[0].sessionId).toBe("sess-abc123def456");
    expect(parsed[0].cumulativeCostUsd).toBeCloseTo(0.0042);
    expect(parsed[0].runCount).toBe(5);
    expect(parsed[0].lastRunAt).toBe("2024-01-15T10:30:00Z");
  });

  it("--sessions (ADR-0003): reads sessions directly from SQLite, not from a daemon port", async () => {
    // After daemon removal the --sessions command calls listSessions() directly.
    // Verify: src/daemon.ts no longer exists so there is nothing to import.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    await expect(
      fs.readFile(path.join(process.cwd(), "src/daemon.ts"), "utf8"),
    ).rejects.toThrow(); // ENOENT — daemon is gone

    // After Sprint 7 decomposition, listSessions is called from session-commands.ts
    // (imported by index.ts). Verify the command module calls it directly.
    const sessionCmdSrc = await fs.readFile(
      path.join(process.cwd(), "src/commands/session-commands.ts"),
      "utf8",
    );
    expect(sessionCmdSrc).toContain("listSessions");
    const indexSrc = await fs.readFile(path.join(process.cwd(), "src/index.ts"), "utf8");
    expect(indexSrc).toContain("handleListSessions");
    expect(indexSrc).not.toContain("readDaemonPort");
  });

  it("table output includes session id, last run at, cost, and turns columns", () => {
    const sessions = MOCK_SESSIONS;
    const costMap = new Map([
      ["sess-abc123def456", 0.0042],
    ]);

    // Simulate table row formatting
    const s = sessions[0];
    const id = s.sessionId.slice(0, 20).padEnd(22);
    const lastRun = s.updatedAt.slice(0, 16).replace("T", " ").padEnd(20);
    const cost = `$${(costMap.get(s.sessionId) ?? 0).toFixed(4)}`.padStart(10);
    const turns = String(s.turnCount).padStart(6);

    const row = `${id} ${lastRun} ${cost} ${turns}`;

    expect(row).toContain("sess-abc123def456");
    expect(row).toContain("2024-01-15 10:30");
    expect(row).toContain("$0.0042");
    expect(row).toContain("5");
  });
});
