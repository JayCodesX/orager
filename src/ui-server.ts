/**
 * orager UI server — standalone HTTP server for browser-based configuration.
 *
 * Start with: orager ui [--port 3457]
 *
 * Binds to 127.0.0.1 only. No authentication required (local-only).
 * Serves a React SPA from dist/ui/ and exposes /api/* routes for
 * reading and writing ~/.orager/config.json and ~/.orager/settings.json.
 *
 * The daemon (orager --serve) is a completely separate process.
 */
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import type { OragerUserConfig } from "./setup.js";
import { DEFAULT_CONFIG } from "./setup.js";
import type { OragerSettings } from "./settings.js";
import { mintJwt, KEY_PATH } from "./jwt.js";
import { getSpanBuffer, type BufferedSpan } from "./telemetry.js";
import { isBlockedHost } from "./tools/web-fetch.js";
import { formatDiscordPayload } from "./loop-helpers.js";
import split2 from "split2";

// ── Paths ─────────────────────────────────────────────────────────────────────

const ORAGER_DIR = path.join(os.homedir(), ".orager");
const CONFIG_PATH = path.join(ORAGER_DIR, "config.json");
const SETTINGS_PATH = path.join(ORAGER_DIR, "settings.json");
const UI_PORT_PATH = path.join(ORAGER_DIR, "ui.port");
const UI_PID_PATH = path.join(ORAGER_DIR, "ui.pid");
const DAEMON_PORT_PATH = path.join(ORAGER_DIR, "daemon.port");
const DAEMON_PID_PATH = path.join(ORAGER_DIR, "daemon.pid");
const DEFAULT_LOG_PATH = path.join(ORAGER_DIR, "orager.log");

/** Random bearer token generated at startup — printed to stdout for the user. */
const UI_AUTH_TOKEN = crypto.randomBytes(24).toString("hex");

// ── Single-instance PID lock (mirrors daemon.ts pattern) ─────────────────────

