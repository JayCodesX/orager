/**
 * GET /sessions* — session listing, search, single-session, and cost endpoints.
 * All routes require a valid Bearer JWT.
 */
import http from "node:http";
import { verifyJwtDualKey } from "../context.js";
import {
  listSessions,
  searchSessions,
  loadSessionRaw,
  forkSession,
  compactSession,
} from "../../session.js";
import type { DaemonContext } from "../context.js";

export function handleSessions(
  ctx: DaemonContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const authHeader = req.headers["authorization"] ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) { res.writeHead(401); res.end(); return; }
  try { verifyJwtDualKey(ctx, token); } catch { res.writeHead(403); res.end(); return; }

  void (async () => {
    try {
      const parsedUrl = new URL(req.url!, `http://127.0.0.1`);
      const pathname = parsedUrl.pathname;

      // POST /sessions/:sessionId/compact
      const compactMatch = pathname.match(/^\/sessions\/([^/]+)\/compact$/);
      if (compactMatch && req.method === "POST") {
        const sessionId = compactMatch[1]!;
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid session id format" }));
          return;
        }
        // Optional body: { model?: string; summarizeModel?: string; summarizePrompt?: string }
        let body: { model?: string; summarizeModel?: string; summarizePrompt?: string } = {};
        const rawBody = await new Promise<string>((resolve) => {
          const chunks: Buffer[] = [];
          req.on("data", (c: Buffer) => chunks.push(c));
          req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        });
        if (rawBody.trim()) {
          try {
            body = JSON.parse(rawBody) as typeof body;
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "invalid JSON body" }));
            return;
          }
        }
        const apiKey = (process.env["PROTOCOL_API_KEY"] ?? "").trim();
        if (!apiKey) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "no API key configured" }));
          return;
        }
        const model = (typeof body.model === "string" && body.model) ? body.model : "deepseek/deepseek-chat-v3-2";
        try {
          const result = await compactSession(sessionId, apiKey, model, {
            summarizeModel: typeof body.summarizeModel === "string" ? body.summarizeModel : undefined,
            summarizePrompt: typeof body.summarizePrompt === "string" ? body.summarizePrompt : undefined,
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const notFound = msg.includes("not found");
          res.writeHead(notFound ? 404 : 500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: msg }));
        }
        return;
      }

      // POST /sessions/:sessionId/fork
      const forkMatch = pathname.match(/^\/sessions\/([^/]+)\/fork$/);
      if (forkMatch && req.method === "POST") {
        const sessionId = forkMatch[1]!;
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid session id format" }));
          return;
        }
        // Parse optional body: { atTurn?: number }
        let atTurn: number | undefined;
        const rawBody = await new Promise<string>((resolve) => {
          const chunks: Buffer[] = [];
          req.on("data", (c: Buffer) => chunks.push(c));
          req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        });
        if (rawBody.trim()) {
          try {
            const body = JSON.parse(rawBody) as { atTurn?: unknown };
            if (typeof body.atTurn === "number" && Number.isFinite(body.atTurn) && body.atTurn >= 0) {
              atTurn = Math.floor(body.atTurn);
            }
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "invalid JSON body" }));
            return;
          }
        }
        try {
          const result = await forkSession(sessionId, atTurn !== undefined ? { atTurn } : undefined);
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const notFound = msg.includes("not found");
          res.writeHead(notFound ? 404 : 500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: msg }));
        }
        return;
      }

      // GET /sessions/search?q=...&limit=20&offset=0
      if (pathname === "/sessions/search") {
        const q = parsedUrl.searchParams.get("q") ?? "";
        const limit = Math.min(parseInt(parsedUrl.searchParams.get("limit") ?? "20", 10), 100);
        const offset = Math.max(0, parseInt(parsedUrl.searchParams.get("offset") ?? "0", 10));
        if (!q.trim()) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "q parameter is required" }));
          return;
        }
        const results = await searchSessions(q.trim(), limit, offset);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ sessions: results, total: results.length, query: q, limit, offset }));
        return;
      }

      // GET /sessions/:sessionId/cost
      const sessionCostMatch = pathname.match(/^\/sessions\/([^/]+)\/cost$/);
      if (sessionCostMatch) {
        const sessionId = sessionCostMatch[1]!;
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid session id format" }));
          return;
        }
        const sessionData = await loadSessionRaw(sessionId);
        if (!sessionData) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "session not found" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          sessionId: sessionData.sessionId,
          cumulativeCostUsd: sessionData.cumulativeCostUsd ?? 0,
          lastRunAt: sessionData.updatedAt,
          runCount: sessionData.turnCount,
        }));
        return;
      }

      // GET /sessions/:sessionId
      const sessionIdMatch = pathname.match(/^\/sessions\/([^/]+)$/);
      if (sessionIdMatch) {
        const sessionId = sessionIdMatch[1]!;
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid session id format" }));
          return;
        }
        const all = await listSessions();
        const session = all.find((s) => s.sessionId === sessionId);
        if (!session) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "session not found" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(session));
        return;
      }

      // GET /sessions — paginated list
      if (pathname === "/sessions") {
        const limit = Math.min(parseInt(parsedUrl.searchParams.get("limit") ?? "50", 10), 200);
        const offset = Math.max(parseInt(parsedUrl.searchParams.get("offset") ?? "0", 10), 0);
        const all = await listSessions();
        const page = all.slice(offset, offset + limit);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ sessions: page, total: all.length, limit, offset }));
        return;
      }

      res.writeHead(404); res.end();
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
  })();
}
