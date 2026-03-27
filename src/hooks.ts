/**
 * Shell hook runner for pre/post tool execution and session lifecycle events.
 * Hook config is read from ~/.orager/settings.json under "hooks".
 *
 * Hook shell commands receive context via env vars:
 *   ORAGER_HOOK_EVENT   — event name (e.g. "PreToolCall")
 *   ORAGER_TOOL_NAME    — tool name (PreToolCall/PostToolCall only)
 *   ORAGER_TOOL_INPUT   — JSON string of tool input (PreToolCall/PostToolCall only)
 *   ORAGER_SESSION_ID   — current session ID
 *   ORAGER_IS_ERROR     — "true"/"false" (PostToolCall only)
 *
 * Hook failures are non-fatal: they log a warning but do not abort the tool or run.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(execFile);
const DEFAULT_HOOK_TIMEOUT_MS = 10_000;

export type HookEvent = "PreToolCall" | "PostToolCall" | "SessionStart" | "SessionStop";

export interface HookConfig {
  PreToolCall?: string;
  PostToolCall?: string;
  SessionStart?: string;
  SessionStop?: string;
}

export interface HookContext {
  sessionId: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  isError?: boolean;
}

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
  const timeoutMs = options?.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  const errorMode = options?.errorMode ?? "warn";

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ORAGER_HOOK_EVENT: event,
    ORAGER_SESSION_ID: ctx.sessionId,
  };
  if (ctx.toolName) env["ORAGER_TOOL_NAME"] = ctx.toolName;
  if (ctx.toolInput) env["ORAGER_TOOL_INPUT"] = JSON.stringify(ctx.toolInput);
  if (ctx.isError !== undefined) env["ORAGER_IS_ERROR"] = ctx.isError ? "true" : "false";

  try {
    await execAsync("bash", ["-c", command], { env, timeout: timeoutMs });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (errorMode !== "ignore") {
      onLog?.(`[orager] WARNING: hook '${event}' failed: ${msg}\n`);
    }
    return { ok: false, error: msg };
  }
}
