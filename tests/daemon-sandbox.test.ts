/**
 * Tests for the allowedCwdPrefixes sandbox enforcement in
 * src/daemon/routes/run.ts (lines 122–140).
 *
 * The guard:
 *   1. Is only active when allowedCwdPrefixes is set AND non-empty.
 *   2. Calls fs.realpath() on the requested cwd — falls back to raw value if
 *      realpath throws (non-existent path).
 *   3. Allows cwd that exactly equals a prefix, or starts with prefix + "/".
 *   4. Returns 403 with error message when cwd is not within any allowed prefix.
 *
 * Uses a minimal in-process HTTP server that replicates the exact same guard
 * logic, driven via shared mutable `allowedCwdPrefixes` state.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import type { AddressInfo } from "node:net";
import { mintJwt, verifyJwt } from "../src/jwt.js";

const SIGNING_KEY = "sandbox-test-signing-key-32bytes";

// Mutable config controlled per-test
let allowedCwdPrefixes: string[] | undefined = undefined;

function createSandboxServer(): http.Server {
  return http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/run") {
      res.writeHead(404); res.end(); return;
    }

    const authHeader = req.headers["authorization"] ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) { res.writeHead(401); res.end(); return; }
    try { verifyJwt(token, SIGNING_KEY); } catch { res.writeHead(401); res.end(); return; }

    let body = "";
    req.on("data", (c: Buffer) => { body += c.toString(); });
    req.on("end", () => {
      void (async () => {
        let runReq: { prompt?: string; opts?: Record<string, unknown> };
        try { runReq = JSON.parse(body) as typeof runReq; } catch {
          res.writeHead(400); res.end(JSON.stringify({ error: "bad json" })); return;
        }

        // ── allowedCwdPrefixes enforcement (exact replica of run.ts logic) ──
        if (allowedCwdPrefixes && allowedCwdPrefixes.length > 0) {
          const reqCwd = (runReq.opts?.cwd as string | undefined) ?? "";
          let canonicalCwd = reqCwd;
          try {
            canonicalCwd = await fs.realpath(reqCwd);
          } catch {
            canonicalCwd = reqCwd;
          }
          const allowed = allowedCwdPrefixes.some(
            (prefix) => canonicalCwd === prefix || canonicalCwd.startsWith(prefix + "/"),
          );
          if (!allowed) {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: `cwd '${reqCwd}' is not within an allowed prefix` }));
            return;
          }
        }

        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        res.end(
          JSON.stringify({
            type: "result", subtype: "success", result: "ok",
            session_id: "test", finish_reason: "stop",
            usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
            total_cost_usd: 0,
          }) + "\n",
        );
      })();
    });
  });
}

let server: http.Server;
let baseUrl: string;
const TOKEN = mintJwt(SIGNING_KEY, "test-agent");

// Canonical (symlink-resolved) tmp dir — on macOS /tmp → /private/tmp.
// Using the canonical path ensures realpath() in the handler produces a value
// that actually matches the allowed prefix.
let REAL_TMP: string;

beforeAll(async () => {
  REAL_TMP = await fs.realpath(os.tmpdir());
  server = createSandboxServer();
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

async function postRun(
  cwd: string | undefined,
  prefixes: string[] | undefined,
): Promise<{ status: number; body: Record<string, unknown> }> {
  allowedCwdPrefixes = prefixes;
  const res = await fetch(`${baseUrl}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ prompt: "hello", opts: cwd !== undefined ? { cwd } : {} }),
  });
  const body = await res.json().catch(() => ({})) as Record<string, unknown>;
  return { status: res.status, body };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("allowedCwdPrefixes — enforcement active", () => {
  it("returns 200 when cwd is a sub-directory of an allowed prefix", async () => {
    // Use canonical tmpdir so realpath in the handler matches the prefix
    const { status } = await postRun(`${REAL_TMP}/my-project`, [REAL_TMP]);
    expect(status).toBe(200);
  });

  it("returns 200 when cwd exactly equals an allowed prefix", async () => {
    // Pass the already-canonical path — realpath returns it unchanged → exact match
    const { status } = await postRun(REAL_TMP, [REAL_TMP]);
    expect(status).toBe(200);
  });

  it("returns 403 when cwd is outside all allowed prefixes", async () => {
    const { status, body } = await postRun("/orager-test-outside/project", [REAL_TMP]);
    expect(status).toBe(403);
    expect((body as { error: string }).error).toMatch(/not within an allowed prefix/);
  });

  it("returns 403 for a path that shares a prefix string but lacks the separator (path-traversal guard)", async () => {
    // e.g. REAL_TMP="/private/tmp" — "/private/tmpevil" must NOT pass
    const { status } = await postRun(`${REAL_TMP}evil/project`, [REAL_TMP]);
    expect(status).toBe(403);
  });

  it("returns 403 when opts.cwd is absent and prefix list is non-empty", async () => {
    // empty string "" does not start with REAL_TMP + "/"
    allowedCwdPrefixes = [REAL_TMP];
    const res = await fetch(`${baseUrl}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ prompt: "hello", opts: {} }), // no cwd field
    });
    expect(res.status).toBe(403);
  });

  it("allows cwd under any of multiple allowed prefixes", async () => {
    const { status } = await postRun(`${REAL_TMP}/subdir`, ["/orager-test-other", REAL_TMP]);
    expect(status).toBe(200);
  });

  it("falls back to raw cwd when realpath throws (non-existent path) — still enforces prefix check", async () => {
    // /orager-nonexistent-xyz doesn't exist → realpath throws → raw path used → not in [REAL_TMP]
    const { status } = await postRun("/orager-nonexistent-xyz/work", [REAL_TMP]);
    expect(status).toBe(403);
  });
});

describe("allowedCwdPrefixes — enforcement inactive", () => {
  it("returns 200 for any cwd when allowedCwdPrefixes is undefined", async () => {
    const { status } = await postRun("/home/user/anywhere", undefined);
    expect(status).toBe(200);
  });

  it("returns 200 for any cwd when allowedCwdPrefixes is an empty array", async () => {
    const { status } = await postRun("/home/user/anywhere", []);
    expect(status).toBe(200);
  });
});
