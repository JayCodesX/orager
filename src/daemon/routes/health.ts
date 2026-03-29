/**
 * GET /health — deep health check for the daemon process.
 *
 * Checks: signing key file readable, sessions dir writable, SQLite DB (if configured).
 * No authentication required — intentionally minimal info to prevent leaking
 * internal state to unauthenticated callers.
 */
import http from "node:http";
import path from "node:path";
import fsSync from "node:fs";
import { KEY_PATH } from "../../jwt.js";
import { getSessionsDir } from "../../session.js";
import type { DaemonContext } from "../context.js";

export function handleHealth(
  _ctx: DaemonContext,
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  void (async () => {
    const checks: Record<string, "ok" | "error"> = {};
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
      (checks as Record<string, string>)["db"] = "n/a";
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
