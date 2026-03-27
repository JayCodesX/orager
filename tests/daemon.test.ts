/**
 * Daemon HTTP server tests.
 *
 * Rather than calling startDaemon() (which touches the filesystem for pid/port
 * files, warms the LLM cache, etc.), we build a minimal test HTTP server that
 * replicates the daemon's routing and JWT logic using the real jwt module. This
 * keeps the tests fast, hermetic, and free of network/filesystem side-effects.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { mintJwt, verifyJwt } from "../src/jwt.js";
import type { AddressInfo } from "node:net";

// ── Test constants ─────────────────────────────────────────────────────────────

const TEST_SIGNING_KEY = "test-signing-key-32-bytes-long!!";
const TEST_API_KEY = "test-api-key";
const MAX_CONCURRENT = 2;
const MAX_REQUEST_BODY_BYTES = 50 * 1024 * 1024; // 50 MB

let daemonUrl: string;
let server: http.Server;

// ── Minimal test server mirroring daemon routes ────────────────────────────────

function createTestServer(): http.Server {
  let activeRuns = 0;
  const activeRunControllers = new Map<string, AbortController>();

  const srv = http.createServer((req, res) => {
    // GET /health
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", activeRuns, maxConcurrent: MAX_CONCURRENT, model: "test-model" }));
      return;
    }

    // GET /metrics
    if (req.method === "GET" && req.url === "/metrics") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        activeRuns,
        maxConcurrent: MAX_CONCURRENT,
        completedRuns: 0,
        errorRuns: 0,
        draining: false,
        uptimeMs: 0,
        model: "test-model",
        usedModels: ["test-model"],
        activeRunsByAgent: {},
        providerHealth: {},
        degradedProviders: [],
        dbBackend: "filesystem",
        dbPath: null,
        rateLimit: null,
        keyInfo: null,
      }));
      return;
    }

    // POST /run
    if (req.method === "POST" && req.url === "/run") {
      // JWT check
      const authHeader = req.headers["authorization"] ?? "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (!token) {
        res.writeHead(401);
        res.end();
        return;
      }
      try {
        verifyJwt(token, TEST_SIGNING_KEY);
      } catch {
        res.writeHead(401);
        res.end();
        return;
      }

      // Body size check + parse
      let body = "";
      let bodySize = 0;
      let bodyTooLarge = false;

      req.on("data", (chunk: Buffer) => {
        bodySize += chunk.length;
        if (bodySize > MAX_REQUEST_BODY_BYTES) {
          bodyTooLarge = true;
          req.destroy();
          return;
        }
        body += chunk.toString();
      });

      req.on("end", () => {
        if (bodyTooLarge) {
          if (!res.destroyed) {
            res.writeHead(413);
            res.end(JSON.stringify({ error: "request body too large (max 50 MB)" }));
          }
          return;
        }

        let runReq: { prompt?: string; opts?: unknown };
        try {
          runReq = JSON.parse(body) as { prompt?: string; opts?: unknown };
        } catch {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "invalid JSON body" }));
          return;
        }

        if (!runReq.prompt?.trim()) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "prompt is required" }));
          return;
        }

        // Simulate a run response (no real agent loop in tests)
        activeRuns++;
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        res.end(
          JSON.stringify({ type: "result", subtype: "success", result: "ok", session_id: "test", finish_reason: "stop", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 }, total_cost_usd: 0 }) + "\n",
        );
        activeRuns--;
      });

      req.on("error", () => {
        res.destroy();
      });
      return;
    }

    // POST /runs/:runId/cancel
    if (req.method === "POST" && req.url?.startsWith("/runs/") && req.url.endsWith("/cancel")) {
      const runId = req.url.slice("/runs/".length, -"/cancel".length);
      const controller = activeRunControllers.get(runId);
      if (!controller) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "run not found" }));
        return;
      }
      controller.abort();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, runId }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  return srv;
}

// ── Server lifecycle ───────────────────────────────────────────────────────────

beforeAll(async () => {
  server = createTestServer();
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });
  const addr = server.address() as AddressInfo;
  daemonUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ── Helper ─────────────────────────────────────────────────────────────────────

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${daemonUrl}${path}`);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function post(
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.token) headers["Authorization"] = `Bearer ${options.token}`;
  const res = await fetch(`${daemonUrl}${path}`, {
    method: "POST",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("GET /health", () => {
  it("returns 200 with status ok", async () => {
    const { status, body } = await get("/health");
    expect(status).toBe(200);
    expect((body as Record<string, unknown>).status).toBe("ok");
  });
});

describe("GET /metrics", () => {
  it("returns 200 with activeRuns field", async () => {
    const { status, body } = await get("/metrics");
    expect(status).toBe(200);
    expect(body).toHaveProperty("activeRuns");
  });
});

describe("POST /run", () => {
  it("returns 401 without Authorization header", async () => {
    const { status } = await post("/run", { body: { prompt: "hello", opts: {} } });
    expect(status).toBe(401);
  });

  it("returns 401 with invalid JWT", async () => {
    const { status } = await post("/run", {
      token: "not.a.valid.jwt",
      body: { prompt: "hello", opts: {} },
    });
    expect(status).toBe(401);
  });

  it("returns 400 with valid JWT but empty body (no prompt)", async () => {
    const token = mintJwt(TEST_SIGNING_KEY, "test-agent");
    const { status } = await post("/run", {
      token,
      body: { prompt: "", opts: {} },
    });
    expect(status).toBe(400);
  });

  it("returns 400 with valid JWT but missing prompt field", async () => {
    const token = mintJwt(TEST_SIGNING_KEY, "test-agent");
    const { status } = await post("/run", {
      token,
      body: { opts: {} },
    });
    expect(status).toBe(400);
  });

  it("returns 413 (or closes connection) when body exceeds 50 MB limit", async () => {
    const token = mintJwt(TEST_SIGNING_KEY, "test-agent");
    // Build a body slightly over 50 MB
    const oversized = "x".repeat(MAX_REQUEST_BODY_BYTES + 1024);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    };
    // When the body is too large the server calls req.destroy() which may
    // close the socket before the 413 response is fully sent. Accept either
    // a 413 status or a socket-level error as proof the server rejected the body.
    try {
      const res = await fetch(`${daemonUrl}/run`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: oversized, opts: {} }),
      });
      expect(res.status).toBe(413);
    } catch (err) {
      // Socket was destroyed before response — server correctly rejected oversized body
      const msg = String(err);
      expect(msg).toMatch(/fetch failed|socket|closed/i);
    }
  });

  it("returns 200 with valid JWT and valid body", async () => {
    const token = mintJwt(TEST_SIGNING_KEY, "test-agent");
    const { status } = await post("/run", {
      token,
      body: { prompt: "hello world", opts: {} },
    });
    expect(status).toBe(200);
  });
});

describe("POST /runs/:runId/cancel", () => {
  it("returns 404 for a nonexistent run ID", async () => {
    const { status, body } = await post("/runs/nonexistent/cancel");
    expect(status).toBe(404);
    expect((body as Record<string, unknown>).error).toBe("run not found");
  });
});
