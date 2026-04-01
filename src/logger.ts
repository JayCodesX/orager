/**
 * Structured JSON logger for orager.
 *
 * Default mode (ORAGER_LOG_FILE not set):
 *   Writes to ~/.orager/logs/orager.YYYY-MM-DD.log (local-timezone date).
 *   A new file is created each day; files older than ORAGER_LOG_RETENTION_DAYS
 *   (default 14) are deleted once per process on the first write of a new day.
 *   Override the directory with ORAGER_LOG_DIR.
 *
 * Legacy mode (ORAGER_LOG_FILE set):
 *   Appends to that single file; rotates to <path>.1 when the file exceeds
 *   ORAGER_LOG_MAX_SIZE_MB (default 100 MB). Fully backward-compatible.
 *
 * Structured stderr mode (ORAGER_LOG_STRUCTURED=true, ORAGER_LOG_FILE not set):
 *   Writes JSON to stderr. Useful in Docker / CI pipelines.
 *
 * All writes are synchronous (appendFileSync) and never throw.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface LogEvent {
  ts: string;
  level: "info" | "warn" | "error" | "debug";
  event: string;
  sessionId?: string;
  agentId?: string;
  model?: string;
  [key: string]: unknown;
}

// ── Public constants ──────────────────────────────────────────────────────────

/**
 * Matches daily log filenames: orager.2026-04-01.log
 * Capture group 1 is the date string "YYYY-MM-DD".
 */
export const DAILY_LOG_PATTERN = /^orager\.(\d{4}-\d{2}-\d{2})\.log$/;

const DEFAULT_LOG_MAX_SIZE_BYTES = 100 * 1024 * 1024;
const LOG_STRUCTURED = process.env["ORAGER_LOG_STRUCTURED"] === "true";

// ── Public helpers ────────────────────────────────────────────────────────────

/** Returns today's date as "YYYY-MM-DD" in local timezone. */
export function getTodayDateStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Returns the configured log directory (default ~/.orager/logs). */
export function getLogDir(): string {
  return process.env["ORAGER_LOG_DIR"] ?? path.join(os.homedir(), ".orager", "logs");
}

/**
 * True when daily rotation is active.
 * Daily rotation is the default; it is disabled only when ORAGER_LOG_FILE
 * is explicitly set (legacy single-file mode).
 */
export function isDailyRotation(): boolean {
  return !process.env["ORAGER_LOG_FILE"];
}

/** Returns the full path for a given daily log file. */
export function dailyLogPath(dateStr: string, logDir?: string): string {
  return path.join(logDir ?? getLogDir(), `orager.${dateStr}.log`);
}

// ── Legacy rotation helpers (exported for tests) ──────────────────────────────

export function _getLogFileSizeBytes(logPath: string): number {
  try {
    return fs.statSync(logPath).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    return 0;
  }
}

export function _maybeRotate(logPath: string, maxBytes: number): void {
  if (_getLogFileSizeBytes(logPath) > maxBytes) {
    try { fs.renameSync(logPath, `${logPath}.1`); } catch { /* non-fatal */ }
  }
}

// ── Daily rotation state ──────────────────────────────────────────────────────

interface RotationState {
  currentDate: string; // "YYYY-MM-DD" of the last written file
  currentPath: string; // absolute path currently being written to
  pruned: boolean;     // whether we've pruned old files this process lifetime
}

let _state: RotationState = { currentDate: "", currentPath: "", pruned: false };

/** Reset internal state — used in tests to isolate env var changes. */
export function _resetLoggerForTesting(): void {
  _state = { currentDate: "", currentPath: "", pruned: false };
}

// ── Pruning ───────────────────────────────────────────────────────────────────

function pruneOldLogs(logDir: string, retentionDays: number): void {
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);
    const cutoffDateStr = [
      cutoff.getFullYear(),
      String(cutoff.getMonth() + 1).padStart(2, "0"),
      String(cutoff.getDate()).padStart(2, "0"),
    ].join("-");

    const files = fs.readdirSync(logDir);
    for (const f of files) {
      const m = DAILY_LOG_PATTERN.exec(f);
      if (m && m[1]! < cutoffDateStr) {
        try { fs.unlinkSync(path.join(logDir, f)); } catch { /* non-fatal */ }
      }
    }
  } catch { /* non-fatal — directory may not exist yet */ }
}

// ── Core write ────────────────────────────────────────────────────────────────

export function logEvent(event: LogEvent): void {
  const line = JSON.stringify({ ...event, ts: event.ts ?? new Date().toISOString() }) + "\n";
  try {
    if (process.env["ORAGER_LOG_FILE"]) {
      // ── Legacy: single named file with size-based rotation ──────────────────
      const logFile = process.env["ORAGER_LOG_FILE"];
      const maxBytes =
        parseFloat(process.env["ORAGER_LOG_MAX_SIZE_MB"] ?? "100") * 1024 * 1024;
      _maybeRotate(logFile, isNaN(maxBytes) ? DEFAULT_LOG_MAX_SIZE_BYTES : maxBytes);
      fs.appendFileSync(logFile, line, { encoding: "utf8" });

    } else if (LOG_STRUCTURED) {
      // ── Structured stderr (Docker / CI) ─────────────────────────────────────
      process.stderr.write(line);

    } else {
      // ── Daily rotation (default) ─────────────────────────────────────────────
      const today = getTodayDateStr();
      if (today !== _state.currentDate) {
        const logDir = getLogDir();
        fs.mkdirSync(logDir, { recursive: true });
        _state.currentDate = today;
        _state.currentPath = dailyLogPath(today, logDir);

        // Prune once per process — triggered by the first write of a new day.
        if (!_state.pruned) {
          _state.pruned = true;
          const retentionDays = parseInt(
            process.env["ORAGER_LOG_RETENTION_DAYS"] ?? "14", 10,
          );
          pruneOldLogs(logDir, isNaN(retentionDays) ? 14 : retentionDays);
        }
      }
      fs.appendFileSync(_state.currentPath, line, { encoding: "utf8" });
    }
  } catch { /* silently discard — logger must never throw */ }
}

// ── Convenience helpers ───────────────────────────────────────────────────────

export const log = {
  info: (event: string, data?: Omit<LogEvent, "ts" | "level" | "event">) =>
    logEvent({ ts: new Date().toISOString(), level: "info", event, ...data }),
  warn: (event: string, data?: Omit<LogEvent, "ts" | "level" | "event">) =>
    logEvent({ ts: new Date().toISOString(), level: "warn", event, ...data }),
  error: (event: string, data?: Omit<LogEvent, "ts" | "level" | "event">) =>
    logEvent({ ts: new Date().toISOString(), level: "error", event, ...data }),
  debug: (event: string, data?: Omit<LogEvent, "ts" | "level" | "event">) =>
    logEvent({ ts: new Date().toISOString(), level: "debug", event, ...data }),
};
