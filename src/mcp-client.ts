/**
 * MCP client — connects to external MCP servers and exposes their tools
 * as ToolExecutor instances for injection into the agent loop.
 *
 * Server config is read from ~/.orager/config.json under "mcpServers",
 * using the same schema as Claude Desktop / claude_desktop_config.json.
 *
 * Each server's tools are exposed as mcp__<serverName>__<toolName>.
 *
 * Transport support:
 *   - stdio  (default): spawns a subprocess and talks over stdin/stdout.
 *   - http   (Streamable HTTP+SSE, MCP spec §6.4): connects to a running
 *            HTTP server. Use this when the MCP server is a long-lived
 *            process or a remote service.
 *
 * HTTP config example (in mcpServers):
 *   {
 *     "myServer": {
 *       "url": "http://localhost:3100/mcp",
 *       "headers": { "Authorization": "Bearer <token>" }
 *     }
 *   }
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolExecutor, ToolParameterSchema } from "./types.js";

/**
 * SSRF guard for MCP HTTP transport URLs.
 * Blocks cloud metadata endpoints (169.254.x.x, metadata.google.internal)
 * but allows localhost/127.x so developers can run MCP servers locally.
 */
function isMcpHttpUrlSafe(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  // Block IPv4 link-local (cloud metadata services live here)
  if (/^169\.254\./.test(h)) return false;
  // Block IPv6 link-local (fe80::/10) — also used as metadata endpoints in
  // some cloud environments and always outside the intended address space.
  if (/^fe[89ab][0-9a-f]?:/i.test(h) || h.startsWith("fe80")) return false;
  // Block GCP metadata by hostname
  if (h === "metadata.google.internal" || h === "metadata.google") return false;
  // Block Azure/AWS IMDS hostname variants
  if (h === "metadata.azure.com" || h === "169.254.169.254") return false;
  return true;
}

const MCP_TOOL_TIMEOUT_MS = 30_000;
const MAX_MCP_RESULT_CHARS = 50_000;
const MCP_TOOL_CALL_RETRIES = 2;          // max retries on rate-limit or transient errors
const MCP_TOOL_CALL_RETRY_DELAYS = [1000, 3000]; // ms before each retry

// Env var prefixes that can hijack subprocess behaviour — strip them from
// user-supplied MCP server env configs to prevent sandbox escapes.
const UNSAFE_ENV_PREFIXES = ["LD_", "DYLD_", "NODE_", "PYTHON", "RUBYOPT", "PERL5"];

// ── HTTP header validation ────────────────────────────────────────────────────
//
// Guard against HTTP header injection attacks in HttpMcpServerConfig.headers.
// RFC 7230 §3.2: header names must be tokens (printable ASCII, no separators).
// Header values must not contain CR or LF characters (header splitting attack).

const HTTP_HEADER_NAME_RE = /^[!#$%&'*+\-.0-9A-Z^_`a-z|~]+$/;
// Sensitive headers the caller should not be able to override via user config
const BLOCKED_HEADER_NAMES = new Set(["host", "content-length", "transfer-encoding", "connection", "upgrade"]);

/**
 * Returns a sanitized copy of an HTTP headers object with invalid entries removed.
 * Rejects: invalid RFC 7230 header names, restricted headers, values with CR/LF.
 */
function sanitizeMcpHttpHeaders(
  headers: Record<string, string>,
  serverName: string,
): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HTTP_HEADER_NAME_RE.test(name)) {
      process.stderr.write(
        `[orager] WARNING: MCP server '${serverName}' HTTP header name '${name}' contains invalid characters — rejected\n`,
      );
      continue;
    }
    if (BLOCKED_HEADER_NAMES.has(name.toLowerCase())) {
      process.stderr.write(
        `[orager] WARNING: MCP server '${serverName}' HTTP header '${name}' is a restricted header — rejected\n`,
      );
      continue;
    }
    if (typeof value !== "string" || /[\r\n]/.test(value)) {
      process.stderr.write(
        `[orager] WARNING: MCP server '${serverName}' HTTP header '${name}' value contains CR/LF — rejected (header injection guard)\n`,
      );
      continue;
    }
    safe[name] = value;
  }
  return safe;
}

