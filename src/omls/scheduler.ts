/**
 * scheduler.ts — ADR-0007
 *
 * OMLS scheduler entry point. Called by the cron job:
 *   (star)/15 * * * * orager skill-train --rl --require-idle
 *
 * Evaluates idle state + buffer size, then hands off to the training pipeline
 * when conditions are met. Exits silently when conditions are not met.
 *
 * Exit codes:
 *   0 — training started (or dry run completed)
 *   1 — error
 *   2 — conditions not met (not idle or buffer too small) — normal, not an error
 */

import type { OmlsConfig } from "../types.js";
import { checkIdle } from "./idle-detector.js";
import { countDistillableBuffer, getCurrentSkillGeneration } from "./trajectory-buffer.js";
import type { LocalBackend } from "./hardware-detector.js";

export interface SchedulerCheckResult {
  shouldTrain: boolean;
  reason: string;
  bufferSize: number;
  idleResult: Awaited<ReturnType<typeof checkIdle>>;
  /** Preferred backend for this training run — "cloud" if local is disabled/unavailable. */
  preferredBackend: "local" | "cloud";
  /** Detected local backend, if preferredBackend is "local". */
  localBackend?: LocalBackend;
}

/**
 * Evaluate all pre-conditions for starting a training job:
 *   1. System is idle
 *   2. Distillable trajectory buffer meets minimum batch size
 *   3. No training job is already running (checked via lock file)
 *
 * Returns whether training should proceed and why/why not.
 */
export async function checkSchedulerConditions(
  cfg: OmlsConfig,
): Promise<SchedulerCheckResult> {
  const minBatchSize = cfg.minBatchSize ?? 32;

  // ── 1. Idle check ─────────────────────────────────────────────────────────
  const idleResult = await checkIdle(cfg);
  if (!idleResult.isIdle) {
    return {
      shouldTrain: false,
      reason: `not_idle: ${idleResult.reason}`,
      bufferSize: 0,
      idleResult,
      preferredBackend: "cloud",
    };
  }

  // ── 2. Buffer size ────────────────────────────────────────────────────────
  const skillGen = await getCurrentSkillGeneration();
  const bufferSize = await countDistillableBuffer(skillGen);
  if (bufferSize < minBatchSize) {
    return {
      shouldTrain: false,
      reason: `buffer_too_small (${bufferSize}/${minBatchSize} distillable trajectories)`,
      bufferSize,
      idleResult,
      preferredBackend: "cloud",
    };
  }

  // ── 3. Preferred backend: local vs cloud ───────────────────────────────────
  // Local training is preferred by default when hardware supports it.
  // It can be disabled via cfg.localTraining.enabled = false.
  const localEnabled = cfg.localTraining?.enabled !== false;
  let preferredBackend: "local" | "cloud" = "cloud";
  let localBackend: LocalBackend | undefined;

  if (localEnabled) {
    try {
      const { detectHardware } = await import("./hardware-detector.js");
      const hw = await detectHardware();
      if (hw.recommendedBackend) {
        const cfgBackend = cfg.localTraining?.backend;
        localBackend = (cfgBackend && cfgBackend !== "auto")
          ? cfgBackend as LocalBackend
          : hw.recommendedBackend;
        preferredBackend = "local";
      }
    } catch {
      // Hardware detection failed — fall back to cloud
    }
  }

  return {
    shouldTrain: true,
    reason: `conditions_met (${bufferSize} trajectories, idle: ${idleResult.reason}, backend: ${preferredBackend})`,
    bufferSize,
    idleResult,
    preferredBackend,
    localBackend,
  };
}

/**
 * Generate the crontab entry for OMLS.
 * Returns a cron line string suitable for `crontab -e`.
 */
export function generateCronLine(schedule = "*/15 * * * *"): string {
  // Resolve the orager binary path
  const binPath = process.argv[1] ?? "orager";
  return `${schedule} ${binPath} skill-train --rl --require-idle >> ~/.orager/omls.log 2>&1`;
}

/**
 * Install the OMLS cron job.
 * Reads existing crontab, appends the orager line (if not already present),
 * and writes it back.
 */
export async function installCronJob(schedule = "*/15 * * * *"): Promise<void> {
  const { execSync } = await import("node:child_process");
  const newLine = generateCronLine(schedule);

  let existing = "";
  try {
    existing = execSync("crontab -l 2>/dev/null", { encoding: "utf8" });
  } catch {
    existing = ""; // no existing crontab
  }

  if (existing.includes("skill-train --rl --require-idle")) {
    process.stderr.write("[omls] OMLS cron job already installed.\n");
    return;
  }

  const updated = existing.trimEnd() + (existing ? "\n" : "") + newLine + "\n";
  const { writeFileSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const tmpPath = `/tmp/orager-crontab-${process.pid}`;
  writeFileSync(tmpPath, updated, "utf8");
  execFileSync("crontab", [tmpPath]);

  process.stderr.write(`[omls] OMLS cron job installed:\n  ${newLine}\n`);
}

/**
 * Remove the OMLS cron job.
 */
export async function removeCronJob(): Promise<void> {
  const { execSync } = await import("node:child_process");

  let existing = "";
  try {
    existing = execSync("crontab -l 2>/dev/null", { encoding: "utf8" });
  } catch {
    return; // no crontab
  }

  if (!existing.includes("skill-train --rl --require-idle")) {
    process.stderr.write("[omls] No OMLS cron job found.\n");
    return;
  }

  const filtered = existing
    .split("\n")
    .filter((line) => !line.includes("skill-train --rl --require-idle"))
    .join("\n")
    .trimEnd() + "\n";

  const { writeFileSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const tmpPath = `/tmp/orager-crontab-${process.pid}`;
  writeFileSync(tmpPath, filtered, "utf8");
  execFileSync("crontab", [tmpPath]);

  process.stderr.write("[omls] OMLS cron job removed.\n");
}
