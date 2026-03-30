/**
 * Append-only NDJSON audit log for tool approval decisions.
 *
 * Written to ORAGER_AUDIT_LOG env var path, or ~/.orager/audit.log by default.
 * Each line is a JSON object describing one approval decision.
 * Write failures are silently discarded — audit logging must never crash the agent.
 */
import fs from "node:fs";
import { mkdir, stat as statAsync, rename as renameAsync } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

const AUDIT_LOG_PATH =
  process.env["ORAGER_AUDIT_LOG"] ??
  path.join(os.homedir(), ".orager", "audit.log");

let _stream: fs.WriteStream | null = null;
let _dirInit: Promise<void> | null = null;
let _auditErrorEmitted = false;

async function ensureAuditDir(): Promise<void> {
  // Create parent directory with restricted permissions (user-only).
  await mkdir(path.dirname(AUDIT_LOG_PATH), { recursive: true, mode: 0o700 }).catch(() => {});

  // Rotate the log file if it has grown beyond the size limit.
  try {
    const s = await statAsync(AUDIT_LOG_PATH);
    if (s.size >= MAX_AUDIT_LOG_BYTES) {
      await renameAsync(AUDIT_LOG_PATH, `${AUDIT_LOG_PATH}.1`).catch(() => {});
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
    _stream = fs.createWriteStream(AUDIT_LOG_PATH, { flags: "a", encoding: "utf8", mode: 0o600 });
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
 * Truncate string values in an object to keep audit entries compact.
 */
function sanitizeInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === "string" && v.length > 500) {
      out[k] = v.slice(0, 500) + `…(${v.length - 500} more chars)`;
    } else if (typeof v === "object" && v !== null) {
      out[k] = "[object]";
    } else {
      out[k] = v;
    }
  }
  return out;
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