function sanitizeMcpEnv(
  env: Record<string, string> | undefined,
  serverName: string,
): Record<string, string> | undefined {
  if (!env) return undefined;
  const safe: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (UNSAFE_ENV_PREFIXES.some((p) => k.toUpperCase().startsWith(p))) {
      process.stderr.write(
        `[orager] WARNING: MCP server '${serverName}' env var '${k}' rejected — unsafe prefix\n`,
      );
      continue;
    }
    safe[k] = v;
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
}

// ── Transport config types ────────────────────────────────────────────────────

/** Stdio transport: spawns a subprocess and talks over stdin/stdout. */
export interface StdioMcpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Streamable HTTP+SSE transport (MCP spec §6.4).
 * Connects to a running HTTP MCP server — useful for remote or long-lived
 * processes that shouldn't be spawned per-run.
 */
export interface HttpMcpServerConfig {
  url: string;
  /**
   * Extra HTTP headers sent on every request.
   * Use for authentication: `{ "Authorization": "Bearer <token>" }`.
   */
  headers?: Record<string, string>;
}

/** Union of all supported MCP server transport configs. */
export type McpServerConfig = StdioMcpServerConfig | HttpMcpServerConfig;

export interface McpClientHandle {
  tools: ToolExecutor[];
  close(): Promise<void>;
}

// ── Reconnectable HTTP client ─────────────────────────────────────────────────
//
// HTTP MCP servers can drop long-lived connections (idle timeout, server restart,
// load-balancer reset). This class wraps an MCP Client, detects transport-level
// disconnection errors on tool calls, and automatically reconnects + retries once.

function buildHttpTransport(config: HttpMcpServerConfig, name: string): StreamableHTTPClientTransport {
  const url = new URL(config.url);
  const t = new StreamableHTTPClientTransport(url);

  // Always disable automatic redirect following. The SSRF blocklist validates
  // the configured URL but cannot inspect redirect targets at connection time.
  // Setting redirect:"error" ensures a 3xx response from an MCP server is
  // surfaced as an error rather than silently followed to an unvalidated host.
  // MCP server configs must supply the final canonical URL.
  const requestInit: RequestInit = { redirect: "error" };

  if (config.headers && Object.keys(config.headers).length > 0) {
    const safeHdrs = sanitizeMcpHttpHeaders(config.headers, name);
    if (Object.keys(safeHdrs).length > 0) {
      requestInit.headers = safeHdrs;
    }
  }

  (t as unknown as { requestInit?: RequestInit }).requestInit = requestInit;
  return t;
}

function isTransportDisconnect(msg: string): boolean {
  return /ECONNRESET|EPIPE|connection.*closed|disconnected|socket.*hang|network.*error|transport.*closed/i.test(msg);
}

function isRateLimitError(msg: string): boolean {
  return /429|rate.?limit|too.?many/i.test(msg);
}

/**
 * Wraps an MCP Client for HTTP transports.
 * On disconnect, automatically creates a fresh transport+client and retries once.
 * On 429 rate-limit responses, retries up to MCP_TOOL_CALL_RETRIES times with backoff.
 */
class ReconnectableMcpClient {
  private _closed = false;
  /** Tracks how many reconnect attempts have been made across all callTool calls. */
  private _reconnectAttempts = 0;
  private static readonly MAX_RECONNECT_ATTEMPTS = 3;

  constructor(
    private readonly serverName: string,
    private readonly config: HttpMcpServerConfig,
    private client: Client,
  ) {}

  /**
   * M-24: Reconnect and rate-limit retries are now tracked independently.
   * A disconnect+reconnect does NOT consume a rate-limit retry attempt.
   * This prevents the sequence "disconnect → reconnect → rate limit" from
   * exhausting all retries prematurely.
   */
  async callTool(toolName: string, input: Record<string, unknown>) {
    let lastErr: unknown;
    let rateLimitAttempt = 0; // separate counter for rate-limit retries

    // Outer loop: rate-limit retries (up to MCP_TOOL_CALL_RETRIES)
    while (rateLimitAttempt <= MCP_TOOL_CALL_RETRIES) {
      try {
        // Inner: attempt the call, handling disconnects with reconnection
        return await this._callWithReconnect(toolName, input);
      } catch (err) {
        lastErr = err;
        if (this._closed) throw err;

        const msg = err instanceof Error ? err.message : String(err);

        // Rate-limit errors get their own retry budget
        if (isRateLimitError(msg) && rateLimitAttempt < MCP_TOOL_CALL_RETRIES) {
          const delay = MCP_TOOL_CALL_RETRY_DELAYS[rateLimitAttempt] ?? 3000;
          process.stderr.write(
            `[orager] MCP server '${this.serverName}' rate-limited — retry ${rateLimitAttempt + 1}/${MCP_TOOL_CALL_RETRIES} after ${delay}ms\n`,
          );
          await new Promise<void>((r) => setTimeout(r, delay));
          rateLimitAttempt++;
          continue;
        }

        throw err; // non-retriable or exhausted retries
      }
    }

    throw lastErr;
  }

