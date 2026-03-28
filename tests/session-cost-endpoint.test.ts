/**
 * P1-2: Session lifetime cost visibility — /sessions/:sessionId/cost endpoint tests.
 *
 * Rather than spinning up the full daemon (which touches filesystem/network),
 * we build a minimal test HTTP server that replicates the cost endpoint routing
 * using the real session module and JWT logic.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import { mintJwt, verifyJwt } from "../src/jwt.js";
import { saveSession, newSessionId, getSessionsDir } from "../src/session.js";
import type { SessionData } from "../src/types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const TEST_SIGNING_KEY = "test-cost-signing-key-32-bytes!";

function makeSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    sessionId: newSessionId(),
    model: "deepseek/deepseek-chat-v3-2",
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    turnCount: 5,
    cwd: "/tmp",
    cumulativeCostUsd: 0.042,
    ...overrides,
  };
}

// ── Minimal test server replicating the /sessions/:id/cost route ──────────────

let server: http.Server;
let baseUrl: string;

// Import loadSessionRaw dynamically to stay in sync with production
const { loadSessionRaw } = await import("../src/session.js");

function createTestServer(): http.Server {
  return http.createServer((req, res) => {
    // JWT auth check for all /sessions routes
    if (req.url?.startsWith("/sessions")) {
      const authHeader = req.headers["authorization"] ?? "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (!token) { res.writeHead(401); res.end(); return; }
      try { verifyJwt(token, TEST_SIGNING_KEY); } catch { res.writeHead(403); res.end(); return; }
    }

    // GET /sessions/:sessionId/cost
    if (req.method === "GET" && req.url) {
      const parsedUrl = new URL(req.url, "http://127.0.0.1");
      const pathname = parsedUrl.pathname;

      const costMatch = pathname.match(/^\/sessions\/([^/]+)\/cost$/);
      if (costMatch) {
        const sessionId = costMatch[1]!;
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid session id format" }));
          return;
        }
        void (async () => {
          try {
            const sessionData = await loadSessionRaw(sessionId);
            if (!sessionData) {
              res.writeHead(404, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "session not found" }));
              return;
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              sessionId: sessionData.sessionId,
              cumulativeCostUsd: sessionData.cumulativeCostUsd ?? 0,
              lastRunAt: sessionData.updatedAt,
              runCount: sessionData.turnCount,
            }));
          } catch (err) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
          }
        })();
        return;
      }
    }

    res.writeHead(404);
    res.end();
  });
}

beforeAll(async () => {
  // Isolate sessions to a temp dir so tests don't touch real sessions
  const tmpDir = path.join(os.tmpdir(), `orager-cost-test-${crypto.randomBytes(8).toString("hex")}`);
  await fs.mkdir(tmpDir, { recursive: true });
  process.env["ORAGER_SESSIONS_DIR"] = tmpDir;

  server = createTestServer();
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // Clean up temp sessions dir
  const tmpDir = process.env["ORAGER_SESSIONS_DIR"];
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    delete process.env["ORAGER_SESSIONS_DIR"];
  }
});

// Cleanup session files created during each test
const createdSessionIds: string[] = [];
beforeEach(() => {
  createdSessionIds.length = 0;
});

async function cleanupSessions(): Promise<void> {
  const dir = getSessionsDir();
  for (const id of createdSessionIds) {
    await fs.unlink(path.join(dir, `${id}.json`)).catch(() => {});
  }
}

function makeToken(): string {
  return mintJwt(TEST_SIGNING_KEY, "orager-test");
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /sessions/:sessionId/cost", () => {
  it("returns correct cumulativeCostUsd for a known session", async () => {
    const session = makeSession({ cumulativeCostUsd: 0.123, turnCount: 7 });
    await saveSession(session);
    createdSessionIds.push(session.sessionId);

    const res = await fetch(`${baseUrl}/sessions/${session.sessionId}/cost`, {
      headers: { Authorization: `Bearer ${makeToken()}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.sessionId).toBe(session.sessionId);
    expect(body.cumulativeCostUsd).toBeCloseTo(0.123);
    expect(body.runCount).toBe(7);
    expect(body.lastRunAt).toBe(session.updatedAt);

    await cleanupSessions();
  });

  it("defaults cumulativeCostUsd to 0 when field is absent (legacy session)", async () => {
    const session = makeSession();
    // Remove cumulativeCostUsd to simulate an old session
    const { cumulativeCostUsd: _removed, ...sessionWithout } = session;
    await saveSession(sessionWithout as SessionData);
    createdSessionIds.push(session.sessionId);

    const res = await fetch(`${baseUrl}/sessions/${session.sessionId}/cost`, {
      headers: { Authorization: `Bearer ${makeToken()}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.cumulativeCostUsd).toBe(0);

    await cleanupSessions();
  });

  it("returns 404 for a nonexistent session", async () => {
    const res = await fetch(`${baseUrl}/sessions/nonexistent-session-id/cost`, {
      headers: { Authorization: `Bearer ${makeToken()}` },
    });
    expect(res.status).toBe(404);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toMatch(/not found/i);
  });

  it("returns 401 when Authorization header is missing", async () => {
    const res = await fetch(`${baseUrl}/sessions/some-session-id/cost`);
    expect(res.status).toBe(401);
  });

  it("returns 403 for an invalid JWT token", async () => {
    const res = await fetch(`${baseUrl}/sessions/some-session-id/cost`, {
      headers: { Authorization: "Bearer invalid-token" },
    });
    expect(res.status).toBe(403);
  });

  it("response shape includes sessionId, cumulativeCostUsd, lastRunAt, runCount", async () => {
    const now = new Date().toISOString();
    const session = makeSession({
      cumulativeCostUsd: 0.005,
      turnCount: 2,
      updatedAt: now,
    });
    await saveSession(session);
    createdSessionIds.push(session.sessionId);

    const res = await fetch(`${baseUrl}/sessions/${session.sessionId}/cost`, {
      headers: { Authorization: `Bearer ${makeToken()}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      ["cumulativeCostUsd", "lastRunAt", "runCount", "sessionId"].sort(),
    );

    await cleanupSessions();
  });
});
