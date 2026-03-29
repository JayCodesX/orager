/**
 * POST /runs/:runId/cancel — abort a specific in-flight run by runId.
 */
import http from "node:http";
import type { DaemonContext } from "../context.js";

export function handleCancel(
  ctx: DaemonContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
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