  /** Attempt a single tool call, reconnecting on transport disconnect. */
  private async _callWithReconnect(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<Awaited<ReturnType<Client["callTool"]>>> {
    try {
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      return await Promise.race([
        this.client.callTool({ name: toolName, arguments: input }),
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error(`MCP tool '${toolName}' timed out after ${MCP_TOOL_TIMEOUT_MS / 1000}s`)),
            MCP_TOOL_TIMEOUT_MS,
          );
        }),
      ]).finally(() => {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      });
    } catch (err) {
      if (this._closed) throw err;

      const msg = err instanceof Error ? err.message : String(err);

      if (isTransportDisconnect(msg) &&
          this._reconnectAttempts < ReconnectableMcpClient.MAX_RECONNECT_ATTEMPTS) {
        this._reconnectAttempts++;
        process.stderr.write(
          `[orager] MCP server '${this.serverName}' connection lost (${msg.slice(0, 80)}), reconnecting… (attempt ${this._reconnectAttempts}/${ReconnectableMcpClient.MAX_RECONNECT_ATTEMPTS})\n`,
        );
        await this._reconnect();
        this._reconnectAttempts = 0;
        // Retry the call once after reconnect (does not consume rate-limit budget)
        let timeoutHandle2: ReturnType<typeof setTimeout> | undefined;
        return await Promise.race([
          this.client.callTool({ name: toolName, arguments: input }),
          new Promise<never>((_, reject) => {
            timeoutHandle2 = setTimeout(
              () => reject(new Error(`MCP tool '${toolName}' timed out after ${MCP_TOOL_TIMEOUT_MS / 1000}s`)),
              MCP_TOOL_TIMEOUT_MS,
            );
          }),
        ]).finally(() => {
          if (timeoutHandle2 !== undefined) clearTimeout(timeoutHandle2);
        });
      }

      throw err;
    }
  }

  private async _reconnect(): Promise<void> {
    // Close old client+transport before creating replacements (audit P-8)
    await this.client.close().catch(() => {});
    let transport: StreamableHTTPClientTransport | undefined;
    try {
      transport = buildHttpTransport(this.config, this.serverName);
      this.client = new Client({ name: "orager", version: "1.0.0" });
      await this.client.connect(transport);
      process.stderr.write(`[orager] MCP server '${this.serverName}' reconnected successfully\n`);
    } catch (err) {
      // Clean up the new transport if connect failed to prevent resource leak
      if (transport) await transport.close?.().catch(() => {});
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`MCP server '${this.serverName}' failed to reconnect: ${msg}`);
    }
  }

  async close(): Promise<void> {
    this._closed = true;
    await this.client.close().catch(() => {});
  }
}

