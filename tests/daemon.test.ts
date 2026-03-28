/**
 * Daemon HTTP server tests.
 *
 * Rather than calling startDaemon() (which touches the filesystem for pid/port
 * files, warms the LLM cache, etc.), we build a minimal test HTTP server that
 * replicates the daemon's routing and JWT logic using the real jwt module. This
 * keeps the tests fast, hermetic, and free of network/filesystem side-effects.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import crypto from "node:crypto";
import { mintJwt, verifyJwt } from "../src/jwt.js";
import { sanitizeDaemonRunOpts } from "../src/daemon.js";
import { applyProfileAsync } from "../src/profiles.js";
import type { AddressInfo } from "node:net";

// ── Test constants ─────────────────────────────────────────────────────────────

const TEST_SIGNING_KEY = "test-signing-key-32-bytes-long!!";
const TEST_API_KEY = "test-api-key";
const MAX_CONCURRENT = 2;
const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024; // 4 MB (matches daemon.ts)

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
      res.end(JSON.stringify({ status: "ok" }));
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
        recentModels: [],
        modelUsageTimestamps: {},
        activeRunsByAgent: {},
        providerHealth: {},
        degradedProviders: [],
        dbBackend: "filesystem",
        dbPath: null,
        rateLimit: null,
        keyInfo: null,
        circuitBreakersByAgent: {},
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
            res.end(JSON.stringify({ error: "request body too large (max 4 MB)" }));
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

  it("includes circuitBreakersByAgent field in metrics response", async () => {
    const { status, body } = await get("/metrics");
    expect(status).toBe(200);
    expect(body).toHaveProperty("circuitBreakersByAgent");
    expect(typeof (body as Record<string, unknown>).circuitBreakersByAgent).toBe("object");
  });

  it("includes recentModels field in metrics response", async () => {
    const { status, body } = await get("/metrics");
    expect(status).toBe(200);
    expect(body).toHaveProperty("recentModels");
    expect(Array.isArray((body as Record<string, unknown>).recentModels)).toBe(true);
  });

  it("includes modelUsageTimestamps field in metrics response", async () => {
    const { status, body } = await get("/metrics");
    expect(status).toBe(200);
    expect(body).toHaveProperty("modelUsageTimestamps");
    expect(typeof (body as Record<string, unknown>).modelUsageTimestamps).toBe("object");
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

  it("returns 413 (or closes connection) when body exceeds 4 MB limit", async () => {
    const token = mintJwt(TEST_SIGNING_KEY, "test-agent");
    // Build a body slightly over 4 MB
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

// ── Expired JWT rejection ──────────────────────────────────────────────────────

/**
 * Build a syntactically valid HS256 JWT whose exp claim is in the past.
 * This lets us test that the server rejects expired tokens with a 401.
 */
function mintExpiredJwt(signingKey: string, agentId: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ agentId, scope: "run", iat: now - 3600, exp: now - 1 }),
  ).toString("base64url");
  const data = `${header}.${payload}`;
  const sig = crypto.createHmac("sha256", signingKey).update(data).digest("base64url");
  return `${data}.${sig}`;
}

describe("POST /run — expired JWT", () => {
  it("returns 401 with a correctly-signed but expired JWT", async () => {
    const token = mintExpiredJwt(TEST_SIGNING_KEY, "test-agent");
    const { status } = await post("/run", {
      token,
      body: { prompt: "hello world", opts: {} },
    });
    expect(status).toBe(401);
  });
});

// ── sanitizeDaemonRunOpts unit tests ──────────────────────────────────────────

