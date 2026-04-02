/**
 * trajectory-logger.ts — ADR-0006
 *
 * Captures a full agent run as a JSONL trajectory file under
 * ~/.orager/trajectories/<sessionId>.jsonl, plus a sidecar
 * ~/.orager/trajectories/<sessionId>.meta.json.
 *
 * Design notes:
 *   - The session ID is not known at construction time (it's assigned inside
 *     runAgentLoop). Call setSessionId() once it becomes available — usually
 *     when the first "system.init" event fires.
 *   - Events are buffered in memory until setSessionId() is called, then
 *     flushed to disk lazily as a single atomic write on finalize().
 *   - All I/O errors are silently swallowed — a broken trajectory logger must
 *     never abort or degrade an agent run.
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { EmitEvent } from "./types.js";
import { getTrajectoriesDir, trajectoryPath, trajectoryMetaPath } from "./skillbank.js";

// ── Public types ──────────────────────────────────────────────────────────────

export interface TrajectoryMeta {
  sessionId: string;
  prompt: string;
  model: string;
  cwd: string;
  startedAt: string;
  finishedAt: string;
  subtype: string;
  totalCostUsd: number;
  turnCount: number;
}

export interface TrajectoryLogger {
  /** Set the session ID (call once, from the "system.init" event). */
  setSessionId(id: string): void;
  /** Record a single emit event. */
  onEvent(event: EmitEvent): void;
  /** Flush to disk, write the meta sidecar, and close. */
  finalize(): Promise<void>;
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create a new trajectory logger for a run.
 *
 * @param prompt  - The initial user prompt
 * @param model   - The model used for this run
 * @param cwd     - Working directory of the run
 */
export function createTrajectoryLogger(
  prompt: string,
  model: string,
  cwd: string,
): TrajectoryLogger {
  const startedAt = new Date().toISOString();

  // Event buffer — holds events until sessionId is known
  const buffer: EmitEvent[] = [];
  let sessionId: string | null = null;
  let finalized = false;

  // Outcome fields — extracted from the "result" event
  let resultSubtype = "unknown";
  let totalCostUsd = 0;
  let turnCount = 0;

  function setSessionId(id: string): void {
    if (sessionId !== null) return; // already set
    sessionId = id;
  }

  function onEvent(event: EmitEvent): void {
    if (finalized) return;

    // Eagerly capture the session ID from the init event
    if (event.type === "system" && event.subtype === "init") {
      setSessionId(event.session_id);
    }

    // Track outcome for the meta sidecar
    if (event.type === "result") {
      resultSubtype = event.subtype;
      totalCostUsd = event.total_cost_usd ?? 0;
      turnCount = event.turnCount ?? 0;
      if (!sessionId) setSessionId(event.session_id);
    }

    buffer.push(event);
  }

  async function finalize(): Promise<void> {
    if (finalized) return;
    finalized = true;

    if (!sessionId || buffer.length === 0) return;

    try {
      const dir = getTrajectoriesDir();
      await fs.mkdir(dir, { recursive: true });

      // Write JSONL trajectory
      const jsonlPath = trajectoryPath(sessionId);
      const lines = buffer.map((e) => JSON.stringify(e)).join("\n") + "\n";
      await fs.writeFile(jsonlPath, lines, { encoding: "utf8" });

      // Write meta sidecar
      const meta: TrajectoryMeta = {
        sessionId,
        prompt: prompt.slice(0, 500), // truncate to avoid huge meta files
        model,
        cwd,
        startedAt,
        finishedAt: new Date().toISOString(),
        subtype: resultSubtype,
        totalCostUsd,
        turnCount,
      };
      const metaPath = trajectoryMetaPath(sessionId);
      await fs.writeFile(metaPath, JSON.stringify(meta, null, 2) + "\n", { encoding: "utf8" });
    } catch (err) {
      process.stderr.write(
        `[trajectory-logger] finalize error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  return { setSessionId, onEvent, finalize };
}

// ── Pruning ───────────────────────────────────────────────────────────────────

/**
 * Delete trajectory files older than retentionDays.
 * Removes both .jsonl and .meta.json files.
 * Non-fatal — swallows all errors.
 */
export async function pruneOldTrajectories(retentionDays: number): Promise<void> {
  try {
    const dir = getTrajectoriesDir();
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return; // directory doesn't exist yet — nothing to prune
    }

    const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

    for (const entry of entries) {
      if (!entry.endsWith(".jsonl") && !entry.endsWith(".meta.json")) continue;
      const filePath = path.join(dir, entry);
      try {
        const stat = await fs.stat(filePath);
        if (stat.mtimeMs < cutoffMs) {
          await fs.unlink(filePath);
        }
      } catch { /* file may have already been deleted — skip */ }
    }
  } catch (err) {
    process.stderr.write(
      `[trajectory-logger] pruneOldTrajectories error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}
