/**
 * Structured JSON logger for orager.
 *
 * When ORAGER_LOG_FILE is set, appends newline-delimited JSON events to that file.
 * When ORAGER_LOG_STRUCTURED=true (and no log file), writes JSON to stderr.
 * Otherwise, no-ops (human-readable logs go via onLog).
 *
 * Log entries are non-blocking: write failures are silently discarded so a
 * logging issue never crashes the agent loop.
 */

import fs from "node:fs";

export interface LogEvent {
  ts: string;           // ISO timestamp
  level: "info" | "warn" | "error" | "debug";
  event: string;        // machine-readable event name, e.g. "turn_complete"
  sessionId?: string;
  agentId?: string;
  model?: string;
  [key: string]: unknown;
}

const LOG_FILE = process.env["ORAGER_LOG_FILE"];
const LOG_STRUCTURED = process.env["ORAGER_LOG_STRUCTURED"] === "true";

let _logStream: fs.WriteStream | null = null;

function getLogStream(): fs.WriteStream | null {
  if (!LOG_FILE) return null;
  if (!_logStream) {
    _logStream = fs.createWriteStream(LOG_FILE, { flags: "a", encoding: "utf8" });
    _logStream.on("error", () => {}); // Silently discard write errors
  }
  return _logStream;
}

/**
 * Emit a structured log event. Non-blocking and never throws.
 */
export function logEvent(event: LogEvent): void {
  const line = JSON.stringify({ ...event, ts: event.ts ?? new Date().toISOString() }) + "\n";
  try {
    const stream = getLogStream();
    if (stream) {
      stream.write(line);
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
