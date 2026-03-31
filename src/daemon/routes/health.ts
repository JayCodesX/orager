/**
 * GET /health       — minimal public health check (no auth required).
 * GET /health/detail — deep health check (JWT-authenticated, audit E-06).
 *
 * The public endpoint returns only {"status":"ok"} to avoid leaking internal
 * details. The authenticated detail endpoint runs full subsystem checks.
 */
import http from "node:http";
import path from "node:path";
import fsSync from "node:fs";
import { KEY_PATH } from "../../jwt.js";
import { getSessionsDir } from "../../session.js";
import { loadClaudeDesktopMcpServers } from "../../settings.js";
import { verifyJwtDualKey } from "../context.js";
import type { DaemonContext } from "../context.js";

/**
 * GET /health — public, no auth. Returns only status to prevent leaking
 * internal state to unauthenticated callers on the loopback interface.
 */
export function handleHealth(
  _ctx: DaemonContext,
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "ok" }));
}

/**
 * GET /health/detail — authenticated deep health check (audit E-06).
 * Runs subsystem checks and returns detailed results.
 */
export function handleHealthDetail(
  ctx: DaemonContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const authHeader = req.headers["authorization"] ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) { res.writeHead(401); res.end(); return; }
  try {
    verifyJwtDualKey(ctx, token);
  } catch {
    res.writeHead(403); res.end(); return;
  }

  void (async () => {
    const checks: Record<string, "ok" | "error" | "n/a"> = {};
    const failures: string[] = [];

    // Check 1: signing key readable
    try {
      fsSync.accessSync(KEY_PATH, fsSync.constants.R_OK);
      checks["keyFile"] = "ok";
    } catch {
      checks["keyFile"] = "error";
      failures.push("keyFile");
    }

    // Check 2: sessions dir writable — write + delete a temp file
    try {
      const sessDir = getSessionsDir();
      const tmpPath = path.join(sessDir, `.health-check-${process.pid}`);
      fsSync.writeFileSync(tmpPath, "1");
      fsSync.unlinkSync(tmpPath);
      checks["sessionsDir"] = "ok";
    } catch {
      checks["sessionsDir"] = "error";
      failures.push("sessionsDir");
    }

    // Check 3: if ORAGER_DB_PATH set, run SELECT 1 via WASM SQLite
    const dbPath = process.env["ORAGER_DB_PATH"];
    if (dbPath) {
      try {
        const { openWasmDb } = await import("../../wasm-sqlite.js");
        const db = openWasmDb(dbPath, { readonly: true });
        db.prepare("SELECT 1").get();
        db.close();
        checks["db"] = "ok";
      } catch {
        checks["db"] = "error";
        failures.push("db");
      }
    } else {
      checks["db"] = "n/a";
    }

    // Check 4: HTTP MCP server reachability
    try {
      const mcpServers = await loadClaudeDesktopMcpServers();
      const httpServers = Object.entries(mcpServers).filter(([, cfg]) => "url" in cfg);
      if (httpServers.length > 0) {
        const mcpChecks: Record<string, "ok" | "error"> = {};
        await Promise.all(
          httpServers.map(async ([name, cfg]) => {
            const url = (cfg as { url: string }).url;
            try {
              const ctrl = new AbortController();
              const timer = setTimeout(() => ctrl.abort(), 3_000);
              const r = await fetch(url, { method: "GET", signal: ctrl.signal }).finally(() => clearTimeout(timer));
              mcpChecks[name] = r.status < 600 ? "ok" : "error";
            } catch {
              mcpChecks[name] = "error";
              failures.push(`mcp:${name}`);
            }
          }),
        );
        checks["mcp"] = Object.values(mcpChecks).every((v) => v === "ok") ? "ok" : "error";
        (checks as Record<string, unknown>)["mcpDetails"] = mcpChecks;
      } else {
        checks["mcp"] = "n/a";
      }
    } catch {
      checks["mcp"] = "n/a";
    }

    const statusCode = failures.length === 0 ? 200 : 503;
    const status = failures.length === 0 ? "ok" : "degraded";
    res.writeHead(statusCode, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status,
      ...(failures.length > 0 ? { reason: failures.join(",") } : {}),
      checks,
      uptimeMs: Date.now() - ctx.daemonStartedAt,
      activeRuns: ctx.activeRuns,
    }));
  })();
}