async function acquireUiPidLock(port: number): Promise<void> {
  await fs.mkdir(ORAGER_DIR, { recursive: true });
  const pidData = JSON.stringify({ pid: process.pid, port });

  // Attempt exclusive atomic write first — succeeds if no lock file exists
  try {
    await fs.writeFile(UI_PID_PATH, pidData, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return;
  } catch (writeErr) {
    if ((writeErr as NodeJS.ErrnoException).code !== "EEXIST") throw writeErr;
  }

  // File exists — check if the existing process is still alive
  try {
    const existing = await fs.readFile(UI_PID_PATH, "utf8");
    const parsed = JSON.parse(existing) as { pid: number; port: number };
    try {
      process.kill(parsed.pid, 0); // signal 0 = existence check, no signal sent
      throw new Error(
        `orager ui is already running (pid ${parsed.pid}, port ${parsed.port}).\n` +
        `  Stop it first, or remove ${UI_PID_PATH} if the process is stale.`,
      );
    } catch (killErr) {
      // ESRCH = no such process → stale lock, fall through to reclaim
      if ((killErr as NodeJS.ErrnoException).code !== "ESRCH") throw killErr;
    }
  } catch (readErr) {
    if ((readErr as Error).message.startsWith("orager ui is already running")) throw readErr;
    // Unreadable/invalid PID file — treat as stale
  }

  // Stale lock — remove and reclaim
  await fs.unlink(UI_PID_PATH).catch(() => {});
  try {
    await fs.writeFile(UI_PID_PATH, pidData, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch {
    // Race condition — another process grabbed it
    const existing2 = await fs.readFile(UI_PID_PATH, "utf8").catch(() => "{}");
    const parsed2 = JSON.parse(existing2) as { pid?: number; port?: number };
    if (parsed2.pid && parsed2.pid !== process.pid) {
      throw new Error(
        `orager ui is already running (pid ${parsed2.pid}, port ${parsed2.port ?? "?"}).`,
      );
    }
  }
}

async function releaseUiPidLock(): Promise<void> {
  await fs.unlink(UI_PID_PATH).catch(() => {});
}

// Static files live at dist/ui/ relative to this compiled file (dist/ui-server.js)
const DIST_DIR = path.dirname(fileURLToPath(import.meta.url));
const UI_STATIC_DIR = path.join(DIST_DIR, "ui");

// ── MIME types ────────────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".ico":  "image/x-icon",
  ".woff2": "font/woff2",
  ".woff":  "font/woff",
  ".ttf":   "font/ttf",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function jsonResponse(
  res: http.ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 512 * 1024) {
        req.destroy();
        reject(new Error("Request body too large (max 512 KB)"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = filePath + ".tmp." + process.pid;
  await fs.writeFile(tmp, content, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, filePath);
}

function stripSecrets<T extends object>(obj: T, keys: string[]): T {
  const lowerKeys = keys.map((k) => k.toLowerCase());
  const result = { ...obj } as Record<string, unknown>;
  for (const key of Object.keys(result)) {
    if (lowerKeys.some((k) => key.toLowerCase().includes(k))) {
      delete result[key];
    }
  }
  return result as T;
}

// ── Config API ────────────────────────────────────────────────────────────────

async function loadConfig(): Promise<OragerUserConfig> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) as OragerUserConfig };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

async function handleGetConfig(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const config = await loadConfig();
  // Never expose agentApiKey to the browser
  const safe = stripSecrets(config, ["agentApiKey", "key", "token", "secret"]);
  jsonResponse(res, 200, safe);
}

async function handlePostConfig(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    jsonResponse(res, 400, { error: (err as Error).message });
    return;
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    jsonResponse(res, 400, { error: "Body must be a JSON object" });
    return;
  }

  // Load existing config so we preserve fields not included in the POST body
  // (e.g. agentApiKey which is stripped from GET responses)
  const existing = await loadConfig();
  const incoming = body as Record<string, unknown>;

  // Reject any attempt to set agentApiKey through the UI for safety
  delete incoming["agentApiKey"];

  const merged: OragerUserConfig = { ...existing, ...incoming };
  await atomicWrite(CONFIG_PATH, JSON.stringify(merged, null, 2));
  const safe = stripSecrets(merged, ["agentApiKey", "key", "token", "secret"]);
  jsonResponse(res, 200, safe);
}

async function handleGetConfigDefaults(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  jsonResponse(res, 200, DEFAULT_CONFIG);
}

// ── Settings API ──────────────────────────────────────────────────────────────

async function loadSettingsRaw(): Promise<OragerSettings> {
  try {
    const raw = await fs.readFile(SETTINGS_PATH, "utf8");
    return JSON.parse(raw) as OragerSettings;
  } catch {
    return {};
  }
}

async function handleGetSettings(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const settings = await loadSettingsRaw();
  jsonResponse(res, 200, settings);
}

async function handlePostSettings(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    jsonResponse(res, 400, { error: (err as Error).message });
    return;
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    jsonResponse(res, 400, { error: "Body must be a JSON object" });
    return;
  }

  const existing = await loadSettingsRaw();
  const merged: OragerSettings = { ...existing, ...(body as OragerSettings) };
  await atomicWrite(SETTINGS_PATH, JSON.stringify(merged, null, 2));
  jsonResponse(res, 200, merged);
}

// ── Daemon proxy helpers ──────────────────────────────────────────────────────

async function readDaemonPort(): Promise<number | null> {
  try {
    const raw = await fs.readFile(DAEMON_PORT_PATH, "utf8");
    const port = parseInt(raw.trim(), 10);
    return isNaN(port) ? null : port;
  } catch {
    return null;
  }
}

async function readDaemonPid(): Promise<number | null> {
  try {
    const raw = await fs.readFile(DAEMON_PID_PATH, "utf8");
    const pid = parseInt(raw.trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

async function buildInternalJwt(): Promise<string | null> {
  try {
    const key = await fs.readFile(KEY_PATH, "utf8");
    return mintJwt(key.trim(), "orager-ui");
  } catch {
    return null;
  }
}

/** Recursively strip any key whose name contains a secret-sounding substring. */
function deepStripSecrets(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) return value.map(deepStripSecrets);
  const SECRET_KEYS = ["key", "token", "secret", "apikey", "password", "credential"];
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const lower = k.toLowerCase();
    if (SECRET_KEYS.some((s) => lower.includes(s))) continue;
    result[k] = deepStripSecrets(v);
  }
  return result;
}

async function proxyDaemon(
  port: number,
  pathname: string,
  jwt: string,
  queryString?: string,
): Promise<{ status: number; body: unknown }> {
  const url = `http://127.0.0.1:${port}${pathname}${queryString ? `?${queryString}` : ""}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${jwt}` },
    signal: AbortSignal.timeout(3000),
  });
  const body = await res.json();
  return { status: res.status, body };
}

