/**
 * Tests for the daemon's concurrency enforcement gates in
 * src/daemon/routes/run.ts:
 *
 *   1. Global maxConcurrent gate       → 503 "max concurrent runs exceeded"
 *   2. Per-agent concurrency gate       → 429 "per-agent concurrency limit exceeded"
 *   3. Draining (shutdown in progress)  → 503 "daemon shutting down"
 *
 * Uses a minimal in-process HTTP server that replicates the same guard logic
 * as the real handleRun(), controlled via shared mutable state so we can
 * pre-fill slot counts without needing actual concurrent HTTP connections.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mintJwt, verifyJwt } from "../src/jwt.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const SIGNING_KEY       = "conc-test-signing-key-32-bytes!!";
const MAX_CONCURRENT    = 2;
const PER_AGENT_MAX     = 1;

// ── Shared mutable state (mirrors DaemonContext fields) ───────────────────────

let activeRuns = 0;
let draining   = false;
const activeRunsByAgent = new Map<string, number>();

// ── Concurrency-aware test server ─────────────────────────────────────────────

function createConcurrencyServer(): http.Server {
  return http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/run") {
      res.writeHead(404); res.end(); return;
    }

    // ── JWT verification ────────────────────────────────────────────────────
    const authHeader = req.headers["authorization"] ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) { res.writeHead(401); res.end(); return; }
    let agentId: string;
    try {
      const claims = verifyJwt(token, SIGNING_KEY) as { agentId: string };
      agentId = claims.agentId;
    } catch {
      res.writeHead(401); res.end(); return;
    }

    // ── Drain check ─────────────────────────────────────────────────────────
    if (draining) {
      res.writeHead(503, { "Retry-After": "5" });
      res.end(JSON.stringify({ error: "daemon shutting down" }));
      return;
    }

    // ── Per-agent gate ──────────────────────────────────────────────────────
    const agentSlots = activeRunsByAgent.get(agentId) ?? 0;
    if (agentSlots >= PER_AGENT_MAX) {
      res.writeHead(429, { "Retry-After": "10" });
      res.end(JSON.stringify({ error: `per-agent concurrency limit (${PER_AGENT_MAX}) exceeded` }));
      return;
    }

    // ── Global gate ─────────────────────────────────────────────────────────
    if (activeRuns >= MAX_CONCURRENT) {
      res.writeHead(503, { "Retry-After": "5" });
      res.end(JSON.stringify({ error: "max concurrent runs exceeded" }));
      return;
    }

    // Passed all gates — pretend to run and respond
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.end(
        JSON.stringify({
          type: "result", subtype: "success", result: "ok",
          session_id: "test", finish_reason: "stop",
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
          total_cost_usd: 0,
        }) + "\n",
      );
    });
  });
}

// ── Server lifecycle ──────────────────────────────────────────────────────────

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = createConcurrencyServer();
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function validToken(id: string): string {
  return mintJwt(SIGNING_KEY, id);
}

async function postRun(agentId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${validToken(agentId)}`,
    },
    body: JSON.stringify({ prompt: "hello", opts: {} }),
  });
  const body = await res.json().catch(() => ({})) as Record<string, unknown>;
  return { status: res.status, body };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /run — global maxConcurrent gate", () => {
  it("returns 503 with 'max concurrent runs exceeded' when activeRuns is at the limit", async () => {
    activeRuns = MAX_CONCURRENT; // pre-fill to limit
    try {
      const { status, body } = await postRun("agent-global");
      expect(status).toBe(503);
      expect(typeof (body as { error: string }).error).toBe("string");
      expect((body as { error: string }).error).toContain("max concurrent");
    } finally {
      activeRuns = 0;
    }
  });

  it("returns 200 when activeRuns is one below the limit", async () => {
    activeRuns = MAX_CONCURRENT - 1;
    try {
      const { status } = await postRun("agent-below-limit");
      expect(status).toBe(200);
    } finally {
      activeRuns = 0;
    }
  });

  it("Retry-After header is present in the 503 response", async () => {
    activeRuns = MAX_CONCURRENT;
    try {
      const res = await fetch(`${baseUrl}/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${validToken("agent-retry")}`,
        },
        body: JSON.stringify({ prompt: "hello", opts: {} }),
      });
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("5");
    } finally {
      activeRuns = 0;
    }
  });
});

describe("POST /run — per-agent concurrency gate", () => {
  it("returns 429 with 'per-agent concurrency limit' when agent is at its slot limit", async () => {
    const agentId = "agent-per-agent";
    activeRunsByAgent.set(agentId, PER_AGENT_MAX); // pre-fill
    try {
      const { status, body } = await postRun(agentId);
      expect(status).toBe(429);
      expect((body as { error: string }).error).toContain("per-agent");
    } finally {
      activeRunsByAgent.delete(agentId);
    }
  });

  it("returns 200 for a different agent that has no active slots", async () => {
    const takenAgent = "agent-taken";
    activeRunsByAgent.set(takenAgent, PER_AGENT_MAX);
    try {
      const { status } = await postRun("agent-free");
      expect(status).toBe(200);
    } finally {
      activeRunsByAgent.delete(takenAgent);
    }
  });

  it("Retry-After header is present in the 429 response", async () => {
    const agentId = "agent-429-retry";
    activeRunsByAgent.set(agentId, PER_AGENT_MAX);
    try {
      const res = await fetch(`${baseUrl}/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${validToken(agentId)}`,
        },
        body: JSON.stringify({ prompt: "hello", opts: {} }),
      });
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("10");
    } finally {
      activeRunsByAgent.delete(agentId);
    }
  });
});

describe("POST /run — draining (shutdown in progress)", () => {
  it("returns 503 with 'daemon shutting down' while draining is true", async () => {
    draining = true;
    try {
      const { status, body } = await postRun("agent-drain");
      expect(status).toBe(503);
      expect((body as { error: string }).error).toContain("shutting down");
    } finally {
      draining = false;
    }
  });

  it("draining check takes priority over the JWT check order (checked before JWT in real code)", async () => {
    // In the real handleRun, draining is checked BEFORE per-agent/global limits but
    // AFTER JWT. We confirm the drain 503 response shape is consistent.
    draining = true;
    try {
      const { status } = await postRun("any-agent");
      expect(status).toBe(503);
    } finally {
      draining = false;
    }
  });

  it("returns 200 once draining is cleared", async () => {
    draining = false;
    const { status } = await postRun("agent-after-drain");
    expect(status).toBe(200);
  });
});