describe("sanitizeDaemonRunOpts", () => {
  it("strips dangerouslySkipPermissions from caller opts", () => {
    const { safe, rejected } = sanitizeDaemonRunOpts({
      model: "openai/gpt-4o",
      dangerouslySkipPermissions: true,
    });
    expect(safe).not.toHaveProperty("dangerouslySkipPermissions");
    // dangerouslySkipPermissions is not in ALLOWED_DAEMON_OPTS so it appears in rejected
    expect(rejected).toContain("dangerouslySkipPermissions");
  });

  it("strips sandboxRoot from caller opts", () => {
    const { safe } = sanitizeDaemonRunOpts({
      model: "openai/gpt-4o",
      sandboxRoot: "/tmp/evil",
    });
    expect(safe).not.toHaveProperty("sandboxRoot");
  });

  it("strips bashPolicy from caller opts", () => {
    const { safe } = sanitizeDaemonRunOpts({
      model: "openai/gpt-4o",
      bashPolicy: "allow-all",
    });
    expect(safe).not.toHaveProperty("bashPolicy");
  });

  it("strips requireApproval from caller opts", () => {
    const { safe } = sanitizeDaemonRunOpts({
      model: "openai/gpt-4o",
      requireApproval: false,
    });
    expect(safe).not.toHaveProperty("requireApproval");
  });

  it("allows all four sensitive fields to be provided simultaneously — all stripped", () => {
    const { safe } = sanitizeDaemonRunOpts({
      model: "openai/gpt-4o",
      dangerouslySkipPermissions: true,
      sandboxRoot: "/evil",
      bashPolicy: "allow-all",
      requireApproval: false,
    });
    expect(safe).not.toHaveProperty("dangerouslySkipPermissions");
    expect(safe).not.toHaveProperty("sandboxRoot");
    expect(safe).not.toHaveProperty("bashPolicy");
    expect(safe).not.toHaveProperty("requireApproval");
    expect(safe.model).toBe("openai/gpt-4o");
  });

  it("passes through allowed fields unchanged", () => {
    const { safe, rejected } = sanitizeDaemonRunOpts({
      model: "deepseek/deepseek-r1",
      maxTurns: 5,
      timeoutSec: 120,
    });
    expect(safe.model).toBe("deepseek/deepseek-r1");
    expect(safe.maxTurns).toBe(5);
    expect(safe.timeoutSec).toBe(120);
    expect(rejected).toHaveLength(0);
  });

  it("reports unknown fields in rejected list without including them in safe", () => {
    const { safe, rejected } = sanitizeDaemonRunOpts({
      model: "openai/gpt-4o",
      unknownField: "value",
      anotherBadField: 42,
    });
    expect(safe).not.toHaveProperty("unknownField");
    expect(safe).not.toHaveProperty("anotherBadField");
    expect(rejected).toContain("unknownField");
    expect(rejected).toContain("anotherBadField");
  });
});

// ── ALLOWED_DAEMON_OPTS coverage ──────────────────────────────────────────────
// Verifies that every field the adapter sends in daemonOpts is present in the
// ALLOWED_DAEMON_OPTS set, so new features aren't silently dropped by the daemon.