// ── Daemon API routes ─────────────────────────────────────────────────────────

async function handleDaemonStatus(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const port = await readDaemonPort();
  if (!port) {
    jsonResponse(res, 200, { running: false, port: null, pid: null });
    return;
  }
  const pid = await readDaemonPid();
  try {
    const healthRes = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    const health = await healthRes.json();
    jsonResponse(res, 200, { running: healthRes.ok, port, pid, health });
  } catch {
    jsonResponse(res, 200, { running: false, port, pid, health: null, error: "daemon not responding" });
  }
}

async function handleDaemonMetrics(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const port = await readDaemonPort();
  if (!port) { jsonResponse(res, 200, { running: false }); return; }
  const jwt = await buildInternalJwt();
  if (!jwt) { jsonResponse(res, 503, { error: "daemon key not available" }); return; }
  try {
    const { status, body } = await proxyDaemon(port, "/metrics", jwt);
    jsonResponse(res, status, deepStripSecrets(body));
  } catch {
    jsonResponse(res, 503, { error: "daemon not responding" });
  }
}

async function handleDaemonSessions(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const port = await readDaemonPort();
  if (!port) { jsonResponse(res, 200, { running: false, sessions: [], total: 0 }); return; }
  const jwt = await buildInternalJwt();
  if (!jwt) { jsonResponse(res, 503, { error: "daemon key not available" }); return; }
  const qs = new URL(req.url ?? "/", "http://localhost").search.slice(1);
  try {
    const { status, body } = await proxyDaemon(port, "/sessions", jwt, qs);
    jsonResponse(res, status, body);
  } catch {
    jsonResponse(res, 503, { error: "daemon not responding" });
  }
}

// ── Logs API ──────────────────────────────────────────────────────────────────

interface LogEntry {
  ts?: string;
  level?: string;
  event?: string;
  sessionId?: string;
  agentId?: string;
  model?: string;
  [key: string]: unknown;
}

