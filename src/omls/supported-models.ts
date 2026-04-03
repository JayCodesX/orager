/**
 * OMLS supported model registry.
 *
 * Two distinct model categories:
 *
 *  1. BASE MODELS — Open-weight models downloaded locally and fine-tuned via
 *     QLoRA. No API key required. One active at a time per user. All adapters
 *     are hard-tied to the base model they were trained on; switching base
 *     models discards all existing adapters.
 *
 *  2. TEACHER MODELS — Frontier cloud models used as oracles during distillation
 *     (OPSD) and as PRM judges during training. Require PROTOCOL_API_KEY.
 *     Multiple teachers are allowed — they are called in "race" mode and the
 *     PRM picks the winner. Switching teacher models does NOT affect adapters.
 */

// ── Base model registry ───────────────────────────────────────────────────────

export interface BaseModelSpec {
  /** Canonical model ID used in training scripts (Unsloth / HuggingFace Hub). */
  id: string;
  /** Human-readable name shown in UI / CLI. */
  label: string;
  /** Approximate parameter count label. */
  size: string;
  /** Minimum VRAM required for 4-bit QLoRA training. */
  minVramGb: number;
  /** Whether this model trains well on Apple Silicon via MLX. */
  appleSilicon: boolean;
  /** Whether this model trains well on NVIDIA GPUs via llama.cpp / Unsloth. */
  nvidia: boolean;
  /**
   * Requires PROTOCOL_API_KEY: NO.
   * Base models are downloaded to disk and run locally. No API key needed
   * for inference or training.
   */
  requiresApiKey: false;
  /** Recommended for users who want the safest default (widest tooling support). */
  isDefault?: boolean;
  /** Note shown to users when selecting this model. */
  note?: string;
  /** Input modalities this model supports. Default: ["text"]. */
  modalities?: Array<"text" | "vision">;
}

/**
 * Curated list of supported base models for OMLS fine-tuning.
 *
 * Research basis (ADR-0009):
 * - 5 families covers the realistic set any local user would want
 * - More families add download/maintenance surface with no coverage benefit
 * - All are QLoRA-trainable on a 24 GB GPU and most on Apple Silicon 16 GB
 */
export const SUPPORTED_BASE_MODELS: BaseModelSpec[] = [
  {
    id: "unsloth/Meta-Llama-3.1-8B-Instruct",
    label: "Llama 3.1 8B Instruct",
    size: "8B",
    minVramGb: 8,
    appleSilicon: true,
    nvidia: true,
    requiresApiKey: false,
    isDefault: true,
    note: "Widest fine-tuning tooling support and strongest community track record. Best default for most users.",
  },
  {
    id: "unsloth/Qwen2.5-7B-Instruct",
    label: "Qwen 2.5 7B Instruct",
    size: "7B",
    minVramGb: 8,
    appleSilicon: true,
    nvidia: true,
    requiresApiKey: false,
    note: "Best for multilingual workloads or Apple Silicon. Strong coding and instruction-following performance.",
  },
  {
    id: "unsloth/mistral-7b-instruct-v0.3",
    label: "Mistral 7B Instruct v0.3",
    size: "7B",
    minVramGb: 8,
    appleSilicon: true,
    nvidia: true,
    requiresApiKey: false,
    note: "Compact and fast. Best choice for users prioritizing low latency over raw capability.",
  },
  {
    id: "unsloth/gemma-3-9b-it",
    label: "Gemma 3 9B Instruct",
    size: "9B",
    minVramGb: 10,
    appleSilicon: true,
    nvidia: true,
    requiresApiKey: false,
    note: "Google's latest open model. Strong at structured outputs and code. Requires 10 GB VRAM minimum.",
  },
  {
    id: "unsloth/DeepSeek-R1-Distill-Llama-8B",
    label: "DeepSeek-R1-Distill 8B",
    size: "8B",
    minVramGb: 8,
    appleSilicon: true,
    nvidia: true,
    requiresApiKey: false,
    note: "Reasoning-optimised distillation of DeepSeek-R1. Best for multi-step problem solving tasks.",
  },
  {
    id: "meta-llama/Llama-3.2-11B-Vision-Instruct",
    label: "Llama 3.2 Vision 11B Instruct",
    size: "11B",
    minVramGb: 12,
    appleSilicon: true,
    nvidia: true,
    requiresApiKey: false,
    modalities: ["text", "vision"],
    note: "Meta's multimodal Llama. Supports image+text prompts. Uses mlx-vlm on Apple Silicon.",
  },
  {
    id: "Qwen/Qwen2-VL-7B-Instruct",
    label: "Qwen2-VL 7B Instruct",
    size: "7B",
    minVramGb: 10,
    appleSilicon: true,
    nvidia: true,
    requiresApiKey: false,
    modalities: ["text", "vision"],
    note: "Strong vision-language model. Handles documents, charts, and natural images well.",
  },
  {
    id: "microsoft/Phi-3.5-vision-instruct",
    label: "Phi-3.5 Vision Instruct",
    size: "4B",
    minVramGb: 6,
    appleSilicon: true,
    nvidia: true,
    requiresApiKey: false,
    modalities: ["text", "vision"],
    note: "Compact multimodal model. Best for resource-constrained devices that need vision support.",
  },
];

/** The default base model ID used when none is configured. */
export const DEFAULT_BASE_MODEL_ID = SUPPORTED_BASE_MODELS.find((m) => m.isDefault)!.id;

/** Model IDs as a set for O(1) validation. */
const SUPPORTED_IDS = new Set(SUPPORTED_BASE_MODELS.map((m) => m.id));

/**
 * Returns true if `modelId` is in the supported base model list.
 */
export function isSupportedBaseModel(modelId: string): boolean {
  return SUPPORTED_IDS.has(modelId);
}

/**
 * Returns the BaseModelSpec for `modelId`, or undefined if not found.
 */
export function getBaseModelSpec(modelId: string): BaseModelSpec | undefined {
  return SUPPORTED_BASE_MODELS.find((m) => m.id === modelId);
}

/**
 * Returns true if the given base model supports vision (image) inputs.
 */
export function modelSupportsVision(modelId: string): boolean {
  const spec = getBaseModelSpec(modelId);
  return spec?.modalities?.includes("vision") ?? false;
}

// ── Teacher model registry ────────────────────────────────────────────────────

export interface TeacherModelSpec {
  /** OpenRouter model ID. */
  id: string;
  /** Human-readable name. */
  label: string;
  /**
   * Requires PROTOCOL_API_KEY: YES.
   * Teacher models are cloud frontier models called via OpenRouter during
   * distillation (OPSD) and PRM scoring. PROTOCOL_API_KEY must be set.
   */
  requiresApiKey: true;
  /** Note for users. */
  note?: string;
}

/**
 * Default teacher models used for distillation and PRM scoring.
 * Called in parallel ("race" mode) — PRM picks the best response.
 * Both require PROTOCOL_API_KEY to be set.
 */
export const DEFAULT_TEACHER_MODELS: TeacherModelSpec[] = [
  {
    id: "deepseek/deepseek-r1",
    label: "DeepSeek R1",
    requiresApiKey: true,
    note: "Strongest open-source reasoning model. Best PRM judge for multi-step tasks.",
  },
  {
    id: "qwen/qwen3-72b",
    label: "Qwen 3 72B",
    requiresApiKey: true,
    note: "Strong multilingual and coding teacher. Complements DeepSeek-R1 in race mode.",
  },
];
