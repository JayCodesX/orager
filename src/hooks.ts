/**
 * Hook runner for lifecycle events and tool calls.
 *
 * Each hook target can be:
 *   - A shell command string  (runs via `bash -c <cmd>`)
 *   - An HTTP URL object      ({ url: string; format?: "discord" })
 *   - An array mixing both
 *
 * Shell commands receive context via env vars:
 *   ORAGER_HOOK_EVENT   — event name (e.g. "PreToolCall")
 *   ORAGER_TOOL_NAME    — tool name (tool events only)
 *   ORAGER_TOOL_INPUT   — JSON string of tool input (tool events only)
 *   ORAGER_SESSION_ID   — current session ID
 *   ORAGER_IS_ERROR     — "true"/"false" (PostToolCall only)
 *   ORAGER_TURN         — turn number (LLM/Stop events)
 *   ORAGER_MODEL        — model name (PreLLMRequest/PostLLMResponse)
 *   ORAGER_SUBTYPE      — result subtype (Stop/MaxTurnsReached)
 *   ORAGER_TOTAL_COST   — total cost USD as string (Stop)
 *
 * HTTP hooks receive a JSON {@link HookPayload} body via POST.
 * SSRF guard: private IPs and loopback addresses are blocked.
 */
import { execFile } from "node:child_process";
import { promises as dnsPromises } from "node:dns";
import { isIP } from "node:net";
import { promisify } from "node:util";

const execAsync = promisify(execFile);
const DEFAULT_HOOK_TIMEOUT_MS = 10_000;

// ── Types ─────────────────────────────────────────────────────────────────────

export type HookEvent =
  | "PreToolCall"
  | "PostToolCall"
  | "SessionStart"
  | "SessionStop"
  /** Fires before each LLM API call. Payload includes `model` and `turn`. */
  | "PreLLMRequest"
  /** Fires after each LLM response. Payload includes `model`, `turn`, token counts. */
  | "PostLLMResponse"
  /** Fires when the agent run completes (any exit subtype). */
  | "Stop"
  /** Fires when a tool call is denied by the user or an approval policy. */
  | "ToolDenied"
  /** Fires when a tool call times out. */
  | "ToolTimeout"
  /** Fires when the configured max-turn limit is reached. */
  | "MaxTurnsReached";

/** A URL-based hook target. */
export interface HookUrlTarget {
  url: string;
  /** When "discord", the payload is formatted as a Discord embed. */
  format?: "discord";
}

/**
 * A hook target: a shell command, an HTTP endpoint, or an array of both.
 *
 * @example
 * // Shell command
 * hooks: { Stop: "echo session done" }
 *
 * @example
 * // HTTP endpoint
 * hooks: { Stop: { url: "https://hooks.slack.com/..." } }
 *
 * @example
 * // Both
 * hooks: { Stop: ["echo done", { url: "https://..." }] }
 */
export type HookTarget =
  | string
  | HookUrlTarget
  | Array<string | HookUrlTarget>;

export interface HookConfig {
  PreToolCall?: HookTarget;
  PostToolCall?: HookTarget;
  SessionStart?: HookTarget;
  SessionStop?: HookTarget;
  PreLLMRequest?: HookTarget;
  PostLLMResponse?: HookTarget;
  Stop?: HookTarget;
  ToolDenied?: HookTarget;
  ToolTimeout?: HookTarget;
  MaxTurnsReached?: HookTarget;
}

/** Rich JSON payload sent to HTTP hook endpoints and used to build env vars for command hooks. */
export interface HookPayload {
  /** The hook event name. */
  event: HookEvent;
  /** Current session ID. */
  sessionId: string;
  /** Active model identifier (LLM/Stop events). */
  model?: string;
  /** Current agent turn number (LLM/Stop/tool events). */
  turn?: number;
  /** Tool name (tool events only). */
  toolName?: string;
  /** Parsed tool input (tool events only). */
  toolInput?: Record<string, unknown>;
  /** Whether the tool result was an error (PostToolCall/ToolTimeout/ToolDenied). */
  isError?: boolean;
  /** Final assistant text (Stop). */
  result?: string;
  /** Result subtype (Stop/MaxTurnsReached): "success", "error_max_turns", etc. */
  subtype?: string;
  /** Cumulative cost in USD (Stop). */
  totalCostUsd?: number;
  /** Number of turns completed (Stop). */
  turnCount?: number;
  /** Input token count for the LLM call (PostLLMResponse). */
  inputTokens?: number;
  /** Output token count for the LLM call (PostLLMResponse). */
  outputTokens?: number;
  /** ISO timestamp when the hook was fired. */
  ts: string;
}

/** @deprecated Use {@link HookContext} is replaced by {@link HookPayload}. Kept for runHook backward compat. */
export interface HookContext {
  sessionId: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  isError?: boolean;
}

// ── SSRF guard ────────────────────────────────────────────────────────────────

/**
 * Returns true if the URL is safe to POST to.
 * Resolves DNS and checks the actual IPs to prevent DNS rebinding. (audit B-03)
 */
export async function isHookUrlSafe(raw: string): Promise<boolean> {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  // If it's already an IP, check directly
  if (isIP(h)) return !isPrivateOrReservedIp(h);

  // Resolve DNS and check all resulting IPs
  try {
    const [v4, v6] = await Promise.allSettled([
      dnsPromises.resolve4(h),
      dnsPromises.resolve6(h),
    ]);
    const addrs = [
      ...(v4.status === "fulfilled" ? v4.value : []),
      ...(v6.status === "fulfilled" ? v6.value : []),
    ];
    if (addrs.length === 0) return false; // unresolvable = blocked
    return !addrs.some(isPrivateOrReservedIp);
  } catch {
    return false;
  }
}

function isPrivateOrReservedIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    return (
      /^127\./.test(ip) || /^10\./.test(ip) || /^192\.168\./.test(ip) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || /^169\.254\./.test(ip) ||
      /^0\./.test(ip) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip) ||
      /^224\./.test(ip) || /^240\./.test(ip)
    );
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    return (
      lower === "::1" || /^(fc|fd)/i.test(lower) || /^fe[89ab]/i.test(lower) ||
      /^::ffff:(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(lower) ||
      lower === "::ffff:7f00:1" || lower === "::"
    );
  }
  return true; // unknown format = blocked
}

// ── HTTP hook delivery ────────────────────────────────────────────────────────

async function postHookUrl(
  url: string,
  payload: HookPayload,
  onLog?: (msg: string) => void,
): Promise<{ ok: boolean; error?: string }> {
  if (!(await isHookUrlSafe(url))) {
    const msg = `hook URL '${url}' is blocked (private/loopback address)`;
    onLog?.(`[orager] WARNING: ${msg}\n`);
    return { ok: false, error: msg };
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { ok: true };
    return { ok: false, error: `HTTP ${res.status}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

// ── Core fire function ────────────────────────────────────────────────────────

/**
 * Fire all hook targets for the given event.
 *
 * Normalises `target` to an array, then for each entry:
 * - string   → runs `bash -c <string>` with context env vars
 * - url obj  → HTTP POSTs the {@link HookPayload} as JSON
 *
 * Failures are non-fatal by default (`errorMode: "warn"`).
 * Returns `{ ok: false, error }` on the first failure; subsequent targets
 * still run even after a failure.
 */
export async function fireHooks(
  event: HookEvent,
  target: HookTarget,
  payload: HookPayload,
  options?: { timeoutMs?: number; errorMode?: "ignore" | "warn" | "fail" },
  onLog?: (msg: string) => void,
): Promise<{ ok: boolean; error?: string }> {
  const errorMode = options?.errorMode ?? "warn";
  const timeoutMs = options?.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;

  // Normalize to array
  const targets: Array<string | HookUrlTarget> = Array.isArray(target) ? target : [target];

  let firstError: string | undefined;

  for (const t of targets) {
    let result: { ok: boolean; error?: string };

    if (typeof t === "string") {
      // ── Shell command hook ─────────────────────────────────────────────────
      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        ORAGER_HOOK_EVENT: event,
        ORAGER_SESSION_ID: payload.sessionId,
      };
      if (payload.toolName !== undefined) env["ORAGER_TOOL_NAME"] = payload.toolName;
      // M-16: Pass tool input via stdin instead of env var to avoid shell
      // metacharacter injection when user-authored hook scripts reference
      // $ORAGER_TOOL_INPUT without proper quoting. Stdin is inherently safe
      // from shell interpretation. The env var is still set for backward
      // compatibility but scripts should prefer reading stdin.
      const toolInputJson = payload.toolInput !== undefined
        ? JSON.stringify(payload.toolInput)
        : undefined;
      if (toolInputJson !== undefined) env["ORAGER_TOOL_INPUT"] = toolInputJson;
      if (payload.isError !== undefined) env["ORAGER_IS_ERROR"] = payload.isError ? "true" : "false";
      if (payload.turn !== undefined) env["ORAGER_TURN"] = String(payload.turn);
      if (payload.model !== undefined) env["ORAGER_MODEL"] = payload.model;
      if (payload.subtype !== undefined) env["ORAGER_SUBTYPE"] = payload.subtype;
      if (payload.totalCostUsd !== undefined) env["ORAGER_TOTAL_COST"] = String(payload.totalCostUsd);

      try {
        await execAsync("bash", ["-c", t], {
          env,
          timeout: timeoutMs,
          // M-16: Pipe tool input JSON on stdin for safe consumption
          ...(toolInputJson ? { input: toolInputJson } : {}),
        });
        result = { ok: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (errorMode !== "ignore") {
          onLog?.(`[orager] WARNING: hook '${event}' command failed: ${msg}\n`);
        }
        result = { ok: false, error: msg };
      }
    } else {
      // ── URL hook ──────────────────────────────────────────────────────────
      result = await postHookUrl(t.url, payload, onLog);
      if (!result.ok && errorMode !== "ignore") {
        onLog?.(`[orager] WARNING: hook '${event}' URL delivery failed (${t.url}): ${result.error}\n`);
      }
    }

    if (!result.ok && firstError === undefined) {
      firstError = result.error;
    }
  }

  return firstError !== undefined ? { ok: false, error: firstError } : { ok: true };
}

// ── Backward-compatible runHook ───────────────────────────────────────────────

/**
 * @deprecated Prefer {@link fireHooks} with a {@link HookPayload}.
 * Retained for callers that pass a plain command string and a HookContext.
 */
export async function runHook(
  event: HookEvent,
  command: string,
  ctx: HookContext,
  onLog?: (msg: string) => void,
  options?: {
    timeoutMs?: number;
    errorMode?: "ignore" | "warn" | "fail";
  },
): Promise<{ ok: boolean; error?: string }> {
  const payload: HookPayload = {
    event,
    sessionId: ctx.sessionId,
    toolName: ctx.toolName,
    toolInput: ctx.toolInput,
    isError: ctx.isError,
    ts: new Date().toISOString(),
  };
  return fireHooks(event, command, payload, options, onLog);
}
