/**
 * GET /health — deep health check for the daemon process.
 *
 * Checks: signing key file readable, sessions dir writable, SQLite DB (if configured),
 * and HTTP MCP server reachability (if mcpServers with URL transport are configured).
 * No authentication required — intentionally minimal info to prevent leaking
 * internal state to unauthenticated callers.
 */
import http from "node:http";
import path from "node:path";
import fsSync from "node:fs";
import { KEY_PATH } from "../../jwt.js";
import { getSessionsDir } from "../../session.js";
import { loadClaudeDesktopMcpServers } from "../../settings.js";
import type { DaemonContext } from "../context.js";

export function handleHealth(
  _ctx: DaemonContext,
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
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

    // Check 4: HTTP MCP server reachability — ping each configured URL-based server.
    // stdio-transport MCP servers are spawned per-run and not checked here.
    // Non-fatal: MCP failures mark the daemon degraded but don't prevent runs.
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
              // Any response (even 4xx) means the server is reachable
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
      // Settings load failed — non-fatal, skip MCP check
      checks["mcp"] = "n/a";
    }

    if (failures.length === 0) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", checks }));
    } else {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "degraded", reason: failures.join(","), checks }));
    }
  })();
}