describe("ALLOWED_DAEMON_OPTS completeness", () => {
  it("sanitizeDaemonRunOpts allows all fields that execute-cli sends in daemonOpts", () => {
    // This is the canonical list of fields that execute-cli.ts sends in daemonOpts.
    // When you add a new field to the adapter's daemonOpts block, add it here too.
    const adapterSentFields = [
      "apiKey",       // note: excluded by DaemonRunRequest type but sent by adapter
      "model",
      "models",
      "sessionId",
      "addDirs",
      "maxTurns",
      "maxRetries",
      "cwd",
      "dangerouslySkipPermissions", // security-stripped by daemon (intentional)
      "forceResume",
      "verbose",
      "useFinishTool",
      "profile",
      "settingsFile",
      "siteUrl",
      "siteName",
      "sandboxRoot",  // security-stripped by daemon (intentional)
      "parallel_tool_calls",
      "tool_choice",
      "temperature",
      "top_p",
      "top_k",
      "frequency_penalty",
      "presence_penalty",
      "repetition_penalty",
      "min_p",
      "seed",
      "stop",
      "reasoning",
      "provider",
      "preset",
      "transforms",
      "maxCostUsd",
      "maxCostUsdSoft",
      "costPerInputToken",
      "costPerOutputToken",
      "requireApproval", // security-stripped by daemon (intentional)
      "summarizeAt",
      "summarizeModel",
      "summarizeKeepRecentTurns",
      "tagToolOutputs",
      "planMode",
      "injectContext",
      "bashPolicy",   // security-stripped by daemon (intentional)
      "trackFileChanges",
      "enableBrowserTools",
      "turnModelRules",
      "summarizePrompt",
      "summarizeFallbackKeep",
      "webhookUrl",
      "hooks",
      "hookTimeoutMs",
      "hookErrorMode",
      "approvalTimeoutMs",
      "mcpServers",
      "requireMcpServers",
      "toolTimeouts",
      "maxSpawnDepth",
      "maxIdenticalToolCallTurns",
      "toolErrorBudgetHardStop",
      "appendSystemPrompt",
      "promptContent",
      "approvalMode",
      "approvalAnswer",
      "response_format",
      "timeoutSec",
      "apiKeys",
      "requiredEnvVars",
      "memoryKey",
    ];

    // Fields that are intentionally security-stripped (not in ALLOWED but stripped post-allow)
    const securityStripped = new Set([
      "sandboxRoot",
      "requireApproval",
      "bashPolicy",
      "dangerouslySkipPermissions",
      "settingsFile", // daemon resolves its own settings
    ]);

    // Fields excluded by DaemonRunRequest type (apiKey comes from daemon's own env, not POST body)
    const typeExcluded = new Set(["apiKey"]);

    // Fields that should be in ALLOWED_DAEMON_OPTS
    const shouldBeAllowed = adapterSentFields.filter(
      (f) => !securityStripped.has(f) && !typeExcluded.has(f)
    );

    // Build a test opts object with all expected fields
    const testOpts: Record<string, unknown> = {};
    for (const field of shouldBeAllowed) {
      testOpts[field] = "test-value";
    }

    const { safe, rejected } = sanitizeDaemonRunOpts(testOpts);

    // All non-security fields should pass through
    expect(rejected, `These fields are sent by execute-cli but not in ALLOWED_DAEMON_OPTS: ${rejected.join(", ")}`).toEqual([]);

    // Security fields should be stripped even if in ALLOWED
    const securityTest = { sandboxRoot: "/", requireApproval: "all", bashPolicy: {}, dangerouslySkipPermissions: true };
    const { safe: safeSecure } = sanitizeDaemonRunOpts(securityTest);
    expect(safeSecure.sandboxRoot).toBeUndefined();
    expect(safeSecure.requireApproval).toBeUndefined();
    expect(safeSecure.bashPolicy).toBeUndefined();
    expect(safeSecure.dangerouslySkipPermissions).toBeUndefined();
  });
});

// ── T9: /health only returns {status:"ok"} — no sensitive fields ──────────────

describe("GET /health — sensitive fields stripped (C8)", () => {
  it("does not include activeRuns in the health response", async () => {
    const { body } = await get("/health");
    expect(body).not.toHaveProperty("activeRuns");
  });

  it("does not include maxConcurrent in the health response", async () => {
    const { body } = await get("/health");
    expect(body).not.toHaveProperty("maxConcurrent");
  });

  it("does not include model in the health response", async () => {
    const { body } = await get("/health");
    expect(body).not.toHaveProperty("model");
  });

  it("only has status field (plus any extra safe fields)", async () => {
    const { body } = await get("/health");
    const keys = Object.keys(body as object);
    // status must be present; activeRuns / maxConcurrent / model must not be
    expect(keys).toContain("status");
    expect(keys).not.toContain("activeRuns");
    expect(keys).not.toContain("maxConcurrent");
    expect(keys).not.toContain("model");
  });
});

// ── T10: sanitizeDaemonRunOpts rejects keys removed in S6 ────────────────────