async function handleGetLogs(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const logFile = process.env["ORAGER_LOG_FILE"] ?? DEFAULT_LOG_PATH;
  if (!fsSync.existsSync(logFile)) {
    jsonResponse(res, 200, { entries: [], total: 0, configured: true, logFile });
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  const q      = url.searchParams.get("q")?.toLowerCase() ?? "";
  const level  = url.searchParams.get("level") ?? "";
  const from   = url.searchParams.get("from") ?? "";
  const to     = url.searchParams.get("to") ?? "";
  const limit  = Math.min(parseInt(url.searchParams.get("limit") ?? "200", 10), 500);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

  const entries: LogEntry[] = [];

  await new Promise<void>((resolve, reject) => {
    let readStream: fsSync.ReadStream;
    try {
      readStream = fsSync.createReadStream(logFile, { encoding: "utf8" });
    } catch (err) {
      reject(err);
      return;
    }

    const splitter = split2();
    readStream.pipe(splitter);

    splitter.on("data", (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let entry: LogEntry;
      try { entry = JSON.parse(trimmed) as LogEntry; } catch { return; }

      if (level && entry.level !== level) return;
      if (from && entry.ts && entry.ts < from) return;
      if (to   && entry.ts && entry.ts > to)   return;
      if (q) {
        const haystack = JSON.stringify(entry).toLowerCase();
        if (!haystack.includes(q)) return;
      }
      entries.push(entry);
    });

    splitter.on("end",   resolve);
    splitter.on("error", reject);
    readStream.on("error", reject);
  }).catch(() => { /* file read errors → return what we have */ });

  const total = entries.length;
  const page  = entries.slice(offset, offset + limit);
  jsonResponse(res, 200, {
    entries: page,
    total,
    truncated: total > offset + limit,
    configured: true,
  });
}

async function handleLogStream(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const logFile = process.env["ORAGER_LOG_FILE"] ?? DEFAULT_LOG_PATH;
  if (!fsSync.existsSync(logFile)) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("data: " + JSON.stringify({ configured: true, entries: [] }) + "\n\n");
    res.end();
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "http://localhost:5173",
  });
  res.write(": connected\n\n");

  // Tail: watch for file changes, read new bytes since last position
  let filePos = 0;
  try {
    const stat = await fs.stat(logFile);
    filePos = stat.size; // start from end of file (only new lines)
  } catch { /* file may not exist yet */ }

  let closed = false;
  res.on("close", () => { closed = true; fsSync.unwatchFile(logFile); });

  fsSync.watchFile(logFile, { interval: 500 }, async () => {
    if (closed) return;
    try {
      const stat = await fs.stat(logFile);
      if (stat.size <= filePos) return; // truncated or unchanged
      const buf = Buffer.alloc(stat.size - filePos);
      const fd  = fsSync.openSync(logFile, "r");
      try {
        fsSync.readSync(fd, buf, 0, buf.length, filePos);
      } finally {
        // L-08: Ensure fd is closed even if readSync throws.
        fsSync.closeSync(fd);
      }
      filePos = stat.size;

      const lines = buf.toString("utf8").split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const entry = JSON.parse(trimmed) as LogEntry;
          res.write("data: " + JSON.stringify(entry) + "\n\n");
        } catch { /* skip malformed lines */ }
      }
    } catch { /* ignore */ }
  });
}

// ── Telemetry API ─────────────────────────────────────────────────────────────

async function handleGetSpans(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url    = new URL(req.url ?? "/", "http://localhost");
  const traceId = url.searchParams.get("traceId") ?? "";
  const name   = url.searchParams.get("name")?.toLowerCase() ?? "";
  const limit  = Math.min(parseInt(url.searchParams.get("limit") ?? "200", 10), 500);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

  const buf    = getSpanBuffer();
  let spans    = buf.getAll();

  if (traceId) spans = spans.filter((s) => s.traceId === traceId);
  if (name)    spans = spans.filter((s) => s.name.toLowerCase().includes(name));

  const total = spans.length;
  const page  = spans.slice(offset, offset + limit);

  jsonResponse(res, 200, {
    spans:      page,
    total,
    bufferSize: buf.size,
    bufferMax:  buf.max,
    configured: true,
  });
}

async function handleGetTraces(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const buf   = getSpanBuffer();
  const spans = buf.getAll();

  // Group by traceId
  const traceMap = new Map<string, BufferedSpan[]>();
  for (const s of spans) {
    const list = traceMap.get(s.traceId) ?? [];
    list.push(s);
    traceMap.set(s.traceId, list);
  }

  const traces = [...traceMap.entries()]
    .map(([traceId, traceSpans]) => {
      const root    = traceSpans.find((s) => !s.parentSpanId) ?? traceSpans[0];
      const start   = Math.min(...traceSpans.map((s) => s.startTimeMs));
      const end     = Math.max(...traceSpans.map((s) => s.endTimeMs));
      const errors  = traceSpans.filter((s) => s.status === "error").length;
      return {
        traceId,
        rootSpanName:     root?.name ?? "unknown",
        startTimeMs:      start,
        totalDurationMs:  end - start,
        spanCount:        traceSpans.length,
        errorCount:       errors,
      };
    })
    .sort((a, b) => b.startTimeMs - a.startTimeMs);

  jsonResponse(res, 200, { traces, total: traces.length, configured: true });
}

// ── Webhook test ─────────────────────────────────────────────────────────────

