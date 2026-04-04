/**
 * local-training-pipeline.ts — ADR-0009 Phase 2
 *
 * Local training pipeline — the on-device counterpart to training-pipeline.ts.
 *
 * Steps:
 *   Step 1: Package trajectory batch          (same as cloud pipeline)
 *   Step 2: PRM scoring                       (same as cloud pipeline)
 *   Step 3: Detect hardware + select backend  (new — replaces VPS launch)
 *   Step 4: Run local training                (MLX or peft/CPU/CUDA)
 *   Step 5: Save adapter + write metadata     (new — replaces Together AI upload)
 *   Step 6: Log result
 *
 * Called by the scheduler when local training is preferred/enabled,
 * or directly via `orager skill-train --local`.
 *
 * Adapter output:
 *   ~/.orager/models/<memoryKey>/<baseModel>/adapter.safetensors
 *   ~/.orager/models/<memoryKey>/<baseModel>/adapter.meta.json
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { OmlsConfig } from "../types.js";
import {
  scanDistillableBuffer,
  packageBatch,
  markBatchTrained,
  getCurrentSkillGeneration,
  type TrainingBatch,
} from "./trajectory-buffer.js";
import { scoreTrajectory } from "./prm-scorer.js";
import { isSupportedBaseModel, DEFAULT_BASE_MODEL_ID } from "./supported-models.js";
import {
  detectHardware,
  describeHardware,
  installInstructions,
  resolveAdapterDir,
  resolveAdapterPath,
  resolveAdapterMetaPath,
  type LocalBackend,
  type AdapterMeta,
} from "./hardware-detector.js";
import { trainWithMLX } from "./mlx-trainer.js";
import { trainWithLlamaCpp } from "./llamacpp-trainer.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LocalPipelineResult {
  success: boolean;
  version?: number;
  adapterPath?: string;
  backend?: LocalBackend;
  durationMs?: number;
  error?: string;
  steps: Array<{ step: string; status: "ok" | "error" | "skipped"; durationMs: number; detail?: string }>;
}

export interface LocalPipelineOptions {
  dryRun?: boolean;
  /** Override the detected backend. */
  backendOverride?: LocalBackend;
  /** Memory namespace — used for adapter path resolution. */
  memoryKey: string;
  apiKey: string;
  cfg: OmlsConfig;
  onProgress?: (msg: string) => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function readAdapterVersion(memoryKey: string, baseModel: string): Promise<number> {
  try {
    const metaPath = resolveAdapterMetaPath(memoryKey, baseModel);
    const raw = await fs.readFile(metaPath, "utf8");
    const meta = JSON.parse(raw) as AdapterMeta;
    return (meta.version ?? 0) + 1;
  } catch {
    return 1;
  }
}

// ── Main pipeline ─────────────────────────────────────────────────────────────

/**
 * Run the local OMLS training pipeline.
 *
 * Returns a LocalPipelineResult with step-by-step details.
 * On success, the adapter is saved to ~/.orager/models/<memoryKey>/<baseModel>/.
 */