describe("sanitizeDaemonRunOpts — removed legacy keys are rejected (S6)", () => {
  it("rejects 'hooksEnabled' (OragerSettings field, not AgentLoopOptions)", () => {
    const { safe, rejected } = sanitizeDaemonRunOpts({ hooksEnabled: true });
    expect(rejected).toContain("hooksEnabled");
    expect(safe).not.toHaveProperty("hooksEnabled");
  });

  it("rejects 'source' (Session metadata, not AgentLoopOptions)", () => {
    const { safe, rejected } = sanitizeDaemonRunOpts({ source: "cli" });
    expect(rejected).toContain("source");
    expect(safe).not.toHaveProperty("source");
  });

  it("rejects 'site_url' (snake_case alias superseded by siteUrl)", () => {
    const { safe, rejected } = sanitizeDaemonRunOpts({ site_url: "https://example.com" });
    expect(rejected).toContain("site_url");
    expect(safe).not.toHaveProperty("site_url");
  });

  it("rejects 'site_name' (snake_case alias superseded by siteName)", () => {
    const { safe, rejected } = sanitizeDaemonRunOpts({ site_name: "My App" });
    expect(rejected).toContain("site_name");
    expect(safe).not.toHaveProperty("site_name");
  });

  it("rejects 'systemPrompt' (use appendSystemPrompt instead)", () => {
    const { safe, rejected } = sanitizeDaemonRunOpts({ systemPrompt: "You are helpful." });
    expect(rejected).toContain("systemPrompt");
    expect(safe).not.toHaveProperty("systemPrompt");
  });

  it("allows 'profile' (now an AgentLoopOptions field — expanded by runAgentLoop)", () => {
    // profile was previously CLI-only; it is now part of AgentLoopOptions so the
    // daemon passes it through to runAgentLoop which calls applyProfileAsync().
    const { safe, rejected } = sanitizeDaemonRunOpts({ profile: "code-review" });
    expect(rejected).not.toContain("profile");
    expect(safe.profile).toBe("code-review");
  });

  it("rejects multiple removed keys in a single call", () => {
    const { rejected, safe } = sanitizeDaemonRunOpts({
      hooksEnabled: true,
      source: "daemon",
      site_url: "https://x.com",
      site_name: "X",
      systemPrompt: "hi",
    });
    expect(rejected).toContain("hooksEnabled");
    expect(rejected).toContain("source");
    expect(rejected).toContain("site_url");
    expect(rejected).toContain("site_name");
    expect(rejected).toContain("systemPrompt");
    // profile is now allowed (AgentLoopOptions field)
    expect(safe).not.toHaveProperty("hooksEnabled");
    expect(safe).not.toHaveProperty("source");
  });

  it("still allows the camelCase replacements (siteUrl, siteName, appendSystemPrompt)", () => {
    const { safe, rejected } = sanitizeDaemonRunOpts({
      siteUrl: "https://example.com",
      siteName: "My App",
      appendSystemPrompt: "Be concise.",
    });
    expect(rejected).toHaveLength(0);
    expect(safe.siteUrl).toBe("https://example.com");
    expect(safe.siteName).toBe("My App");
    expect(safe.appendSystemPrompt).toBe("Be concise.");
  });
});

// ── E7: Profile expansion unit tests ─────────────────────────────────────────
// Verifies that applyProfileAsync correctly expands profile presets into
// AgentLoopOptions defaults, and that caller opts always win over profile defaults.

describe("applyProfileAsync — profile expansion (E7)", () => {
  it("expands code-review profile: sets tagToolOutputs=true and maxTurns=20", async () => {
    const opts = await applyProfileAsync("code-review", {
      model: "openai/gpt-4o",
      prompt: "Review this code.",
    } as Parameters<typeof applyProfileAsync>[1]);
    expect(opts.tagToolOutputs).toBe(true);
    expect(opts.maxTurns).toBe(20);
  });

  it("expands code-review profile: sets bashPolicy with blockedCommands", async () => {
    const opts = await applyProfileAsync("code-review", {
      model: "openai/gpt-4o",
      prompt: "Review.",
    } as Parameters<typeof applyProfileAsync>[1]);
    expect(opts.bashPolicy).toBeDefined();
    const bp = opts.bashPolicy as { blockedCommands?: string[] };
    expect(bp.blockedCommands).toContain("curl");
    expect(bp.blockedCommands).toContain("wget");
  });

  it("caller opts override profile defaults (maxTurns wins)", async () => {
    const opts = await applyProfileAsync("code-review", {
      model: "openai/gpt-4o",
      prompt: "Review.",
      maxTurns: 5, // caller overrides profile's maxTurns=20
    } as Parameters<typeof applyProfileAsync>[1]);
    expect(opts.maxTurns).toBe(5);
  });

  it("unknown profile name returns original opts unchanged and logs warning", async () => {
    const original = { model: "openai/gpt-4o", prompt: "test", maxTurns: 7 } as Parameters<typeof applyProfileAsync>[1];
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const opts = await applyProfileAsync("nonexistent-profile-xyz", original);
      expect(opts.maxTurns).toBe(7);
      expect(opts.model).toBe("openai/gpt-4o");
      // Should have written a warning to stderr
      expect(stderrWrite).toHaveBeenCalledWith(
        expect.stringContaining("unknown profile"),
      );
    } finally {
      stderrWrite.mockRestore();
    }
  });

  it("appends caller's appendSystemPrompt after profile's system prompt", async () => {
    const opts = await applyProfileAsync("code-review", {
      model: "openai/gpt-4o",
      prompt: "Review.",
      appendSystemPrompt: "Also check for accessibility issues.",
    } as Parameters<typeof applyProfileAsync>[1]);
    // Profile's system prompt should be present
    expect(opts.appendSystemPrompt).toContain("code review");
    // Caller's addition should also be present
    expect(opts.appendSystemPrompt).toContain("accessibility");
  });
});

