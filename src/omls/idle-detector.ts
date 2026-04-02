/**
 * idle-detector.ts — ADR-0007
 *
 * Detects user idle state from three sources:
 *   1. Configured sleep window (sleepStart / sleepEnd, 24h HH:MM)
 *   2. Keyboard/mouse idle time via platform-native tools
 *      - macOS: `ioreg -c IOHIDSystem` → HIDIdleTime nanoseconds
 *      - Linux: `xprintidle` → milliseconds
 *   3. Google Calendar API occupancy check (optional)
 *
 * The user is considered idle when ALL of these are true:
 *   - Not within a configured "active" window (or no window is configured)
 *   - Keyboard idle for at least idleThresholdMinutes
 *   - Not currently in a calendar event (if credentials are provided)
 *
 * All checks are non-fatal — errors default to "not idle" (safe direction).
 */

import { execSync } from "node:child_process";
import type { OmlsConfig } from "../types.js";

// ── Sleep window ──────────────────────────────────────────────────────────────

/** Parse "HH:MM" → total minutes since midnight. */
function parseHHMM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = parseInt(m[1]!, 10);
  const min = parseInt(m[2]!, 10);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Return true if the current local time is within the configured sleep window. */
export function isInSleepWindow(sleepStart: string, sleepEnd: string): boolean {
  const start = parseHHMM(sleepStart);
  const end = parseHHMM(sleepEnd);
  if (start === null || end === null) return false;

  const now = new Date();
  const current = now.getHours() * 60 + now.getMinutes();

  if (start <= end) {
    // Simple range: 01:00 – 06:00
    return current >= start && current < end;
  } else {
    // Overnight range: 23:00 – 07:00
    return current >= start || current < end;
  }
}

// ── Platform idle time ────────────────────────────────────────────────────────

/**
 * Return keyboard/mouse idle time in seconds on macOS via ioreg.
 * Returns null on error or non-macOS platform.
 */
function getMacOsIdleSeconds(): number | null {
  try {
    const out = execSync(
      "ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print $NF; exit}'",
      { timeout: 3000, encoding: "utf8" },
    ).trim();
    const ns = parseFloat(out);
    if (isNaN(ns)) return null;
    return ns / 1e9; // nanoseconds → seconds
  } catch {
    return null;
  }
}

/**
 * Return keyboard/mouse idle time in seconds on Linux via xprintidle.
 * Returns null on error or if xprintidle is not installed.
 */
function getLinuxIdleSeconds(): number | null {
  try {
    const out = execSync("xprintidle", { timeout: 3000, encoding: "utf8" }).trim();
    const ms = parseFloat(out);
    if (isNaN(ms)) return null;
    return ms / 1000; // milliseconds → seconds
  } catch {
    return null;
  }
}

/**
 * Return the current system idle time in seconds.
 * Returns null when idle time cannot be determined.
 */
export function getIdleSeconds(): number | null {
  const platform = process.platform;
  if (platform === "darwin") return getMacOsIdleSeconds();
  if (platform === "linux") return getLinuxIdleSeconds();
  return null; // unsupported platform — treat as unknown
}

// ── Google Calendar check ─────────────────────────────────────────────────────

/**
 * Check whether the user has a current Google Calendar event.
 * Returns false (not busy) on any error, missing credentials, or
 * when the google-auth-library is not installed.
 *
 * This is intentionally lightweight — we make one API call to the freebusy
 * endpoint rather than listing full event details.
 */
export async function isCalendarBusy(credentialsPath: string): Promise<boolean> {
  try {
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(credentialsPath, "utf8");
    const credentials = JSON.parse(raw) as Record<string, unknown>;

    // Dynamic import — don't fail if not installed
    const { google } = await import("googleapis" as string) as {
      google: { auth: { GoogleAuth: new (opts: Record<string, unknown>) => unknown }; calendar: (opts: unknown) => unknown };
    };

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    }) as { getClient: () => Promise<unknown> };

    const authClient = await auth.getClient();
    const calendar = google.calendar({ version: "v3", auth: authClient });

    const now = new Date();
    const tenMinLater = new Date(now.getTime() + 10 * 60 * 1000);

    const res = await (calendar as {
      freebusy: { query: (opts: unknown) => Promise<{ data: { calendars?: Record<string, { busy?: Array<unknown> }> } }> }
    }).freebusy.query({
      requestBody: {
        timeMin: now.toISOString(),
        timeMax: tenMinLater.toISOString(),
        items: [{ id: "primary" }],
      },
    });

    const busy = res.data.calendars?.["primary"]?.busy ?? [];
    return busy.length > 0;
  } catch {
    return false; // assume not busy on any error
  }
}

// ── Main idle check ───────────────────────────────────────────────────────────

export interface IdleCheckResult {
  isIdle: boolean;
  reason: string;
  idleSeconds: number | null;
  inSleepWindow: boolean;
  calendarBusy: boolean;
}

/**
 * Evaluate whether the system is idle enough to start an OMLS training job.
 * Returns an IdleCheckResult with the verdict and individual signal values.
 */
export async function checkIdle(cfg: OmlsConfig): Promise<IdleCheckResult> {
  const sleepStart = cfg.sleepStart ?? "23:00";
  const sleepEnd = cfg.sleepEnd ?? "07:00";
  const idleThresholdMinutes = cfg.idleThresholdMinutes ?? 10;
  const idleThresholdSec = idleThresholdMinutes * 60;

  // ── 1. Sleep window ──────────────────────────────────────────────────────
  const inSleepWindow = isInSleepWindow(sleepStart, sleepEnd);
  if (inSleepWindow) {
    // In sleep window — automatically considered idle; skip keyboard check
    return {
      isIdle: true,
      reason: "sleep_window",
      idleSeconds: null,
      inSleepWindow: true,
      calendarBusy: false,
    };
  }

  // ── 2. Keyboard idle time ────────────────────────────────────────────────
  const idleSeconds = getIdleSeconds();
  if (idleSeconds === null) {
    // Cannot determine idle time — skip training (safe direction)
    return {
      isIdle: false,
      reason: "idle_time_unknown",
      idleSeconds: null,
      inSleepWindow: false,
      calendarBusy: false,
    };
  }
  if (idleSeconds < idleThresholdSec) {
    return {
      isIdle: false,
      reason: `keyboard_active (${Math.round(idleSeconds)}s idle, need ${idleThresholdSec}s)`,
      idleSeconds,
      inSleepWindow: false,
      calendarBusy: false,
    };
  }

  // ── 3. Google Calendar (optional) ────────────────────────────────────────
  let calendarBusy = false;
  if (cfg.calendarCredentials) {
    calendarBusy = await isCalendarBusy(cfg.calendarCredentials);
    if (calendarBusy) {
      return {
        isIdle: false,
        reason: "calendar_event_active",
        idleSeconds,
        inSleepWindow: false,
        calendarBusy: true,
      };
    }
  }

  return {
    isIdle: true,
    reason: `keyboard_idle (${Math.round(idleSeconds)}s)`,
    idleSeconds,
    inSleepWindow: false,
    calendarBusy: false,
  };
}