export async function runLocalTrainingPipeline(
  opts: LocalPipelineOptions,
): Promise<LocalPipelineResult> {
  const { dryRun = false, memoryKey, apiKey, cfg } = opts;
  const log = opts.onProgress ?? ((msg: string) => process.stderr.write(msg));

  const result: LocalPipelineResult = { success: false, steps: [] };
  const step = (name: string) => ({ name, startMs: Date.now() });
  const ok = (s: ReturnType<typeof step>, detail?: string) => {
    result.steps.push({ step: s.name, status: "ok", durationMs: Date.now() - s.startMs, detail });
  };
  const fail = (s: ReturnType<typeof step>, detail: string) => {
    result.steps.push({ step: s.name, status: "error", durationMs: Date.now() - s.startMs, detail });
    result.error = detail;
  };
  const skip = (s: ReturnType<typeof step>, detail?: string) => {
    result.steps.push({ step: s.name, status: "skipped", durationMs: 0, detail });
  };

  const configuredBaseModel = cfg.rl?.training?.baseModel ?? DEFAULT_BASE_MODEL_ID;

  if (!isSupportedBaseModel(configuredBaseModel)) {
    result.error = `Unsupported base model: "${configuredBaseModel}". Run \`orager omls models\` to see the supported list.`;
    return result;
  }

  // ── Step 1: Package batch ──────────────────────────────────────────────────
  const s1 = step("package_batch");
  log("[local] Step 1/6: packaging trajectory batch…\n");
  const skillGen = await getCurrentSkillGeneration();
  const entries = await scanDistillableBuffer(skillGen);
  const minBatch = cfg.minBatchSize ?? 8;
  if (entries.length < minBatch) {
    fail(s1, `buffer too small (${entries.length}/${minBatch})`);
    return result;
  }
  let batch: TrainingBatch;
  try {
    batch = await packageBatch(entries);
  } catch (err) {
    fail(s1, `failed to package batch: ${err}`);
    return result;
  }
  ok(s1, `${batch.entries.length} trajectories → ${batch.batchDir}`);

  if (dryRun) {
    log(`[local] dry-run: ${batch.entries.length} trajectories ready for training\n`);
  }

  // ── Step 2: PRM scoring ────────────────────────────────────────────────────
  const s2 = step("prm_scoring");

  if (!apiKey) {
    // PRM scoring requires a cloud API key — skip gracefully if not set
    skip(s2, "PROTOCOL_API_KEY not set — skipping PRM scoring (all trajectories weighted equally)");
    log("[local] Step 2/6: skipping PRM scoring (no API key)\n");
  } else {
    log("[local] Step 2/6: scoring trajectories with PRM judge…\n");
    const judgeModel = cfg.teacherModels?.[0] ?? "deepseek/deepseek-r1";
    const prmScores: Record<string, { mean_score: number; weighted_score: number }> = {};
    try {
      for (const entry of batch.entries) {
        const scored = await scoreTrajectory(entry.jsonlPath, entry.meta, judgeModel, apiKey);
        prmScores[entry.sessionId] = {
          mean_score: scored.meanScore,
          weighted_score: scored.weightedScore,
        };
      }
      await fs.writeFile(
        path.join(batch.batchDir, "prm_scores.json"),
        JSON.stringify(prmScores, null, 2),
        "utf8",
      );
      ok(s2, `scored ${Object.keys(prmScores).length} trajectories`);
    } catch (err) {
      // Non-fatal — proceed without PRM scores
      skip(s2, `PRM scoring failed (${err}) — proceeding without scores`);
      log(`[local] PRM scoring failed: ${err} — continuing without scores\n`);
    }
  }

  // ── Step 3: Hardware detection ─────────────────────────────────────────────
  const s3 = step("hardware_detection");
  log("[local] Step 3/6: detecting hardware…\n");

  let backend: LocalBackend;
  try {
    const hw = await detectHardware();
    log(`[local] hardware: ${describeHardware(hw)}\n`);

    if (opts.backendOverride) {
      backend = opts.backendOverride;
      log(`[local] backend override: ${backend}\n`);
    } else if (hw.recommendedBackend) {
      backend = hw.recommendedBackend;
    } else {
      fail(s3, `insufficient RAM for local training (${hw.totalRamGb.toFixed(1)} GB — need 8 GB minimum)`);
      return result;
    }

    // Check if required Python packages are installed
    const needsMLX = backend === "mlx" && !hw.mlxInstalled;
    const needsPeft = (backend === "llamacpp-cpu" || backend === "llamacpp-cuda") && !hw.peftInstalled;
    if (needsMLX || needsPeft) {
      const installCmd = installInstructions(backend);
      fail(s3, `required Python packages not installed. Run: ${installCmd}`);
      return result;
    }

    ok(s3, `backend=${backend} model=${configuredBaseModel}`);
  } catch (err) {
    fail(s3, `hardware detection failed: ${err}`);
    return result;
  }

  result.backend = backend;

  // ── Step 4: Local training ─────────────────────────────────────────────────
  const s4 = step("local_training");
  log(`[local] Step 4/6: training with ${backend}…\n`);

  const adapterDir = resolveAdapterDir(memoryKey, configuredBaseModel);
  const trainOpts = {
    baseModel: configuredBaseModel,
    batch,
    adapterDir,
    loraRank: cfg.rl?.training?.loraRank,
    loraAlpha: cfg.rl?.training?.loraAlpha,
    epochs: cfg.rl?.training?.epochs,
    batchSize: cfg.rl?.training?.batchSize,
    learningRate: cfg.rl?.training?.learningRate,
    dryRun,
    onProgress: log,
  };

  let trainResult: { success: boolean; adapterPath?: string; durationMs: number; error?: string };
  if (backend === "mlx") {
    trainResult = await trainWithMLX(trainOpts);
  } else {
    trainResult = await trainWithLlamaCpp({
      ...trainOpts,
      backend: backend === "llamacpp-cuda" ? "cuda" : "cpu",
    });
  }

  if (!trainResult.success) {
    fail(s4, trainResult.error ?? "training failed");
    return result;
  }
  ok(s4, `completed in ${Math.round((trainResult.durationMs ?? 0) / 1000)}s`);

  // ── Step 5: Save adapter metadata ─────────────────────────────────────────
  const s5 = step("save_adapter");

  if (dryRun) {
    skip(s5, "dry-run — adapter not written");
    log("[local] dry-run: skipping adapter save\n");
    result.success = true;
    return result;
  }

  try {
    const version = await readAdapterVersion(memoryKey, configuredBaseModel);
    const adapterFile = resolveAdapterPath(memoryKey, configuredBaseModel);

    // Archive current adapter before overwriting (enables rollback)
    try {
      await fs.access(adapterFile);
      const prevVersion = version - 1;
      if (prevVersion >= 1) {
        const versionedPath = path.join(adapterDir, `adapter.v${prevVersion}.safetensors`);
        await fs.copyFile(adapterFile, versionedPath);
        log(`[local] archived adapter v${prevVersion} → ${path.basename(versionedPath)}\n`);
      }
    } catch { /* no existing adapter to archive */ }

    const meta: AdapterMeta = {
      version,
      baseModel: configuredBaseModel,
      memoryKey,
      backend,
      trainedAt: new Date().toISOString(),
      trajectoryCount: batch.entries.length,
      durationMs: trainResult.durationMs ?? 0,
    };
    await fs.mkdir(adapterDir, { recursive: true });
    await fs.writeFile(resolveAdapterMetaPath(memoryKey, configuredBaseModel), JSON.stringify(meta, null, 2) + "\n", "utf8");
    await markBatchTrained(batch);

    result.version = version;
    result.adapterPath = resolveAdapterPath(memoryKey, configuredBaseModel);
    ok(s5, `v${version} → ${result.adapterPath}`);
  } catch (err) {
    fail(s5, `failed to save adapter metadata: ${err}`);
    return result;
  }

  // ── Step 6: Log ───────────────────────────────────────────────────────────
  const s6 = step("log");
  const totalMs = result.steps.reduce((sum, s) => sum + s.durationMs, 0);
  const logEntry = {
    ts: new Date().toISOString(),
    version: result.version,
    baseModel: configuredBaseModel,
    backend,
    trajectoryCount: batch.entries.length,
    durationMs: totalMs,
    memoryKey,
  };
  try {
    const logPath = path.join(os.homedir(), ".orager", "omls.log");
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.appendFile(logPath, JSON.stringify(logEntry) + "\n", "utf8");
    ok(s6, `logged to ~/.orager/omls.log`);
  } catch {
    skip(s6, "log write failed — non-fatal");
  }

  log(`[local] training complete — adapter v${result.version} saved (${backend})\n`);
  result.success = true;
  return result;
}

/**
 * Load the current adapter metadata for a given memoryKey + baseModel.
 * Returns null if no adapter has been trained yet.
 */
export async function loadAdapterMeta(
  memoryKey: string,
  baseModel: string,
): Promise<AdapterMeta | null> {
  try {
    const raw = await fs.readFile(resolveAdapterMetaPath(memoryKey, baseModel), "utf8");
    return JSON.parse(raw) as AdapterMeta;
  } catch {
    return null;
  }
}
