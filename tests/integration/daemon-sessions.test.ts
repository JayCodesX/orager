/**
 * Integration tests for the daemon's /sessions endpoints.
 *
 * Creates a real HTTP server that replicates the daemon's session routing and
 * JWT logic, backed by a real tmpdir with pre-written session JSON files.
 * ORAGER_SESSIONS_DIR is pointed at the tmpdir before session.js is imported
 * so the file-backend store reads from the right place.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { mintJwt, verifyJwt } from "../../src/jwt.js";
import type { SessionSummary } from "../../src/types.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const SIGNING_KEY = "test-daemon-key-32bytes!!!!!!!!";

// ── Test state ────────────────────────────────────────────────────────────────

let serverUrl: string;
let server: http.Server;
let validToken: string;

// ── Session fixture helpers ───────────────────────────────────────────────────

function makeSession(
  sessionId: string,
  opts: {
    model: string;
    cwd: string;
    turnCount: number;
    updatedAt: string;
    trashed?: boolean;
  },
): object {
  return {
    sessionId,
    model: opts.model,
    messages: [],
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: opts.updatedAt,
    turnCount: opts.turnCount,
    cwd: opts.cwd,
    ...(opts.trashed ? { trashed: true } : {}),
  };
}

// ── Server factory ────────────────────────────────────────────────────────────
//
// Mirrors the three /sessions routes from daemon.ts exactly, but uses
// dynamically-imported listSessions / searchSessions so that
// ORAGER_SESSIONS_DIR is already set when the module is first evaluated.

async function createSessionsServer(): Promise<http.Server> {
  // Dynamic import after env var is set — picks up ORAGER_SESSIONS_DIR.
  const { listSessions, searchSessions } = await import("../../src/session.js");

  const srv = http.createServer((req, res) => {
    if (!req.method || !req.url) {
      res.writeHead(400);
      res.end();
      return;
    }

    // Only handle GET /sessions*
    if (req.method !== "GET" || !req.url.startsWith("/sessions")) {
      res.writeHead(404);
      res.end();
      return;
    }

    // JWT auth
    const authHeader = req.headers["authorization"] ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) {
      res.writeHead(401);
      res.end();
      return;
    }
    try {
      verifyJwt(token, SIGNING_KEY);
    } catch {
      res.writeHead(403);
      res.end();
      return;
    }

    void (async () => {
      try {
        const parsedUrl = new URL(req.url!, `http://127.0.0.1`);
        const pathname = parsedUrl.pathname;

        // GET /sessions/search?q=...
        if (pathname === "/sessions/search") {
          const q = parsedUrl.searchParams.get("q") ?? "";
          const limitParam = parseInt(parsedUrl.searchParams.get("limit") ?? "20", 10);
          const limit = Math.min(isNaN(limitParam) ? 20 : limitParam, 100);
          if (!q.trim()) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "q parameter is required" }));
            return;
          }
          const results = await searchSessions(q.trim(), limit);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ sessions: results, total: results.length, query: q }));
          return;
        }

        // GET /sessions/:sessionId
        const sessionIdMatch = pathname.match(/^\/sessions\/([^/]+)$/);
        if (sessionIdMatch) {
          const sessionId = sessionIdMatch[1]!;
          if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "invalid session id format" }));
            return;
          }
          const all = await listSessions();
          const session = all.find((s) => s.sessionId === sessionId && !s.trashed);
          if (!session) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "session not found" }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(session));
          return;
        }

        // GET /sessions (paginated list — excludes trashed)
        if (pathname === "/sessions") {
          const limitParam = parseInt(parsedUrl.searchParams.get("limit") ?? "50", 10);
          const limit = Math.min(isNaN(limitParam) ? 50 : limitParam, 200);
          const offsetParam = parseInt(parsedUrl.searchParams.get("offset") ?? "0", 10);
          const offset = Math.max(isNaN(offsetParam) ? 0 : offsetParam, 0);
          const all = await listSessions();
          const nonTrashed = all.filter((s) => !s.trashed);
          const page = nonTrashed.slice(offset, offset + limit);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ sessions: page, total: nonTrashed.length, limit, offset }));
          return;
        }

        res.writeHead(404);
        res.end();
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
    })();
  });

  return srv;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // 1. Create tmpdir and write fixtures.
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orager-sessions-test-"));

  const fixtures = [
    {
      file: "sess-alpha.json",
      data: makeSession("sess-alpha", {
        model: "gpt-4",
        cwd: "/home/alice/projects/webapp",
        turnCount: 3,
        updatedAt: "2024-03-01T10:00:00Z",
      }),
    },
    {
      file: "sess-beta.json",
      data: makeSession("sess-beta", {
        model: "claude-3-opus",
        cwd: "/home/bob/projects/api",
        turnCount: 7,
        updatedAt: "2024-03-02T12:00:00Z",
      }),
    },
    {
      file: "sess-gamma.json",
      data: makeSession("sess-gamma", {
        model: "gpt-4",
        cwd: "/home/alice/projects/mobile",
        turnCount: 1,
        updatedAt: "2024-03-03T08:00:00Z",
      }),
    },
    {
      file: "sess-trashed.json",
      data: makeSession("sess-trashed", {
        model: "gpt-4",
        cwd: "/home/alice/trash",
        turnCount: 2,
        updatedAt: "2024-03-04T00:00:00Z",
        trashed: true,
      }),
    },
  ];

  for (const { file, data } of fixtures) {
    await fs.writeFile(path.join(tmpDir, file), JSON.stringify(data, null, 2), "utf8");
  }

  // 2. Set env var before any import of session.js resolves.
  process.env["ORAGER_SESSIONS_DIR"] = tmpDir;

  // 3. Start test server.
  server = await createSessionsServer();
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });
  const addr = server.address() as AddressInfo;
  serverUrl = `http://127.0.0.1:${addr.port}`;

  // 4. Mint a valid token.
  validToken = mintJwt(SIGNING_KEY, "test-agent");
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // Clean up env var.
  delete process.env["ORAGER_SESSIONS_DIR"];
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getAuth(
  urlPath: string,
  token?: string,
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {};
  if (token !== undefined) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const res = await fetch(`${serverUrl}${urlPath}`, { headers });
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /sessions", () => {
  it("returns all non-trashed sessions sorted by updatedAt desc", async () => {
    const { status, body } = await getAuth("/sessions", validToken);
    expect(status).toBe(200);
    const resp = body as { sessions: SessionSummary[]; total: number };
    expect(resp.total).toBe(3);
    expect(resp.sessions).toHaveLength(3);
    // First entry must be most recent non-trashed: sess-gamma (2024-03-03)
    expect(resp.sessions[0]!.sessionId).toBe("sess-gamma");
    // No trashed session in the list.
    const ids = resp.sessions.map((s) => s.sessionId);
    expect(ids).not.toContain("sess-trashed");
  });

  it("pagination: limit=2 offset=1 returns 2 sessions starting at offset 1", async () => {
    const { status, body } = await getAuth("/sessions?limit=2&offset=1", validToken);
    expect(status).toBe(200);
    const resp = body as { sessions: SessionSummary[]; total: number; limit: number; offset: number };
    expect(resp.total).toBe(3);
    expect(resp.sessions).toHaveLength(2);
    expect(resp.limit).toBe(2);
    expect(resp.offset).toBe(1);
    // Offset 1 skips sess-gamma (index 0); next two are sess-beta, sess-alpha.
    expect(resp.sessions[0]!.sessionId).toBe("sess-beta");
    expect(resp.sessions[1]!.sessionId).toBe("sess-alpha");
  });

  it("limit capped at 200", async () => {
    const { status, body } = await getAuth("/sessions?limit=9999", validToken);
    expect(status).toBe(200);
    const resp = body as { sessions: SessionSummary[]; limit: number };
    expect(resp.limit).toBeLessThanOrEqual(200);
  });

  it("requires JWT — returns 401 without Authorization header", async () => {
    const { status } = await getAuth("/sessions");
    expect(status).toBe(401);
  });
});

describe("GET /sessions/search", () => {
  it("q=alice finds sess-alpha and sess-gamma, not sess-beta", async () => {
    const { status, body } = await getAuth("/sessions/search?q=alice", validToken);
    expect(status).toBe(200);
    const resp = body as { sessions: SessionSummary[]; total: number; query: string };
    const ids = resp.sessions.map((s) => s.sessionId);
    expect(ids).toContain("sess-alpha");
    expect(ids).toContain("sess-gamma");
    expect(ids).not.toContain("sess-beta");
    expect(resp.query).toBe("alice");
  });

  it("q=claude-3 finds sess-beta by model name", async () => {
    const { status, body } = await getAuth("/sessions/search?q=claude-3", validToken);
    expect(status).toBe(200);
    const resp = body as { sessions: SessionSummary[] };
    const ids = resp.sessions.map((s) => s.sessionId);
    expect(ids).toContain("sess-beta");
  });

  it("returns 400 when q param is missing", async () => {
    const { status, body } = await getAuth("/sessions/search", validToken);
    expect(status).toBe(400);
    expect((body as Record<string, unknown>).error).toMatch(/q parameter/i);
  });

  it("returns 403 with invalid JWT", async () => {
    const { status } = await getAuth("/sessions/search?q=alice", "not.a.valid.jwt");
    expect(status).toBe(403);
  });
});

describe("GET /sessions/:id", () => {
  it("returns session summary for known id (sess-beta, model=claude-3-opus)", async () => {
    const { status, body } = await getAuth("/sessions/sess-beta", validToken);
    expect(status).toBe(200);
    const session = body as SessionSummary;
    expect(session.sessionId).toBe("sess-beta");
    expect(session.model).toBe("claude-3-opus");
    expect(session.turnCount).toBe(7);
  });

  it("returns 404 for unknown id", async () => {
    const { status, body } = await getAuth("/sessions/does-not-exist", validToken);
    expect(status).toBe(404);
    expect((body as Record<string, unknown>).error).toMatch(/not found/i);
  });
});
