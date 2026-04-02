/**
 * trajectory-buffer.ts — ADR-0007
 *
 * Manages the pool of distillable trajectories available for RL training.
 *
 * Responsibilities:
 *   - Scan ~/.orager/trajectories/*.meta.json for distillable entries
 *   - Filter by minimum skillGeneration (support-query separation)
 *   - Count available samples vs. required minBatchSize
 *   - Package a batch into ~/.orager/training/batch-<timestamp>.tar.gz
 *   - Mark trajectories as "trained" after a successful RL cycle (purge)
 *
 * All functions are non-fatal — errors are logged to stderr and swallowed.
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import type { TrajectoryMeta } from "../trajectory-logger.js";
import { getTrajectoriesDir, trajectoryPath } from "../skillbank.js";

// ── Directory helpers ─────────────────────────────────────────────────────────

export function getTrainingDir(): string {
  return path.join(os.homedir(), ".orager", "training");
}

export function getTrainedTagPath(sessionId: string): string {
  return path.join(getTrajectoriesDir(), `${sessionId}.trained`);
}

// ── Meta reading ──────────────────────────────────────────────────────────────

async function readMeta(metaPath: string): Promise<TrajectoryMeta | null> {
  try {
    const raw = await fs.readFile(metaPath, "utf8");
    return JSON.parse(raw) as TrajectoryMeta;
  } catch {
    return null;
  }
}

// ── Buffer scan ───────────────────────────────────────────────────────────────

export interface BufferEntry {
  sessionId: string;
  meta: TrajectoryMeta;
  jsonlPath: string;
  metaPath: string;
}

/**
 * Scan the trajectories directory and return all distillable, untrained
 * entries that belong to the current or a higher skill generation.
 *
 * @param minSkillGeneration - Only include trajectories from this generation or later.
 *                             Pass 0 to include all generations.
 */
export async function scanDistillableBuffer(
  minSkillGeneration = 0,
): Promise<BufferEntry[]> {
  const dir = getTrajectoriesDir();
  const entries: BufferEntry[] = [];

  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return []; // directory doesn't exist yet
  }

  const metaFiles = files.filter((f) => f.endsWith(".meta.json"));

  for (const metaFile of metaFiles) {
    const sessionId = metaFile.replace(".meta.json", "");
    const metaFilePath = path.join(dir, metaFile);
    const jsonlFilePath = trajectoryPath(sessionId);
    const trainedTag = getTrainedTagPath(sessionId);

    // Skip already-trained trajectories
    try {
      await fs.access(trainedTag);
      continue; // tag exists → already trained
    } catch { /* not trained yet — proceed */ }

    const meta = await readMeta(metaFilePath);
    if (!meta) continue;
    if (!meta.distillable) continue;
    if (minSkillGeneration > 0 && (meta.skillGeneration ?? 0) < minSkillGeneration) continue;

    // Verify the .jsonl file exists
    try {
      await fs.access(jsonlFilePath);
    } catch {
      continue; // trajectory file missing
    }

    entries.push({ sessionId, meta, jsonlPath: jsonlFilePath, metaPath: metaFilePath });
  }

  return entries;
}

/**
 * Count distillable untrained trajectories available for a training batch.
 */
export async function countDistillableBuffer(minSkillGeneration = 0): Promise<number> {
  const entries = await scanDistillableBuffer(minSkillGeneration);
  return entries.length;
}

// ── Batch packaging ───────────────────────────────────────────────────────────

export interface TrainingBatch {
  batchId: string;
  batchDir: string;
  entries: BufferEntry[];
  manifestPath: string;
}

/**
 * Package a batch of distillable trajectories into a training directory.
 * Creates: ~/.orager/training/batch-<id>/
 *   - manifest.json       — batch metadata + entry list
 *   - trajectories/       — copied .jsonl + .meta.json files
 *
 * Returns the batch descriptor for use by the training pipeline.
 */
export async function packageBatch(
  entries: BufferEntry[],
  maxBatchSize = 128,
): Promise<TrainingBatch> {
  const batchId = `batch-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  const batchDir = path.join(getTrainingDir(), batchId);
  const trajDir = path.join(batchDir, "trajectories");

  await fs.mkdir(trajDir, { recursive: true });

  // Take up to maxBatchSize entries, newest first
  const selected = [...entries]
    .sort((a, b) => b.meta.finishedAt.localeCompare(a.meta.finishedAt))
    .slice(0, maxBatchSize);

  // Copy trajectory files into the batch directory
  for (const entry of selected) {
    const destJsonl = path.join(trajDir, `${entry.sessionId}.jsonl`);
    const destMeta = path.join(trajDir, `${entry.sessionId}.meta.json`);
    await fs.copyFile(entry.jsonlPath, destJsonl);
    await fs.copyFile(entry.metaPath, destMeta);
  }

  // Write manifest
  const manifest = {
    batchId,
    createdAt: new Date().toISOString(),
    count: selected.length,
    teacherModels: [...new Set(selected.map((e) => e.meta.teacherModel).filter(Boolean))],
    sessions: selected.map((e) => ({
      sessionId: e.sessionId,
      teacherModel: e.meta.teacherModel,
      routerSignal: e.meta.routerSignal,
      skillGeneration: e.meta.skillGeneration,
      finishedAt: e.meta.finishedAt,
      subtype: e.meta.subtype,
    })),
  };

  const manifestPath = path.join(batchDir, "manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  return { batchId, batchDir, entries: selected, manifestPath };
}

/**
 * Mark trajectories in a batch as trained so they are excluded from future batches.
 * Called after a successful RL training cycle.
 */
export async function markBatchTrained(batch: TrainingBatch): Promise<void> {
  for (const entry of batch.entries) {
    const tag = getTrainedTagPath(entry.sessionId);
    await fs.writeFile(tag, new Date().toISOString() + "\n", "utf8").catch(() => {
      /* non-fatal */
    });
  }
}

/**
 * Get the current skill generation from the skills table.
 * Used for support-query separation: only train on trajectories from the
 * latest skill generation.
 *
 * Returns 0 if unavailable (include all generations).
 */
export async function getCurrentSkillGeneration(): Promise<number> {
  try {
    const { _getDb } = await import("../memory-sqlite.js");
    const db = await _getDb();
    const row = db
      .prepare(
        "SELECT MAX(version) as v FROM skills WHERE deleted = 0",
      )
      .get() as { v: number | null } | undefined;
    return row?.v ?? 0;
  } catch {
    return 0;
  }
}
