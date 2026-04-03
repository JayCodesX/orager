/**
 * hardware-detector.ts — ADR-0009 Phase 2
 *
 * Detects local hardware capabilities to determine the appropriate local
 * OMLS training backend:
 *
 *   mlx          — Apple Silicon (M1+), uses mlx_lm.lora
 *   llamacpp-cuda — NVIDIA GPU, uses peft + bitsandbytes with CUDA
 *   llamacpp-cpu  — Any CPU, uses peft without GPU (slow but correct)
 *
 * Priority: mlx > llamacpp-cuda > llamacpp-cpu
 *
 * Adapter storage paths:
 *   ~/.orager/models/<memoryKey>/<sanitizedBaseModel>/adapter.safetensors
 *   ~/.orager/models/<memoryKey>/<sanitizedBaseModel>/adapter.meta.json
 */

import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type LocalBackend = "mlx" | "llamacpp-cuda" | "llamacpp-cpu";

export interface HardwareCapability {
  platform: NodeJS.Platform;
  arch: string;
  /** True when running on Apple Silicon (arm64 darwin). */
  isAppleSilicon: boolean;
  /** True when nvidia-smi is present and returns a GPU. */
  hasNvidiaGpu: boolean;
  /** Total system RAM in GB. */
  totalRamGb: number;
  /**
   * Recommended local training backend based on hardware.
   * null when total RAM < 8 GB (cannot train even a 7B model).
   */
  recommendedBackend: LocalBackend | null;
  /** Whether the hardware can realistically train a 7B QLoRA model. */
  canTrain7B: boolean;
  /** Whether mlx_lm Python package is installed. */
  mlxInstalled: boolean;
  /** Whether the peft/transformers Python packages are installed. */
  peftInstalled: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function checkPythonPackage(pkg: string): Promise<boolean> {
  try {
    await execFileAsync("python3", ["-c", `import ${pkg}`], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

async function checkNvidiaGpu(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"], {
      timeout: 5_000,
    });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Detect hardware capabilities for local OMLS training.
 * Performs async checks for Python packages and GPU availability.
 */
export async function detectHardware(): Promise<HardwareCapability> {
  const platform = process.platform;
  const arch = process.arch;
  const isAppleSilicon = platform === "darwin" && arch === "arm64";
  const totalRamGb = os.totalmem() / (1024 ** 3);

  const [hasNvidiaGpu, mlxInstalled, peftInstalled] = await Promise.all([
    isAppleSilicon ? Promise.resolve(false) : checkNvidiaGpu(),
    isAppleSilicon ? checkPythonPackage("mlx_lm") : Promise.resolve(false),
    checkPythonPackage("peft"),
  ]);

  const canTrain7B = totalRamGb >= 8;

  let recommendedBackend: LocalBackend | null = null;
  if (canTrain7B) {
    if (isAppleSilicon) {
      recommendedBackend = "mlx";
    } else if (hasNvidiaGpu) {
      recommendedBackend = "llamacpp-cuda";
    } else {
      recommendedBackend = "llamacpp-cpu";
    }
  }

  return {
    platform,
    arch,
    isAppleSilicon,
    hasNvidiaGpu,
    totalRamGb,
    recommendedBackend,
    canTrain7B,
    mlxInstalled,
    peftInstalled,
  };
}

/**
 * Returns a human-readable description of the hardware capability for CLI output.
 */
export function describeHardware(hw: HardwareCapability): string {
  const ram = hw.totalRamGb.toFixed(1);
  if (hw.isAppleSilicon) return `Apple Silicon (${hw.arch}, ${ram} GB unified memory)`;
  if (hw.hasNvidiaGpu) return `NVIDIA GPU detected (${ram} GB RAM)`;
  return `CPU-only (${hw.platform} ${hw.arch}, ${ram} GB RAM)`;
}

/**
 * Returns install instructions for the missing Python dependencies
 * required by the given backend.
 */
export function installInstructions(backend: LocalBackend): string {
  if (backend === "mlx") {
    return "pip install mlx-lm";
  }
  return "pip install peft transformers bitsandbytes accelerate datasets";
}

// ── Adapter path resolution ───────────────────────────────────────────────────

const ORAGER_DIR = path.join(os.homedir(), ".orager");

/**
 * Sanitize a model ID for use as a directory name.
 * "unsloth/Meta-Llama-3.1-8B-Instruct" → "unsloth__Meta-Llama-3.1-8B-Instruct"
 */
export function sanitizeModelId(modelId: string): string {
  return modelId.replace(/\//g, "__").replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * Resolve the directory where adapters are stored for a given
 * memoryKey + baseModel combination.
 *
 * ~/.orager/models/<memoryKey>/<sanitizedBaseModel>/
 */
export function resolveAdapterDir(memoryKey: string, baseModel: string): string {
  return path.join(ORAGER_DIR, "models", memoryKey, sanitizeModelId(baseModel));
}

/**
 * Resolve the adapter file path for a given backend.
 * Both MLX and peft/llama.cpp output .safetensors adapters.
 * The .meta.json file distinguishes format and training provenance.
 */
export function resolveAdapterPath(memoryKey: string, baseModel: string): string {
  return path.join(resolveAdapterDir(memoryKey, baseModel), "adapter.safetensors");
}

export function resolveAdapterMetaPath(memoryKey: string, baseModel: string): string {
  return path.join(resolveAdapterDir(memoryKey, baseModel), "adapter.meta.json");
}

export interface AdapterMeta {
  version: number;
  baseModel: string;
  memoryKey: string;
  backend: LocalBackend;
  trainedAt: string;
  trajectoryCount: number;
  durationMs: number;
}