async function handleWebhookTest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  let parsed: { url?: unknown; format?: unknown };
  try {
    parsed = await readJsonBody(req) as { url?: unknown; format?: unknown };
  } catch {
    jsonResponse(res, 400, { error: "Invalid JSON" });
    return;
  }
  if (typeof parsed.url !== "string" || !parsed.url) {
    jsonResponse(res, 400, { error: "url is required" });
    return;
  }
  let url: URL;
  try {
    url = new URL(parsed.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("not http/https");
  } catch {
    jsonResponse(res, 400, { error: "url must be a valid http/https URL" });
    return;
  }
  // H-03: SSRF protection — block requests to private/internal IP ranges
  try {
    const blocked = await isBlockedHost(url.hostname);
    if (blocked) {
      jsonResponse(res, 400, {
        error: `SSRF blocked: '${url.hostname}' resolves to a private or internal IP address`,
      });
      return;
    }
  } catch {
    // DNS error is non-fatal; let fetch surface network errors naturally
  }

  const format = parsed.format === "discord" ? "discord" : undefined;
  const testPayload = {
    type: "result" as const,
    subtype: "success" as const,
    result: "Test webhook from orager UI",
    session_id: "test-session-00000000",
    finish_reason: "stop",
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
    total_cost_usd: 0,
    turnCount: 1,
  };
  try {
    const body = format === "discord"
      ? formatDiscordPayload(testPayload)
      : testPayload;
    const fetchRes = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    jsonResponse(res, 200, { ok: fetchRes.ok, status: fetchRes.status });
  } catch (err) {
    jsonResponse(res, 200, { ok: false, error: String(err) });
  }
}

// ── Static file serving ───────────────────────────────────────────────────────

async function serveStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const urlPath = new URL(req.url ?? "/", "http://localhost").pathname;

  // Security: prevent path traversal
  const safePath = path.normalize(urlPath).replace(/^\/+/, "");
  const filePath = path.join(UI_STATIC_DIR, safePath || "index.html");
  if (!filePath.startsWith(UI_STATIC_DIR)) {
    jsonResponse(res, 403, { error: "Forbidden" });
    return;
  }

  async function serveIndex(): Promise<void> {
    try {
      const indexPath = path.join(UI_STATIC_DIR, "index.html");
      let html = await fs.readFile(indexPath, "utf8");
      // Inject auth token so the SPA can authenticate API calls.
      // Use a per-request nonce so the inline script passes CSP.
      const nonce = crypto.randomBytes(16).toString("base64");
      const tokenScript = `<script nonce="${nonce}">window.__ORAGER_TOKEN__="${UI_AUTH_TOKEN}";</script>`;
      html = html.replace("</head>", `${tokenScript}</head>`);
      const buf = Buffer.from(html, "utf8");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": buf.length,
        "Content-Security-Policy":
          `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; ` +
          "img-src 'self' data:; font-src 'self'; connect-src 'self'; " +
          "frame-ancestors 'none'; form-action 'self'; base-uri 'self'",
      });
      res.end(buf);
    } catch {
      jsonResponse(res, 503, { error: "UI not built. Run: npm run build:ui" });
    }
  }

  // If path has no extension, serve index.html (SPA client-side routing)
  if (!path.extname(safePath)) {
    await serveIndex();
    return;
  }

  try {
    const content = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    const contentType = MIME[ext] ?? "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": content.length,
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
    });
    res.end(content);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Fall back to index.html for any unknown path (SPA fallback)
      await serveIndex();
    } else {
      jsonResponse(res, 500, { error: "Internal server error" });
    }
  }
}

// ── Auth check ───────────────────────────────────────────────────────────────

function checkUiAuth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  // Allow OPTIONS (preflight) without auth
  if (req.method === "OPTIONS") return true;
  // Static files (non-API) don't need auth — they're just the SPA bundle
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (!pathname.startsWith("/api/")) return true;
  // API routes require the bearer token
  const auth = req.headers.authorization;
  if (auth === `Bearer ${UI_AUTH_TOKEN}`) return true;
  // Also accept as query param for SSE endpoints (EventSource can't set headers)
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.searchParams.get("token") === UI_AUTH_TOKEN) return true;
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "unauthorized — pass the token printed at startup" }));
  return false;
}

