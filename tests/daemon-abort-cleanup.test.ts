/**
 * Tests for the AbortController / activeRunControllers cleanup in
 * src/daemon/routes/run.ts.
 *
 * The real handleRun() adds an AbortController to ctx.activeRunControllers
 * when a run starts and removes it in the .finally() block once the run
 * resolves or rejects.  These tests verify that lifecycle using a minimal
 * in-process HTTP server backed by the real handleRun() handler — with
 * runAgentLoop mocked so no network calls are made.
 *
 * Verified properties:
 *   1. ctx.activeRunControllers is empty after a successful run.
 *   2. ctx.activeRuns decrements back to 0 after a run.
 *   3. ctx.completedRuns increments after a run.
 *   4. ctx.activeRunsByAgent entry is deleted after a run.
 *   5. Controller map is empty even when runAgentLoop rejects (error path).
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mintJwt } from "../src/jwt.js";
import { handleRun } from "../src/daemon/routes/run.js";
import type { DaemonContext } from "../src/daemon/context.js";

// ── Mocks ─────────────────────────────────────────────────────────────────────

// Mock runAgentLoop so tests are fully hermetic — no LLM API calls.
vi.mock("../src/loop.js", () => ({
  runAgentLoop: vi.fn().mockResolvedValue(undefined),
}));

// Silence auditLog — it writes to disk/stdout in production.
vi.mock("../src/daemon/lifecycle.js", () => ({
  auditLog: vi.fn(),
}));

// Circuit breaker is always closed (no prior failures) in these tests.
vi.mock("../src/circuit-breaker.js", () => ({
  getAgentCircuitBreaker: vi.fn().mockReturnValue({
    isOpen: () => false,
    recordFailure: vi.fn(),
    recordSuccess: vi.fn(),
    retryInMs: 0,
  }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const SIGNING_KEY = "abort-cleanup-test-32-bytes-key!";

function makeCtx(): DaemonContext {
  return {
    port: 0,
    maxConcurrent: 10,
    perAgentMaxConcurrent: 5,
    apiKey: "test-api-key",
    model: "test-model",
    idleTimeoutMs: 60_000,
    requestTimeoutMs: 60_000,
    allowedCwdPrefixes: undefined,
    previousKeyTtlMs: 20 * 60 * 1000,
    signingKey: SIGNING_KEY,
    previousKey: null,
    previousKeyExpiresAt: null,
    activeRuns: 0,
    activeRunsByAgent: new Map(),
    activeRunControllers: new Map(),
    draining: false,
    completedRuns: 0,
    errorRuns: 0,
    daemonStartedAt: Date.now(),
    lastActivityAt: Date.now(),
    lastRealRequestAt: Date.now(),
    keepAliveTimer: null,
    usedModels: new Set(["test-model"]),
    modelLastUsedAt: new Map(),
  } as unknown as DaemonContext;
}

// ── Server lifecycle ──────────────────────────────────────────────────────────

let ctx: DaemonContext;
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  ctx = makeCtx();
  server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/run") {
      handleRun(ctx, req, res);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function makeToken(agentId = "test-agent"): string {
  return mintJwt(SIGNING_KEY, agentId);
}

async function postRun(
  agentId = "test-agent",
  opts: Record<string, unknown> = {},
): Promise<{ status: number }> {
  const res = await fetch(`${baseUrl}/run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${makeToken(agentId)}`,
    },
    body: JSON.stringify({ prompt: "hello world", opts }),
  });
  await res.text(); // consume body to ensure response is fully received
  return { status: res.status };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("handleRun — AbortController cleanup (finally block)", () => {
  it("activeRunControllers is empty after a successful run", async () => {
    await postRun("agent-cleanup-1");
    expect(ctx.activeRunControllers.size).toBe(0);
  });

  it("activeRuns returns to 0 after a run completes", async () => {
    await postRun("agent-cleanup-2");
    expect(ctx.activeRuns).toBe(0);
  });

  it("completedRuns increments after each run", async () => {
    const before = ctx.completedRuns;
    await postRun("agent-cleanup-3");
    expect(ctx.completedRuns).toBeGreaterThan(before);
  });

  it("activeRunsByAgent entry is removed after a run completes", async () => {
    const agentId = "agent-byagent-cleanup";
    await postRun(agentId);
    expect(ctx.activeRunsByAgent.has(agentId)).toBe(false);
  });

  it("controller map is clean after multiple sequential runs", async () => {
    await postRun("agent-seq-1");
    await postRun("agent-seq-2");
    await postRun("agent-seq-3");
    expect(ctx.activeRunControllers.size).toBe(0);
  });
});

describe("handleRun — AbortController cleanup on runAgentLoop rejection", () => {
  it("activeRunControllers is empty even when runAgentLoop rejects", async () => {
    const { runAgentLoop } = await import("../src/loop.js");
    (runAgentLoop as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("simulated loop error"),
    );

    const { status } = await postRun("agent-error-path");
    // The run still returns 200 (headers already sent before loop starts)
    expect(status).toBe(200);
    // Controller must be cleaned up in finally even on rejection
    expect(ctx.activeRunControllers.size).toBe(0);
    expect(ctx.activeRuns).toBe(0);
  });

  it("errorRuns increments when runAgentLoop rejects", async () => {
    const { runAgentLoop } = await import("../src/loop.js");
    (runAgentLoop as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("another error"),
    );

    const before = ctx.errorRuns;
    await postRun("agent-error-count");
    expect(ctx.errorRuns).toBeGreaterThan(before);
  });
});
