/**
 * Structured JSON logger for orager.
 *
 * When ORAGER_LOG_FILE is set, appends newline-delimited JSON events to that file.
 * When ORAGER_LOG_STRUCTURED=true (and no log file), writes JSON to stderr.
 * Otherwise, no-ops (human-readable logs go via onLog).
 *
 * Log entries are synchronous and never throw. Before each write the log file
 * size is checked; if it exceeds ORAGER_LOG_MAX_SIZE_MB (default 100 MB) the
 * file is rotated to <path>.1 and a new file is started.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface LogEvent {
  ts: string;           // ISO timestamp
  level: "info" | "warn" | "error" | "debug";
  event: string;        // machine-readable event name, e.g. "turn_complete"
  sessionId?: string;
  agentId?: string;
  model?: string;
  [key: string]: unknown;
}

const LOG_FILE = process.env["ORAGER_LOG_FILE"] ?? path.join(os.homedir(), ".orager", "orager.log");
const LOG_STRUCTURED = process.env["ORAGER_LOG_STRUCTURED"] === "true";

/** Default max log file size in bytes (100 MB). Overridable via ORAGER_LOG_MAX_SIZE_MB. */
const DEFAULT_LOG_MAX_SIZE_BYTES = 100 * 1024 * 1024;

/**
 * Return the current size of the log file in bytes.
 * Returns 0 if the file does not exist (ENOENT) or cannot be stat'd.
 * Exported for testing.
 */
export function _getLogFileSizeBytes(logPath: string): number {
  try {
    return fs.statSync(logPath).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    return 0; // Any other error — treat as unknown / not rotated
  }
}

/**
 * If the log file at `logPath` exceeds `maxBytes`, rotate it to `logPath.1`
 * (overwriting any previous rotation) then proceed fresh.
 * Exported for testing.
 */
export function _maybeRotate(logPath: string, maxBytes: number): void {
  if (_getLogFileSizeBytes(logPath) > maxBytes) {
    try {
      fs.renameSync(logPath, `${logPath}.1`);
    } catch {
      // Rotation failure is non-fatal — just continue writing to the existing file
    }
  }
}

/**
 * Emit a structured log event. Synchronous and never throws.
 */
export function logEvent(event: LogEvent): void {
  const line = JSON.stringify({ ...event, ts: event.ts ?? new Date().toISOString() }) + "\n";
  try {
    if (LOG_FILE) {
      const maxBytes = parseFloat(process.env["ORAGER_LOG_MAX_SIZE_MB"] ?? "100") * 1024 * 1024;
      _maybeRotate(LOG_FILE, isNaN(maxBytes) ? DEFAULT_LOG_MAX_SIZE_BYTES : maxBytes);
      fs.appendFileSync(LOG_FILE, line, { encoding: "utf8" });
    } else if (LOG_STRUCTURED) {
      process.stderr.write(line);
    }
  } catch {
    // Silently discard
  }
}

/**
 * Convenience helpers
 */
export const log = {
  info:  (event: string, data?: Omit<LogEvent, "ts" | "level" | "event">) =>
    logEvent({ ts: new Date().toISOString(), level: "info",  event, ...data }),
  warn:  (event: string, data?: Omit<LogEvent, "ts" | "level" | "event">) =>
    logEvent({ ts: new Date().toISOString(), level: "warn",  event, ...data }),
  error: (event: string, data?: Omit<LogEvent, "ts" | "level" | "event">) =>
    logEvent({ ts: new Date().toISOString(), level: "error", event, ...data }),
  debug: (event: string, data?: Omit<LogEvent, "ts" | "level" | "event">) =>
    logEvent({ ts: new Date().toISOString(), level: "debug", event, ...data }),
};
