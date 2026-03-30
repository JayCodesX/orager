/**
 * Append-only NDJSON audit log for tool approval decisions and tool execution.
 *
 * Written to ORAGER_AUDIT_LOG env var path, or ~/.orager/audit.log by default.
 * Each line is a JSON object describing one audit event (approval or tool call).
 * Write failures are silently discarded — audit logging must never crash the agent.
 *
 * Two event types:
 *   - Approval entries (AuditEntry):     "event" field absent (legacy compat)
 *   - Tool-call entries (ToolCallEntry): event: "tool_call"
 */
import fs from "node:fs";
import { mkdir, stat as statAsync, rename as renameAsync } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sanitizeInput } from "./audit-utils.js";

const MAX_AUDIT_LOG_BYTES = 10 * 1024 * 1024; // 10 MB — rotate at this size

export type ApprovalDecision = "approved" | "denied" | "timeout" | "skipped_permissions" | "delegated";

export interface AuditEntry {
  ts: string;
  sessionId: string;
  toolName: string;
  /** Sanitized subset of tool input — large values are truncated to 500 chars */
  inputSummary: Record<string, unknown>;
  decision: ApprovalDecision;
  /** How approval was obtained or execution was handled */
  mode: "tty" | "callback" | "question" | "skip_permissions" | "delegated";
  durationMs?: number;
}

/**
 * Returns the current audit log path, reading the env var at call time so
 * tests can change ORAGER_AUDIT_LOG between calls without module reload.
 */
function getAuditLogPath(): string {
  return process.env["ORAGER_AUDIT_LOG"] ??
    path.join(os.homedir(), ".orager", "audit.log");
}

let _stream: fs.WriteStream | null = null;
let _dirInit: Promise<void> | null = null;
let _auditErrorEmitted = false;

async function ensureAuditDir(): Promise<void> {
  // Create parent directory with restricted permissions (user-only).
  await mkdir(path.dirname(getAuditLogPath()), { recursive: true, mode: 0o700 }).catch(() => {});

  // Rotate the log file if it has grown beyond the size limit.
  try {
    const s = await statAsync(getAuditLogPath());
    if (s.size >= MAX_AUDIT_LOG_BYTES) {
      const p = getAuditLogPath();
      await renameAsync(p, `${p}.1`).catch(() => {});
    }
  } catch {
    // File doesn't exist yet — no rotation needed.
  }
}

function getStream(): fs.WriteStream {
  if (!_stream) {
    // Kick off async dir creation and rotation (non-blocking — writes that
    // arrive before mkdir/rotation completes are buffered by WriteStream).
    if (!_dirInit) {
      _dirInit = ensureAuditDir();
    }
    // Create with mode 0o600 so the audit log is readable only by the owner.
    _stream = fs.createWriteStream(getAuditLogPath(), { flags: "a", encoding: "utf8", mode: 0o600 });
    _stream.on("error", (err: NodeJS.ErrnoException) => {
      // Emit a one-shot warning so operators know audit logging has failed.
      if (!_auditErrorEmitted) {
        _auditErrorEmitted = true;
        process.stderr.write(
          `[orager] WARNING: audit log write failed (${err.message}) — further write errors suppressed\n`,
        );
      }
    });
  }
  return _stream;
}

/**
 * Close and discard the current write stream so the next write opens a fresh
 * one pointing at whatever ORAGER_AUDIT_LOG is set to at that moment.
 * Only intended for use in tests — do not call from production code.
 */
export function _resetStreamForTesting(): void {
  if (_stream) {
    _stream.destroy();
    _stream = null;
  }
  _dirInit = null;
  _auditErrorEmitted = false;
}

/**
 * Record a tool approval decision to the audit log. Never throws.
 */
export function auditApproval(entry: AuditEntry): void {
  try {
    const line = JSON.stringify({
      ...entry,
      inputSummary: sanitizeInput(entry.inputSummary),
    }) + "\n";
    getStream().write(line);
  } catch {
    // Silently discard
  }
}

/**
 * Structured log entry for every tool execution (success or failure).
 * Written after the tool returns so durationMs and isError are known.
 */
export interface ToolCallEntry {
  event: "tool_call";
  ts: string;
  sessionId: string;
  toolName: string;
  /** Sanitized subset of tool input (large values truncated to 500 chars) */
  inputSummary: Record<string, unknown>;
  isError: boolean;
  /** Wall-clock execution time in milliseconds */
  durationMs: number;
  /** First 200 characters of the tool result (omitted on timeout/throw) */
  resultSummary?: string;
}

/**
 * Record a single tool execution to the audit log. Never throws.
 */
export function logToolCall(entry: ToolCallEntry): void {
  try {
    const line = JSON.stringify({
      ...entry,
      inputSummary: sanitizeInput(entry.inputSummary),
    }) + "\n";
    getStream().write(line);
  } catch {
    // Silently discard
  }
}

/**
 * Record a sandbox path violation to the audit log. Never throws.
 */
export function logSandboxViolation(entry: { path: string; sandboxRoot: string; ts: number }): void {
  try {
    const line = JSON.stringify({ event: "sandbox_violation", ...entry }) + "\n";
    getStream().write(line);
  } catch {
    // Silently discard
  }
}
