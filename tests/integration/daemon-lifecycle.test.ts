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

vi.mock("../../src/jwt.js", async (importOriginal) => {
  // importOriginal is vitest-specific; bun passes undefined so we fall back to
  // a direct import() which gives the real module under bun's mock system.
  const orig: typeof import("../../src/jwt.js") =
    typeof importOriginal === "function"
      ? await importOriginal()
      : await import("../../src/jwt.js");
  return {
    ...orig,
    // Return a fixed key so the test can mint/verify JWTs deterministically
    loadOrCreateSigningKey: vi.fn().mockResolvedValue(TEST_SIGNING_KEY),
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

vi.mock("../../src/session.js", async (importOriginal) => {
  // importOriginal is vitest-specific; bun passes undefined so we fall back to
  // a direct import() which gives the real module under bun's mock system.
  const orig: typeof import("../../src/session.js") =
    typeof importOriginal === "function"
      ? await importOriginal()
      : await import("../../src/session.js");
  return {
    ...orig,
    ensureSessionsDirPermissions: vi.fn().mockResolvedValue(undefined),
    pruneOldSessions: vi.fn().mockResolvedValue({ deleted: 0, kept: 0 }),
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
});

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
    });
    expect(status).toBe(404);
    expect((body as { error: string }).error).toContain("run not found");
  });

  it("POST /runs/:id/cancel with invalid UUID format returns 400", async () => {
    const { status } = await fetchJson(`${daemonUrl}/runs/not-a-uuid/cancel`, {
      method: "POST",
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
    process.env["ORAGER_DB_PATH"] = "/tmp";
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
