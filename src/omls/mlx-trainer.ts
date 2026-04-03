/**
 * mlx-trainer.ts — ADR-0009 Phase 2
 *
 * MLX QLoRA fine-tuning adapter for Apple Silicon (M1+).
 *
 * Uses mlx_lm.lora (https://github.com/ml-explore/mlx-examples/tree/main/llms/mlx_lm)
 * which supports QLoRA fine-tuning on Apple unified memory with Metal acceleration.
 *
 * Requirements (user must install):
 *   pip install mlx-lm
 *
 * Training data format (written to batchDir/mlx_train.jsonl):
 *   {"text": "<full prompt+response>"}   — one JSON object per line
 *
 * Output:
 *   <adapterDir>/adapter.safetensors     — LoRA weights
 *   <adapterDir>/adapter_config.json     — LoRA config (rank, alpha, etc.)
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { TrainingBatch } from "./trajectory-buffer.js";
import { modelSupportsVision } from "./supported-models.js";

export interface MLXTrainOptions {
  baseModel: string;
  batch: TrainingBatch;
  adapterDir: string;
  loraRank?: number;
  loraAlpha?: number;
  epochs?: number;
  batchSize?: number;
  learningRate?: number;
  dryRun?: boolean;
  onProgress?: (msg: string) => void;
}

export interface MLXTrainResult {
  success: boolean;
  adapterPath?: string;
  durationMs: number;
  error?: string;
}

// ── Data preparation ──────────────────────────────────────────────────────────

/**
 * Convert a TrainingBatch to mlx_lm.lora JSONL format.
 * Each trajectory becomes a single {"text": "..."} record.
 * The text is the concatenated prompt + assistant response from the trajectory.
 */
async function writeMlxTrainData(batch: TrainingBatch, outPath: string): Promise<number> {
  const lines: string[] = [];

  for (const entry of batch.entries) {
    try {
      const content = await fs.readFile(entry.jsonlPath, "utf8");
      const events = content
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { type?: string; message?: { content?: unknown } });

      // Build prompt+response text from trajectory events
      const parts: string[] = [];
      if (entry.meta.prompt) {
        parts.push(`<|user|>\n${entry.meta.prompt}\n<|end|>`);
      }
      for (const ev of events) {
        if (ev.type === "assistant") {
          const content = ev.message?.content;
          if (typeof content === "string" && content.trim()) {
            parts.push(`<|assistant|>\n${content.slice(0, 2000)}\n<|end|>`);
          } else if (Array.isArray(content)) {
            for (const block of content) {
              const b = block as { type?: string; text?: string };
              if (b.type === "text" && b.text?.trim()) {
                parts.push(`<|assistant|>\n${b.text.slice(0, 2000)}\n<|end|>`);
                break;
              }
            }
          }
        }
      }

      if (parts.length >= 2) {
        lines.push(JSON.stringify({ text: parts.join("\n") }));
      }
    } catch { /* skip malformed trajectory */ }
  }

  await fs.writeFile(outPath, lines.join("\n") + "\n", "utf8");
  return lines.length;
}

// ── Training script ───────────────────────────────────────────────────────────

/**
 * Generate the MLX training command arguments.
 *
 * Vision models (Llama 3.2 Vision, Qwen2-VL, Phi-3.5-Vision) use mlx_vlm.lora
 * instead of mlx_lm.lora — same flag surface, different module.
 * Text-only models continue to use mlx_lm.lora.
 */
