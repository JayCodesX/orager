/**
 * POST /runs/:runId/cancel — abort a specific in-flight run by runId.
 */
import http from "node:http";
import { verifyJwtDualKey } from "../context.js";
import type { DaemonContext } from "../context.js";

export function handleCancel(
  ctx: DaemonContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  // Require JWT authentication (audit B-06)
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "missing bearer token" }));
    return;
  }
  const claims = verifyJwtDualKey(auth.slice(7), ctx.signingKey, ctx.previousSigningKey);
  if (!claims) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid or expired token" }));
    return;
  }

  const runId = req.url!.slice("/runs/".length, -"/cancel".length);

  // Validate UUID format to prevent path-injection attacks
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(runId)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid run id format" }));
    return;
  }

  const controller = ctx.activeRunControllers.get(runId);
  if (!controller) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "run not found" }));
    return;
  }

  controller.abort();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, runId }));
}
