/**
 * Integration tests for the orager UI server API routes.
 *
 * Uses a real HTTP server bound to a test port. Config/settings I/O is
 * redirected to a temp directory via _setPathsForTesting so the developer's
 * ~/.orager files are never touched. Sessions are provided by a mocked
 * listSessions to avoid depending on SQLite state.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mocked } from "./mock-helpers.js";

// ── Session mock — all exports required by Bun's static linker ───────────────

vi.mock("../src/session.js", () => ({
  CURRENT_SESSION_SCHEMA_VERSION: 1,
  SESSION_MAX_SIZE_BYTES: 10_485_760,
  _refreshSessionMaxSize: vi.fn(),
  migrateSession: vi.fn((d: unknown) => d),
  getSessionsDir: vi.fn().mockReturnValue("/tmp/test-sessions"),
  _resetStoreForTesting: vi.fn(),
  saveSessionCheckpoint: vi.fn().mockResolvedValue(undefined),
  loadSessionCheckpoint: vi.fn().mockResolvedValue(null),
  loadLatestCheckpointByContextId: vi.fn().mockResolvedValue(null),
  saveSession: vi.fn().mockResolvedValue(undefined),
  loadSession: vi.fn().mockResolvedValue(null),
  loadSessionRaw: vi.fn().mockResolvedValue(null),
  deleteSession: vi.fn().mockResolvedValue(undefined),
  listSessions: vi.fn().mockResolvedValue([]),
  pruneOldSessions: vi.fn().mockResolvedValue({ pruned: 0, kept: 0, errors: 0 }),
  deleteTrashedSessions: vi.fn().mockResolvedValue({ pruned: 0, kept: 0, errors: 0 }),
  forkSession: vi.fn().mockResolvedValue("forked-id"),
  compactSession: vi.fn().mockResolvedValue(null),
  acquireSessionLock: vi.fn().mockResolvedValue({ release: vi.fn(), sessionId: "test" }),
  trashSession: vi.fn().mockResolvedValue(true),
  restoreSession: vi.fn().mockResolvedValue(true),
  newSessionId: vi.fn().mockReturnValue("test-session-id"),
  searchSessions: vi.fn().mockResolvedValue([]),
  rollbackSession: vi.fn().mockResolvedValue(null),
  ensureSessionsDirPermissions: vi.fn().mockResolvedValue(undefined),
}));

// ── Imports that depend on mocks ─────────────────────────────────────────────

import { _createTestServer, _setPathsForTesting } from "../src/ui-server.js";
import { listSessions } from "../src/session.js";

// ── Test harness ─────────────────────────────────────────────────────────────

const TEST_PORT = 13457;

let server: http.Server;
let token: string;
let base: string;
let tmpDir: string;
let configPath: string;
let settingsPath: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orager-ui-test-"));
  configPath = path.join(tmpDir, "config.json");
  settingsPath = path.join(tmpDir, "settings.json");
  _setPathsForTesting(configPath, settingsPath);
  ({ server, token } = await _createTestServer(TEST_PORT));
  base = `http://127.0.0.1:${TEST_PORT}`;
});

afterAll(async () => {
  server.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  // Each test starts with a clean slate — no config or settings files
  await fs.unlink(configPath).catch(() => {});
  await fs.unlink(settingsPath).catch(() => {});
});

function get(urlPath: string, auth = true): Promise<Response> {
  return fetch(`${base}${urlPath}`, {
    headers: auth ? { Authorization: `Bearer ${token}` } : {},
  });
}

function post(urlPath: string, body: unknown, auth = true): Promise<Response> {
  return fetch(`${base}${urlPath}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

// ── Auth ──────────────────────────────────────────────────────────────────────

describe("auth", () => {
  it("returns 401 for API route without token", async () => {
    const res = await get("/api/config", false);
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/unauthorized/i);
  });

  it("accepts valid Bearer token", async () => {
    const res = await get("/api/config/defaults");
    expect(res.status).toBe(200);
  });

  it("accepts token as query param (for SSE endpoints)", async () => {
    const res = await fetch(`${base}/api/config/defaults?token=${token}`);
    expect(res.status).toBe(200);
  });

  it("rejects wrong token", async () => {
    const res = await fetch(`${base}/api/config/defaults`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  it("OPTIONS preflight bypasses auth (CORS)", async () => {
    const res = await fetch(`${base}/api/config`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
  });
});

// ── Security headers ──────────────────────────────────────────────────────────

describe("security headers", () => {
  it("sets X-Content-Type-Options: nosniff", async () => {
    const res = await get("/api/config/defaults");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("sets X-Frame-Options: DENY", async () => {
    const res = await get("/api/config/defaults");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("sets Referrer-Policy", async () => {
    const res = await get("/api/config/defaults");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  });

  it("sets Content-Security-Policy", async () => {
    const res = await get("/api/config/defaults");
    const csp = res.headers.get("content-security-policy");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });
});

// ── GET /api/config/defaults ──────────────────────────────────────────────────

describe("GET /api/config/defaults", () => {
  it("returns DEFAULT_CONFIG object", async () => {
    const res = await get("/api/config/defaults");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body).toBe("object");
    expect(body).not.toBeNull();
  });
});

// ── GET /api/config ───────────────────────────────────────────────────────────

describe("GET /api/config", () => {
  it("returns config file contents", async () => {
    await fs.writeFile(configPath, JSON.stringify({ model: "deepseek/deepseek-r1", maxTurns: 5 }), "utf8");
    const res = await get("/api/config");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.model).toBe("deepseek/deepseek-r1");
    expect(body.maxTurns).toBe(5);
  });

  it("strips agentApiKey from response", async () => {
    await fs.writeFile(configPath, JSON.stringify({ model: "gpt-4o", agentApiKey: "sk-secret" }), "utf8");
    const res = await get("/api/config");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.model).toBe("gpt-4o");
    expect(body.agentApiKey).toBeUndefined();
  });

  it("also strips fields containing 'token' or 'secret'", async () => {
    await fs.writeFile(configPath, JSON.stringify({ webhookToken: "tok", mySecret: "s" }), "utf8");
    const res = await get("/api/config");
    const body = await res.json() as Record<string, unknown>;
    expect(body.webhookToken).toBeUndefined();
    expect(body.mySecret).toBeUndefined();
  });

  it("returns defaults when config file does not exist", async () => {
    // configPath was not written in this test
    const res = await get("/api/config");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body).toBe("object");
  });
});

// ── POST /api/config ──────────────────────────────────────────────────────────

describe("POST /api/config", () => {
  it("writes merged config and returns it", async () => {
    await fs.writeFile(configPath, JSON.stringify({ model: "gpt-4o" }), "utf8");
    const res = await post("/api/config", { maxCostUsd: 2.5 });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.model).toBe("gpt-4o");
    expect(body.maxCostUsd).toBe(2.5);
    // Verify the file was actually persisted
    const saved = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
    expect(saved.maxCostUsd).toBe(2.5);
  });

  it("cannot set agentApiKey through the API", async () => {
    await fs.writeFile(configPath, JSON.stringify({ model: "gpt-4o" }), "utf8");
    const res = await post("/api/config", { agentApiKey: "inject-me", model: "new-model" });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.agentApiKey).toBeUndefined();
    expect(body.model).toBe("new-model");
    // Also must not be in the saved file
    const saved = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
    expect(saved.agentApiKey).toBeUndefined();
  });

  it("returns 400 for non-object body (array)", async () => {
    const res = await post("/api/config", [1, 2, 3]);
    expect(res.status).toBe(400);
  });

  it("returns 400 for non-object body (string)", async () => {
    const res = await post("/api/config", "bad-body");
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid JSON", async () => {
    const res = await fetch(`${base}/api/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: "{ not valid json",
    });
    expect(res.status).toBe(400);
  });
});

// ── GET /api/settings ─────────────────────────────────────────────────────────

describe("GET /api/settings", () => {
  it("returns settings file contents", async () => {
    await fs.writeFile(settingsPath, JSON.stringify({ hooksEnabled: false }), "utf8");
    const res = await get("/api/settings");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.hooksEnabled).toBe(false);
  });

  it("returns empty object when settings file does not exist", async () => {
    const res = await get("/api/settings");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({});
  });
});

// ── POST /api/settings ────────────────────────────────────────────────────────

describe("POST /api/settings", () => {
  it("merges and persists settings", async () => {
    await fs.writeFile(settingsPath, JSON.stringify({ hooksEnabled: true }), "utf8");
    const res = await post("/api/settings", { memory: { turnInterval: 3 } });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect((body as Record<string, unknown>).hooksEnabled).toBe(true);
    expect((body.memory as Record<string, unknown>).turnInterval).toBe(3);
    // Verify persisted
    const saved = JSON.parse(await fs.readFile(settingsPath, "utf8")) as Record<string, unknown>;
    expect((saved.memory as Record<string, unknown>).turnInterval).toBe(3);
  });

  it("returns 400 for non-object body", async () => {
    const res = await post("/api/settings", "bad");
    expect(res.status).toBe(400);
  });
});

// ── GET /api/sessions ─────────────────────────────────────────────────────────

describe("GET /api/sessions", () => {
  it("returns sessions array from listSessions", async () => {
    mocked(listSessions).mockResolvedValueOnce([
      { sessionId: "abc123", model: "gpt-4o", turnCount: 3, cumulativeCostUsd: 0.01, source: "run", updatedAt: "2026-01-01T00:00:00Z" } as never,
    ]);
    const res = await get("/api/sessions");
    expect(res.status).toBe(200);
    const body = await res.json() as { sessions: unknown[]; total: number };
    expect(body.sessions).toHaveLength(1);
    expect(body.total).toBe(1);
  });

  it("returns empty sessions when none exist", async () => {
    mocked(listSessions).mockResolvedValueOnce([]);
    const res = await get("/api/sessions");
    expect(res.status).toBe(200);
    const body = await res.json() as { sessions: unknown[]; total: number };
    expect(body.sessions).toHaveLength(0);
    expect(body.total).toBe(0);
  });

  it("paginates with limit and offset", async () => {
    const all = Array.from({ length: 10 }, (_, i) => ({ sessionId: `s${i}` }));
    mocked(listSessions).mockResolvedValueOnce(all as never[]);
    const res = await get("/api/sessions?limit=3&offset=2");
    const body = await res.json() as { sessions: unknown[]; total: number; limit: number; offset: number };
    expect(body.sessions).toHaveLength(3);
    expect(body.total).toBe(10);
    expect(body.limit).toBe(3);
    expect(body.offset).toBe(2);
  });

  it("caps limit at 200", async () => {
    const all = Array.from({ length: 250 }, (_, i) => ({ sessionId: `s${i}` }));
    mocked(listSessions).mockResolvedValueOnce(all as never[]);
    const res = await get("/api/sessions?limit=9999");
    const body = await res.json() as { limit: number };
    expect(body.limit).toBe(200);
  });

  it("clamps negative offset to 0", async () => {
    mocked(listSessions).mockResolvedValueOnce([]);
    const res = await get("/api/sessions?offset=-5");
    const body = await res.json() as { offset: number };
    expect(body.offset).toBe(0);
  });
});

// ── Route dispatch ────────────────────────────────────────────────────────────

describe("route dispatch", () => {
  it("returns 404 for unknown /api/ routes", async () => {
    const res = await get("/api/nonexistent");
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("Not found");
  });

  it("returns correct Content-Type for JSON responses", async () => {
    const res = await get("/api/config/defaults");
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});