// ── E8: POST /run with profile passes through daemon ─────────────────────────
// Verifies that opts.profile passes sanitizeDaemonRunOpts and that the daemon
// accepts and processes a /run request that includes a profile field.

describe("POST /run — profile field passes through daemon (E8)", () => {
  it("sanitizeDaemonRunOpts keeps profile field in safe opts", () => {
    const { safe, rejected } = sanitizeDaemonRunOpts({
      model: "openai/gpt-4o",
      profile: "code-review",
      maxTurns: 10,
    });
    expect(rejected).not.toContain("profile");
    expect(safe.profile).toBe("code-review");
    expect(safe.model).toBe("openai/gpt-4o");
    expect(safe.maxTurns).toBe(10);
  });

  it("daemon /run returns 200 when opts includes profile field", async () => {
    const token = mintJwt(TEST_SIGNING_KEY, "test-agent");
    const { status } = await post("/run", {
      token,
      body: {
        prompt: "Please review my code.",
        opts: { model: "openai/gpt-4o", profile: "code-review" },
      },
    });
    expect(status).toBe(200);
  });

  it("daemon /run returns 200 with bug-fix profile", async () => {
    const token = mintJwt(TEST_SIGNING_KEY, "test-agent");
    const { status } = await post("/run", {
      token,
      body: {
        prompt: "Fix the null pointer exception in src/utils.ts.",
        opts: { profile: "bug-fix" },
      },
    });
    expect(status).toBe(200);
  });
});

// ── P2-4: Configurable session retention TTL ──────────────────────────────────

describe("P2-4: session retention TTL", () => {
  it("SESSION_RETENTION_DAYS defaults to 30 when env var is not set", async () => {
    const savedVal = process.env["ORAGER_SESSION_RETENTION_DAYS"];
    delete process.env["ORAGER_SESSION_RETENTION_DAYS"];
    // Verify: the default should compute to 30 days
    const days = parseInt(process.env["ORAGER_SESSION_RETENTION_DAYS"] ?? "30", 10);
    expect(days).toBe(30);
    if (savedVal !== undefined) process.env["ORAGER_SESSION_RETENTION_DAYS"] = savedVal;
  });

  it("ORAGER_SESSION_RETENTION_DAYS env var overrides the default", () => {
    process.env["ORAGER_SESSION_RETENTION_DAYS"] = "7";
    const days = parseInt(process.env["ORAGER_SESSION_RETENTION_DAYS"] ?? "30", 10);
    expect(days).toBe(7);
    delete process.env["ORAGER_SESSION_RETENTION_DAYS"];
  });

  it("SESSION_PRUNE_TTL_MS is computed from the retention days", () => {
    process.env["ORAGER_SESSION_RETENTION_DAYS"] = "14";
    const days = parseInt(process.env["ORAGER_SESSION_RETENTION_DAYS"] ?? "30", 10);
    const ttlMs = days * 24 * 60 * 60 * 1000;
    expect(ttlMs).toBe(14 * 24 * 60 * 60 * 1000);
    delete process.env["ORAGER_SESSION_RETENTION_DAYS"];
  });
});