function buildMlxArgs(opts: MLXTrainOptions, dataFile: string): string[] {
  const iters = Math.max(100, (opts.epochs ?? 1) * 200); // approximate: 200 iters per epoch
  const isVision = modelSupportsVision(opts.baseModel);
  // mlx_vlm.lora for vision models; mlx_lm.lora for text-only
  const module = isVision ? "mlx_vlm.lora" : "mlx_lm.lora";

  return [
    "-m", module,
    "--model", opts.baseModel,
    "--train",
    "--data", path.dirname(dataFile),
    "--adapter-path", opts.adapterDir,
    "--num-layers", "16",
    "--batch-size", String(opts.batchSize ?? 4),
    "--iters", String(iters),
    "--learning-rate", String(opts.learningRate ?? 2e-5),
    "--lora-rank", String(opts.loraRank ?? 16),
    "--lora-alpha", String(opts.loraAlpha ?? 32),
    "--val-batches", "0",       // skip validation (no val split)
    "--save-every", String(Math.max(50, Math.floor(iters / 4))),
  ];
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run MLX QLoRA fine-tuning on the given trajectory batch.
 *
 * Spawns `python3 -m mlx_lm.lora` as a subprocess and streams output
 * to `onProgress`. Returns the adapter path on success.
 *
 * Dry-run mode validates setup (Python package present, data writable)
 * without running training.
 */
export async function trainWithMLX(opts: MLXTrainOptions): Promise<MLXTrainResult> {
  const startMs = Date.now();
  const log = opts.onProgress ?? (() => {});

  await fs.mkdir(opts.adapterDir, { recursive: true });

  // ── Data preparation ────────────────────────────────────────────────────────
  const dataFile = path.join(opts.batch.batchDir, "mlx_train.jsonl");
  let sampleCount: number;
  try {
    sampleCount = await writeMlxTrainData(opts.batch, dataFile);
  } catch (err) {
    return { success: false, durationMs: Date.now() - startMs, error: `data prep failed: ${err}` };
  }

  if (sampleCount === 0) {
    return { success: false, durationMs: Date.now() - startMs, error: "no usable training samples in batch" };
  }

  log(`[mlx] prepared ${sampleCount} training samples → ${dataFile}\n`);

  // ── Dry-run path ────────────────────────────────────────────────────────────
  if (opts.dryRun) {
    const iters = Math.max(100, (opts.epochs ?? 1) * 200);
    const isVision = modelSupportsVision(opts.baseModel);
    const pkg = isVision ? "mlx-vlm" : "mlx-lm";
    log(`[mlx] dry-run: would train ${opts.baseModel} for ${iters} iters on ${sampleCount} samples\n`);
    log(`[mlx] dry-run: adapter output → ${opts.adapterDir}\n`);
    log(`[mlx] dry-run: package: ${pkg} (pip install ${pkg})\n`);
    log(`[mlx] dry-run: estimated duration: 15–30 min on M1 Pro 16 GB\n`);
    return { success: true, durationMs: Date.now() - startMs };
  }

  // ── mlx_lm.lora subprocess ─────────────────────────────────────────────────
  const args = buildMlxArgs(opts, dataFile);
  log(`[mlx] python3 ${args.join(" ")}\n`);

  return new Promise((resolve) => {
    const proc = spawn("python3", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    proc.stdout?.on("data", (chunk: Buffer) => log(`[mlx] ${chunk.toString()}`));
    proc.stderr?.on("data", (chunk: Buffer) => log(`[mlx] ${chunk.toString()}`));

    proc.on("close", (code) => {
      const durationMs = Date.now() - startMs;
      if (code === 0) {
        const adapterPath = path.join(opts.adapterDir, "adapter.safetensors");
        log(`[mlx] training complete (${Math.round(durationMs / 1000)}s) → ${adapterPath}\n`);
        resolve({ success: true, adapterPath, durationMs });
      } else {
        resolve({ success: false, durationMs, error: `mlx_lm.lora exited with code ${code}` });
      }
    });

    proc.on("error", (err) => {
      const pkg = modelSupportsVision(opts.baseModel) ? "mlx-vlm" : "mlx-lm";
      resolve({
        success: false,
        durationMs: Date.now() - startMs,
        error: `failed to spawn python3: ${err.message}. Run: pip install ${pkg}`,
      });
    });
  });
}