// ── Request router ────────────────────────────────────────────────────────────

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  // ── Security headers (audit E-09) ─────────────────────────────────────────
  res.setHeader("Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; font-src 'self'; connect-src 'self'; " +
    "frame-ancestors 'none'; form-action 'self'; base-uri 'self'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

  // CORS: only allow cross-origin requests in development (vite dev server)
  if (process.env.NODE_ENV === "development" || process.env.ORAGER_UI_DEV === "1") {
    res.setHeader("Access-Control-Allow-Origin", "http://localhost:5173");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (!checkUiAuth(req, res)) return;

  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  try {
    if (pathname === "/api/config" && req.method === "GET") {
      await handleGetConfig(req, res);
    } else if (pathname === "/api/config" && req.method === "POST") {
      await handlePostConfig(req, res);
    } else if (pathname === "/api/config/defaults" && req.method === "GET") {
      await handleGetConfigDefaults(req, res);
    } else if (pathname === "/api/settings" && req.method === "GET") {
      await handleGetSettings(req, res);
    } else if (pathname === "/api/settings" && req.method === "POST") {
      await handlePostSettings(req, res);
    } else if (pathname === "/api/daemon/status" && req.method === "GET") {
      await handleDaemonStatus(req, res);
    } else if (pathname === "/api/daemon/metrics" && req.method === "GET") {
      await handleDaemonMetrics(req, res);
    } else if (pathname === "/api/daemon/sessions" && req.method === "GET") {
      await handleDaemonSessions(req, res);
    } else if (pathname === "/api/logs" && req.method === "GET") {
      await handleGetLogs(req, res);
    } else if (pathname === "/api/logs/stream" && req.method === "GET") {
      await handleLogStream(req, res);
    } else if (pathname === "/api/telemetry/spans" && req.method === "GET") {
      await handleGetSpans(req, res);
    } else if (pathname === "/api/telemetry/traces" && req.method === "GET") {
      await handleGetTraces(req, res);
    } else if (pathname === "/api/webhook/test" && req.method === "POST") {
      await handleWebhookTest(req, res);
    } else if (pathname.startsWith("/api/")) {
      jsonResponse(res, 404, { error: "Not found" });
    } else {
      await serveStatic(req, res);
    }
  } catch (err) {
    process.stderr.write(`[orager-ui] unhandled error: ${(err as Error).message}\n`);
    if (!res.headersSent) {
      jsonResponse(res, 500, { error: "Internal server error" });
    }
  }
}

// ── Server lifecycle ──────────────────────────────────────────────────────────

export interface UiServerOptions {
  port?: number;
}

export async function startUiServer(opts: UiServerOptions = {}): Promise<void> {
  const port = opts.port ?? 3457;

  // Enforce single-instance before binding the port
  await acquireUiPidLock(port);

  const server = http.createServer(handleRequest);

  await new Promise<void>((resolve, reject) => {
    server.on("error", (err) => {
      void releaseUiPidLock();
      reject(err);
    });
    server.listen(port, "127.0.0.1", () => resolve());
  });

  // Write port file so tooling (and the setup wizard) can discover the server
  await atomicWrite(UI_PORT_PATH, String(port));

  const uiDir = UI_STATIC_DIR;
  const uiBuilt = fsSync.existsSync(path.join(uiDir, "index.html"));

  process.stdout.write(
    `[orager-ui] server running at http://127.0.0.1:${port}\n`,
  );
  process.stdout.write(`UI auth token: ${UI_AUTH_TOKEN}\n`);
  if (!uiBuilt) {
    process.stdout.write(
      `[orager-ui] WARNING: UI not built. Run 'npm run build:ui' then restart.\n`,
    );
  }

  // Clean up port and PID files on exit
  async function cleanup(): Promise<void> {
    try { await fs.unlink(UI_PORT_PATH); } catch { /* ignore */ }
    await releaseUiPidLock();
    process.exit(0);
  }

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("exit", () => {
    try { fsSync.unlinkSync(UI_PORT_PATH); } catch { /* ignore */ }
    try { fsSync.unlinkSync(UI_PID_PATH); } catch { /* ignore */ }
  });

  // Keep process alive
  await new Promise<never>(() => { /* server runs indefinitely */ });
}