export async function connectMcpServer(
  name: string,
  config: McpServerConfig,
): Promise<McpClientHandle> {
  // ── Transport selection ───────────────────────────────────────────────────
  const transport = "url" in config
    ? (() => {
        if (!isMcpHttpUrlSafe(config.url)) {
          throw new Error(
            `MCP server '${name}': URL '${config.url}' is blocked — cloud metadata endpoints (link-local 169.254.x.x) are not allowed for HTTP transport`,
          );
        }
        return buildHttpTransport(config, name);
      })()
    : new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        env: sanitizeMcpEnv(config.env, name),
      });

  const client = new Client({ name: "orager", version: "1.0.0" });

  // For HTTP transports, wrap in a ReconnectableMcpClient after successful connect.
  const reconnectable = "url" in config
    ? new ReconnectableMcpClient(name, config, client)
    : null;

  // ── Connection with retry + rate-limit backoff ────────────────────────────
  // HTTP transports may receive a 429 (Too Many Requests) on the initial
  // connect/initialize handshake. Retry up to 3 times with exponential backoff.
  // Stdio transports don't do HTTP so we skip retries for them (the connect
  // call spawns a process and never produces a 429-style error).
  const isHttpTransport = "url" in config;
  const connectAttempts = isHttpTransport ? 3 : 1;
  const connectDelays = [0, 2000, 5000]; // ms before each retry

  for (let attempt = 0; attempt < connectAttempts; attempt++) {
    if (attempt > 0 && connectDelays[attempt]) {
      process.stderr.write(
        `[orager] MCP server '${name}' connect retry ${attempt}/${connectAttempts - 1} after ${connectDelays[attempt]}ms\n`,
      );
      await new Promise<void>((r) => setTimeout(r, connectDelays[attempt]));
    }
    try {
      await (() => {
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        return Promise.race([
          client.connect(transport),
          new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(
              () => reject(new Error(`MCP server '${name}' connection timed out after 10s`)),
              10_000,
            );
          }),
        ]).finally(() => {
          if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        });
      })();
      break; // success — exit retry loop
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Only retry on rate-limit signals (429 in message) or transient network errors
      const isRateLimit = isRateLimitError(msg);
      const isTransient = /timeout|ECONNREFUSED|ENOTFOUND|network/i.test(msg);
      if (attempt < connectAttempts - 1 && (isRateLimit || isTransient)) {
        continue; // will retry
      }
      throw err; // permanent failure or last attempt
    }
  }

  const { tools: rawTools } = await client.listTools();

  const tools: ToolExecutor[] = rawTools.map((t) => ({
    definition: {
      type: "function" as const,
      function: {
        name: `mcp__${name}__${t.name}`,
        description: t.description ?? "",
        parameters: (t.inputSchema as ToolParameterSchema) ?? { type: "object", properties: {} },
      },
    },
    async execute(input: Record<string, unknown>) {
      try {
        // For HTTP transports, use the reconnectable client which handles disconnect
        // recovery and rate-limit retries automatically.
        // For stdio, call the underlying client directly (no reconnect needed).
        let result: Awaited<ReturnType<typeof client.callTool>>;
        if (reconnectable) {
          result = await reconnectable.callTool(t.name, input);
        } else {
          // Stdio: enforce per-call timeout only (no reconnect logic).
          let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
          result = await Promise.race([
            client.callTool({ name: t.name, arguments: input }),
            new Promise<never>((_, reject) => {
              timeoutHandle = setTimeout(
                () => reject(new Error(`MCP tool '${t.name}' timed out after ${MCP_TOOL_TIMEOUT_MS / 1000}s`)),
                MCP_TOOL_TIMEOUT_MS,
              );
            }),
          ]).finally(() => {
            if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
          });
        }

        let content = Array.isArray(result.content)
          ? result.content.map((c: { type: string; text?: string }) => c.type === "text" ? c.text ?? "" : JSON.stringify(c)).join("\n")
          : String(result.content ?? "");

        // Cap result size to prevent memory exhaustion from runaway MCP servers.
        if (content.length > MAX_MCP_RESULT_CHARS) {
          content = content.slice(0, MAX_MCP_RESULT_CHARS) +
            `\n[MCP result truncated at ${MAX_MCP_RESULT_CHARS} chars]`;
        }

        return { toolCallId: "", content, isError: result.isError === true };
      } catch (err) {
        return {
          toolCallId: "",
          content: `MCP tool error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  }));

  return {
    tools,
    async close() {
      // For HTTP transports, close via the reconnectable wrapper (sets _closed flag).
      // For stdio, close the underlying client directly.
      if (reconnectable) {
        await reconnectable.close();
      } else {
        await client.close().catch(() => {});
      }
    },
  };
}

export async function connectAllMcpServers(
  servers: Record<string, McpServerConfig>,
  onLog?: (msg: string) => void,
): Promise<McpClientHandle[]> {
  const entries = Object.entries(servers);
  const results = await Promise.all(
    entries.map(async ([name, config]) => {
      try {
        const handle = await connectMcpServer(name, config);
        onLog?.(`[orager] MCP: connected to '${name}' (${handle.tools.length} tools)\n`);
        return handle;
      } catch (err) {
        onLog?.(`[orager] WARNING: MCP server '${name}' failed to connect: ${err instanceof Error ? err.message : String(err)}\n`);
        return null;
      }
    }),
  );
  return results.filter((h): h is McpClientHandle => h !== null);
}
