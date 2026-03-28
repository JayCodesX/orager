/**
 * P2-3: Rate limiting on daemon HTTP endpoints tests.
 *
 * Tests the token-bucket rate limiter exported from daemon.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { checkRateLimit, _getRateLimitState, _clearRateLimitState } from "../src/daemon.js";
import { mintJwt } from "../src/jwt.js";

const TEST_SIGNING_KEY = "test-rate-limit-key-32-bytes!!!";

// ── Unit tests for checkRateLimit ─────────────────────────────────────────────

describe("P2-3: rate limit — checkRateLimit unit tests", () => {
  beforeEach(() => {
    _clearRateLimitState();
    delete process.env["ORAGER_RATE_LIMIT_RPM"];
  });

  afterEach(() => {
    _clearRateLimitState();
    delete process.env["ORAGER_RATE_LIMIT_RPM"];
  });

  it("request within limit: passes through", () => {
    const result = checkRateLimit("127.0.0.1", true);
    expect(result.allowed).toBe(true);
  });

  it("request exceeding /run limit: returns allowed:false with retryAfter", () => {
    process.env["ORAGER_RATE_LIMIT_RPM"] = "3"; // limit to 3 RPM for testing
    _clearRateLimitState();

    const ip = "10.0.0.1";
    // First 3 requests should pass
    expect(checkRateLimit(ip, true).allowed).toBe(true);
    expect(checkRateLimit(ip, true).allowed).toBe(true);
    expect(checkRateLimit(ip, true).allowed).toBe(true);
    // 4th request should fail
    const result = checkRateLimit(ip, true);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.retryAfter).toBeGreaterThan(0);
      expect(result.retryAfter).toBeLessThanOrEqual(60);
    }
  });

  it("non-run endpoint has 5x higher limit (default 300 vs 60)", () => {
    process.env["ORAGER_RATE_LIMIT_RPM"] = "2"; // run limit = 2, non-run = 10
    _clearRateLimitState();

    const ip = "10.0.0.2";
    // Send 2 run requests — next should fail
    checkRateLimit(ip, true);
    checkRateLimit(ip, true);
    expect(checkRateLimit(ip, true).allowed).toBe(false);

    // Use different IP for non-run
    const ip2 = "10.0.0.3";
    // Non-run limit = 10; 10 should pass, 11th should fail
    for (let i = 0; i < 10; i++) {
      expect(checkRateLimit(ip2, false).allowed).toBe(true);
    }
    expect(checkRateLimit(ip2, false).allowed).toBe(false);
  });

  it("different IPs have independent counters", () => {
    process.env["ORAGER_RATE_LIMIT_RPM"] = "1";
    _clearRateLimitState();

    expect(checkRateLimit("192.168.1.1", true).allowed).toBe(true);
    expect(checkRateLimit("192.168.1.1", true).allowed).toBe(false);

    // Different IP should still pass
    expect(checkRateLimit("192.168.1.2", true).allowed).toBe(true);
  });

  it("ORAGER_RATE_LIMIT_RPM env var is respected", () => {
    process.env["ORAGER_RATE_LIMIT_RPM"] = "5";
    _clearRateLimitState();

    const ip = "10.1.0.1";
    for (let i = 0; i < 5; i++) {
      expect(checkRateLimit(ip, true).allowed).toBe(true);
    }
    expect(checkRateLimit(ip, true).allowed).toBe(false);
  });

  it("counter resets after the window expires", async () => {
    // We can't actually wait 60s, so we manipulate the internal state
    process.env["ORAGER_RATE_LIMIT_RPM"] = "1";
    _clearRateLimitState();

    const ip = "10.2.0.1";
    checkRateLimit(ip, true); // count = 1
    expect(checkRateLimit(ip, true).allowed).toBe(false); // over limit

    // Manually expire the window by modifying internal state
    const state = _getRateLimitState();
    const entry = state.get(ip);
    if (entry) {
      entry.windowStart = Date.now() - 61_000; // push windowStart 61s back
    }

    // Should now start a new window
    expect(checkRateLimit(ip, true).allowed).toBe(true);
  });
});

// ── Integration test against a real HTTP server ───────────────────────────────

describe("P2-3: rate limit — HTTP integration", () => {
  let server: http.Server;
  let serverUrl: string;

  beforeEach(async () => {
    _clearRateLimitState();
    process.env["ORAGER_RATE_LIMIT_RPM"] = "2"; // strict limit for testing

    // Minimal server that replicates rate-limit middleware
    server = http.createServer((req, res) => {
      const ip = req.socket.remoteAddress ?? "unknown";
      const isRun = req.method === "POST" && req.url === "/run";
      const rl = checkRateLimit(ip, isRun);
      if (!rl.allowed) {
        res.writeHead(429, {
          "Content-Type": "application/json",
          "Retry-After": String(rl.retryAfter),
        });
        res.end(JSON.stringify({ error: "rate limit exceeded", retryAfter: rl.retryAfter }));
        return;
      }
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as AddressInfo;
    serverUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    _clearRateLimitState();
    delete process.env["ORAGER_RATE_LIMIT_RPM"];
  });

  async function makeRequest(endpoint: string = "/run", method: string = "POST"): Promise<{ status: number; retryAfter?: string }> {
    const res = await fetch(`${serverUrl}${endpoint}`, { method });
    return {
      status: res.status,
      retryAfter: res.headers.get("retry-after") ?? undefined,
    };
  }

  it("first requests within limit pass through (HTTP 200)", async () => {
    const r1 = await makeRequest();
    expect(r1.status).toBe(200);
    const r2 = await makeRequest();
    expect(r2.status).toBe(200);
  });

  it("request exceeding limit returns 429 with Retry-After header", async () => {
    await makeRequest(); // 1
    await makeRequest(); // 2 (at limit)
    const r = await makeRequest(); // 3 (over)
    expect(r.status).toBe(429);
    expect(r.retryAfter).toBeDefined();
    const retryAfterNum = parseInt(r.retryAfter!, 10);
    expect(retryAfterNum).toBeGreaterThan(0);
  });
});
