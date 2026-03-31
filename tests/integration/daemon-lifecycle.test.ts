/**
 * Integration test for the full daemon HTTP lifecycle.
 *
 * Calls startDaemon() directly (no subprocess) against mocked external
 * dependencies so the test stays fast and hermetic:
 *
 *   callOpenRouter        → mocked (warmCache / keepAlive pings)
 *   runAgentLoop          → mocked (returns a fixed result event)
 *   loadOrCreateSigningKey → mocked (returns a fixed test key)
 *   checkAndLogApiKeyHealth / fetchModelContextLengths / fetchLiveModelMeta
 *                         → mocked (fire-and-forget startup calls)
 *
 * Uses startDaemon(port: 0) so the OS assigns a free port, and calls the
 * returned shutdown() function (not process.exit) for cleanup.
 *
 * Test coverage:
 *   1. GET /health                      → 200 { status: "ok" }
 *   2. POST /run (valid JWT)            → 200 NDJSON stream with result event
 *   3. POST /run (no JWT)               → 401
 *   4. POST /run (invalid JWT)          → 401
 *   5. POST /run (oversized body)       → 413
 *   6. POST /runs/:id/cancel (unknown)  → 404
 *   7. POST /runs/:id/cancel (bad UUID) → 400
 *   8. GET /metrics (valid JWT)         → 200, completedRuns >= 1
 *   9. GET /metrics (no JWT)            → 401
 *  10. Unknown route                    → 404
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mintJwt } from "../../src/jwt.js";

// vi.hoisted ensures this runs before vi.mock factories (which are also hoisted)
const { TEST_SIGNING_KEY } = vi.hoisted(() => ({
  TEST_SIGNING_KEY: "test-signing-key-for-testing-32b",
}));

// ── Mocks (must be declared before dynamic imports) ───────────────────────────

// Inline the JWT functions to avoid importOriginal which hangs under bun.
// mintJwt and verifyJwt are pure crypto — the only function we need to mock
// is loadOrCreateSigningKey (to return a deterministic test key).
vi.mock("../../src/jwt.js", () => {
  const crypto = require("node:crypto");
  const path = require("node:path");
  const os = require("node:os");

  const TOKEN_TTL_SECONDS = 900;
  function base64url(input: string): string {
    return Buffer.from(input, "utf8").toString("base64url");
  }
  function parseBase64url(input: string): string {
    return Buffer.from(input, "base64url").toString("utf8");
  }

  return {
    mintJwt(signingKey: string, agentId: string): string {
      const now = Math.floor(Date.now() / 1000);
      const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
      const payload = base64url(
        JSON.stringify({ agentId, scope: "run", iat: now, exp: now + TOKEN_TTL_SECONDS }),
      );
      const data = `${header}.${payload}`;
      const sig = crypto.createHmac("sha256", signingKey).update(data).digest("base64url");
      return `${data}.${sig}`;
    },
    verifyJwt(token: string, signingKey: string) {
      const parts = token.split(".");
      if (parts.length !== 3) throw new Error("Malformed JWT");
      const [header, payload, sig] = parts;
      const data = `${header}.${payload}`;
      const expected = crypto.createHmac("sha256", signingKey).update(data).digest("base64url");
      const sigBuf = Buffer.from(sig!, "base64url");
      const expectedBuf = Buffer.from(expected, "base64url");
      if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
        throw new Error("Invalid JWT signature");
      }
      let claims: Record<string, unknown>;
      try { claims = JSON.parse(parseBase64url(payload!)); } catch { throw new Error("JWT payload is not valid JSON"); }
      if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || (claims.exp as number) < Math.floor(Date.now() / 1000)) {
        throw new Error("JWT has expired or has invalid exp claim");
      }
      if (typeof claims.iat !== "number" || !Number.isFinite(claims.iat)) throw new Error("JWT has invalid iat claim");
      if ((claims.iat as number) > Math.floor(Date.now() / 1000) + 30) throw new Error("JWT iat is too far in the future");
      if (claims.scope !== "run") throw new Error("JWT scope must be 'run'");
      return claims;
    },
    loadOrCreateSigningKey: vi.fn().mockResolvedValue(TEST_SIGNING_KEY),
    KEY_PATH: path.join(os.homedir(), ".orager", "daemon.key"),
  };
});

vi.mock("../../src/openrouter.js", () => ({
  callOpenRouter: vi.fn().mockResolvedValue({
    content: "pong",
    reasoning: "",
    toolCalls: [],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    cachedTokens: 0,
    cacheWriteTokens: 0,
    model: "test-model",
    finishReason: "stop",
    isError: false,
  }),
  shouldUseDirect: vi.fn().mockReturnValue(false),
  callEmbeddings: vi.fn().mockResolvedValue([[]]),
}));

vi.mock("../../src/loop.js", () => ({
  runAgentLoop: vi.fn().mockImplementation(
    async (opts: { onEmit: (e: unknown) => void }) => {
      opts.onEmit({
        type: "result",
        subtype: "success",
        result: "hello from mock",
        session_id: "test-session-id",
        finish_reason: "stop",
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 },
        total_cost_usd: 0.001,
        turn_count: 1,
        exit_code: 0,
      });
    },
  ),
}));

vi.mock("../../src/openrouter-key.js", () => ({
  checkAndLogApiKeyHealth: vi.fn().mockResolvedValue(undefined),
  fetchApiKeyInfo: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../src/loop-helpers.js", () => ({
  fetchModelContextLengths: vi.fn().mockResolvedValue({}),
}));

vi.mock("../../src/openrouter-model-meta.js", () => ({
  fetchLiveModelMeta: vi.fn().mockResolvedValue({}),
}));

vi.mock("../../src/embedding-cache.js", () => ({
  setCachedQueryEmbedding: vi.fn(),
}));

// Provide explicit session.js mock — avoid importOriginal which hangs under bun.
// The daemon uses getSessionsDir, ensureSessionsDirPermissions, pruneOldSessions,
// and the session routes use listSessions, searchSessions, loadSessionRaw, etc.
vi.mock("../../src/session.js", () => {
  const os = require("node:os");
  const path = require("node:path");
  return {
    CURRENT_SESSION_SCHEMA_VERSION: 1,
    SESSION_MAX_SIZE_BYTES: 5 * 1024 * 1024,
    _refreshSessionMaxSize: vi.fn(),
    migrateSession: vi.fn((d: unknown) => d),
    getSessionsDir: vi.fn(() => {
      const dir = path.join(os.tmpdir(), "orager-test-daemon");
      try { require("node:fs").mkdirSync(dir, { recursive: true }); } catch {}
      return dir;
    }),
    ensureSessionsDirPermissions: vi.fn().mockResolvedValue(undefined),
    pruneOldSessions: vi.fn().mockResolvedValue({ deleted: 0, kept: 0 }),
    saveSession: vi.fn().mockResolvedValue(undefined),
    loadSession: vi.fn().mockResolvedValue(null),
    loadSessionRaw: vi.fn().mockResolvedValue(null),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    listSessions: vi.fn().mockResolvedValue([]),
    searchSessions: vi.fn().mockResolvedValue([]),
    deleteTrashedSessions: vi.fn().mockResolvedValue({ deleted: 0, kept: 0 }),
    forkSession: vi.fn().mockResolvedValue("forked-id"),
    compactSession: vi.fn().mockResolvedValue(undefined),
    acquireSessionLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
    trashSession: vi.fn().mockResolvedValue(true),
    restoreSession: vi.fn().mockResolvedValue(true),
    newSessionId: vi.fn(() => "test-new-session-id"),
    rollbackSession: vi.fn().mockResolvedValue(undefined),
  };
});

// ── Test state ────────────────────────────────────────────────────────────────

let daemonUrl: string;
let shutdownFn: (timeoutMs: number) => Promise<void>;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

function validJwt(): string {
  return mintJwt(TEST_SIGNING_KEY, "test-agent");
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeAll(async () => {
  const { startDaemon } = await import("../../src/daemon.js");
  const result = await startDaemon({
    port: 0, // OS assigns a free port — avoids conflicts with real daemon
    maxConcurrent: 2,
    apiKey: "test-api-key",
    model: "test-model",
    idleTimeoutMs: 60 * 60 * 1000, // 1 hour — prevent idle shutdown during tests
  });
  daemonUrl = `http://127.0.0.1:${result.port}`;
  shutdownFn = result.shutdown;
}, 15_000);

afterAll(async () => {
  // shutdown() closes the server without calling process.exit — safe in vitest
  try { await shutdownFn(5_000); } catch { /* ignore if already shut down */ }
}, 15_000);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("daemon HTTP lifecycle", () => {
  it("GET /health returns minimal 200 { status: 'ok' }", async () => {
    const { status, body } = await fetchJson(`${daemonUrl}/health`);
    expect(status).toBe(200);
    const b = body as { status: string };
    expect(b.status).toBe("ok");
  });

  it("POST /run without JWT returns 401", async () => {
    const { status } = await fetchJson(`${daemonUrl}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello", opts: {} }),
    });
    expect(status).toBe(401);
  });

  it("POST /run with invalid JWT returns 401", async () => {
    const { status } = await fetchJson(`${daemonUrl}/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer definitely.not.valid",
      },
      body: JSON.stringify({ prompt: "hello", opts: {} }),
    });
    expect(status).toBe(401);
  });

  it("POST /run with valid JWT streams a result event", async () => {
    const res = await fetch(`${daemonUrl}/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${validJwt()}`,
      },
      body: JSON.stringify({ prompt: "say hello", opts: { model: "test-model" } }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");

    const text = await res.text();
    const events = text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(events.length).toBeGreaterThan(0);
    const resultEvent = events.find((e) => e.type === "result");
    expect(resultEvent).toBeDefined();
    expect(resultEvent?.subtype).toBe("success");
    expect(resultEvent?.result).toBe("hello from mock");
  });

  it("POST /run with oversized body returns 413 (or closes connection)", async () => {
    // req.destroy() may close the socket before the 413 is sent — accept either outcome
    const bigBody = "x".repeat(5 * 1024 * 1024); // 5 MB > 4 MB limit
    try {
      const { status } = await fetchJson(`${daemonUrl}/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${validJwt()}`,
        },
        body: bigBody,
      });
      expect(status).toBe(413);
    } catch (err) {
      // Socket was destroyed before response — server correctly rejected oversized body
      expect(String(err)).toMatch(/fetch failed|socket|closed|EPIPE/i);
    }
  });

  it("POST /runs/:id/cancel with unknown run ID returns 404", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const { status, body } = await fetchJson(`${daemonUrl}/runs/${fakeId}/cancel`, {
      method: "POST",
      headers: { Authorization: `Bearer ${validJwt()}` },
    });
    expect(status).toBe(404);
    expect((body as { error: string }).error).toContain("run not found");
  });

  it("POST /runs/:id/cancel with invalid UUID format returns 400", async () => {
    const { status } = await fetchJson(`${daemonUrl}/runs/not-a-uuid/cancel`, {
      method: "POST",
      headers: { Authorization: `Bearer ${validJwt()}` },
    });
    expect(status).toBe(400);
  });

  it("GET /metrics with valid JWT returns run counters", async () => {
    const { status, body } = await fetchJson(`${daemonUrl}/metrics`, {
      headers: { Authorization: `Bearer ${validJwt()}` },
    });
    expect(status).toBe(200);
    const metrics = body as Record<string, unknown>;
    expect(typeof metrics["completedRuns"]).toBe("number");
    expect(metrics["completedRuns"] as number).toBeGreaterThanOrEqual(1);
    expect(typeof metrics["activeRuns"]).toBe("number");
    expect(metrics["model"]).toBe("test-model");
  });

  it("GET /metrics without JWT returns 401", async () => {
    const { status } = await fetchJson(`${daemonUrl}/metrics`);
    expect(status).toBe(401);
  });

  it("unknown route returns 404", async () => {
    const { status } = await fetchJson(`${daemonUrl}/does-not-exist`);
    expect(status).toBe(404);
  });

  it("GET /health/detail with valid JWT returns deep checks (audit E-06)", async () => {
    const { status, body } = await fetchJson(`${daemonUrl}/health/detail`, {
      headers: { Authorization: `Bearer ${validJwt()}` },
    });
    expect(status).toBe(200);
    const b = body as { status: string; checks: Record<string, string>; uptimeMs: number; activeRuns: number };
    expect(b.status).toBe("ok");
    expect(b.checks).toBeDefined();
    expect(typeof b.uptimeMs).toBe("number");
    expect(typeof b.activeRuns).toBe("number");
  });

  it("GET /health/detail without JWT returns 401", async () => {
    const { status } = await fetchJson(`${daemonUrl}/health/detail`);
    expect(status).toBe(401);
  });

  it("GET /health/detail returns 503 degraded when a check fails", async () => {
    const prev = process.env["ORAGER_DB_PATH"];
    process.env["ORAGER_DB_PATH"] = "/tmp/nonexistent-orager-db-healthcheck-test.sqlite";
    try {
      const { status, body } = await fetchJson(`${daemonUrl}/health/detail`, {
        headers: { Authorization: `Bearer ${validJwt()}` },
      });
      expect(status).toBe(503);
      const b = body as { status: string; reason: string; checks: Record<string, string> };
      expect(b.status).toBe("degraded");
      expect(b.checks.db).toBe("error");
      expect(b.reason).toContain("db");
    } finally {
      if (prev === undefined) {
        delete process.env["ORAGER_DB_PATH"];
      } else {
        process.env["ORAGER_DB_PATH"] = prev;
      }
    }
  });

  it("GET /metrics/prometheus returns Prometheus exposition format (audit E-13)", async () => {
    const res = await fetch(`${daemonUrl}/metrics/prometheus`, {
      headers: { Authorization: `Bearer ${validJwt()}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const text = await res.text();
    expect(text).toContain("orager_active_runs ");
    expect(text).toContain("orager_completed_runs_total ");
    expect(text).toContain("orager_error_runs_total ");
    expect(text).toContain("orager_uptime_seconds ");
  });

  it("GET /metrics/prometheus without JWT returns 401", async () => {
    const res = await fetch(`${daemonUrl}/metrics/prometheus`);
    expect(res.status).toBe(401);
  });
});
