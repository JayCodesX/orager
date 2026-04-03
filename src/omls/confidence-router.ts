/**
 * confidence-router.ts — ADR-0007
 *
 * Three-signal confidence router. Called before each `orager run` model call
 * to decide whether to serve locally (RL-trained model) or escalate to the
 * teacher model.
 *
 * Signal evaluation order (cheapest first):
 *   1. Task classifier       — embedding similarity to hard-task patterns (~1ms)
 *   2. Self-REF token        — extract calibrated score from model output (free)
 *   3. Semantic entropy gate — N=3 samples, temperature=0.8 (~50ms, fires rarely)
 *
 * Standing gates (always active via existing turnModelRules):
 *   - costAbove: 0.05 → escalate
 *   - afterTurn: 8   → escalate
 *
 * All functions are non-fatal. On any error the router defaults to "local"
 * (never fails a run due to routing infrastructure).
 */

import { getOpenRouterProvider } from "../providers/index.js";
import type { OmlsConfig, RouterSignal, ConfidenceRouterConfig } from "../types.js";
import { DEFAULT_TEACHER_MODELS, modelSupportsVision } from "./supported-models.js";
import { cosineSimilarity } from "../memory.js";

// ── Defaults ──────────────────────────────────────────────────────────────────

export const DEFAULT_ROUTER_CONFIG: Required<ConfidenceRouterConfig> = {
  confidenceThreshold: 0.40,
  entropyThreshold: 0.70,
  entropySamples: 3,
  entropyTemperature: 0.8,
};

function routerCfg(c?: ConfidenceRouterConfig): Required<ConfidenceRouterConfig> {
  return { ...DEFAULT_ROUTER_CONFIG, ...c };
}

// ── Routing result ────────────────────────────────────────────────────────────

export interface RoutingDecision {
  /** Model to use for this run. "local" = RL-trained model, or a specific model string. */
  model: string;
  /** Whether this decision escalated to a teacher model. */
  escalated: boolean;
  /** The signal that triggered the decision. */
  signal: RouterSignal;
  /** The confidence score extracted from the model output (0–1), if applicable. */
  confidenceScore?: number;
  /** The semantic entropy measured (0–1), if applicable. */
  entropy?: number;
}

// ── Hard-task pattern library ─────────────────────────────────────────────────
//
// These are task-agnostic descriptions of prompt patterns that orager's
// RL-trained model is unlikely to handle well:
//   - cross-repository reasoning
//   - novel architecture decisions
//   - multi-modal content
//   - complex multi-constraint instructions
//
// Stored as plain strings; embeddings are computed lazily and cached in-process.

const HARD_TASK_PATTERNS = [
  "design a new software architecture from scratch with multiple trade-offs",
  "reason across multiple repositories and codebases simultaneously",
  "analyze images, diagrams, or visual content",
  "solve a problem involving novel research not in training data",
  "handle conflicting constraints across many dimensions at once",
  "provide investment financial or legal advice",
  "write multi-step strategic plan with dependencies and risk analysis",
  "debug a subtle concurrency or distributed systems race condition",
];

// Module-level cache: pattern embeddings computed once per process
let _patternEmbeddings: number[][] | null = null;
let _patternEmbeddingModel: string | null = null;

async function getPatternEmbeddings(
  apiKey: string,
  embeddingModel: string,
): Promise<number[][]> {
  if (_patternEmbeddings && _patternEmbeddingModel === embeddingModel) {
    return _patternEmbeddings;
  }
  _patternEmbeddings = await getOpenRouterProvider().callEmbeddings!(apiKey, embeddingModel, HARD_TASK_PATTERNS);
  _patternEmbeddingModel = embeddingModel;
  return _patternEmbeddings;
}

// ── Signal 1: Task classifier ─────────────────────────────────────────────────

/**
 * Returns true if the prompt embedding is similar enough to any hard-task
 * pattern to warrant immediate escalation without an inference call.
 * Threshold: 0.80 cosine similarity (strict — only obvious hard tasks escalate here).
 */
export async function isHardTask(
  promptEmbedding: number[],
  apiKey: string,
  embeddingModel: string,
): Promise<boolean> {
  try {
    const patterns = await getPatternEmbeddings(apiKey, embeddingModel);
    const HARD_TASK_THRESHOLD = 0.80;
    for (const pattern of patterns) {
      if (cosineSimilarity(promptEmbedding, pattern) >= HARD_TASK_THRESHOLD) {
        return true;
      }
    }
    return false;
  } catch {
    return false; // on error, don't escalate
  }
}

// ── Signal 2: Self-REF confidence token ───────────────────────────────────────
//
// After GRPO training with Self-REF (arXiv 2410.13284), the RL model emits a
// calibrated confidence score at the end of its response in the format:
//   <confidence>0.73</confidence>
//
// We extract this and compare to the configured threshold.

const CONFIDENCE_TAG_RE = /<confidence>([\d.]+)<\/confidence>/i;

/**
 * Extract a Self-REF confidence score from model output text.
 * Returns null if no tag is found (model not yet GRPO-trained with Self-REF).
 */
export function extractConfidenceScore(text: string): number | null {
  const match = CONFIDENCE_TAG_RE.exec(text);
  if (!match) return null;
  const val = parseFloat(match[1] ?? "");
  if (isNaN(val) || val < 0 || val > 1) return null;
  return val;
}

// ── Signal 3: Semantic entropy gate ──────────────────────────────────────────

/**
 * Compute semantic entropy from N=3 short completions at temperature=0.8.
 * Returns a value in [0, 1] where higher = more divergent (more uncertain).
 *
 * This implementation uses a simple character-level Jaccard diversity
 * (fast, cheap, no secondary model needed) rather than full semantic
 * clustering. Upgrade to embedding-based clustering in a future iteration.
 */
export async function measureSemanticEntropy(
  prompt: string,
  model: string,
  apiKey: string,
  cfg: Required<ConfidenceRouterConfig>,
): Promise<number> {
  try {
    // Sample N completions in parallel
    const samples = await Promise.all(
      Array.from({ length: cfg.entropySamples }, () =>
        getOpenRouterProvider().chat({
          apiKey,
          model,
          messages: [{ role: "user", content: prompt }],
          max_completion_tokens: 100, // short sample — just enough to measure divergence
          temperature: cfg.entropyTemperature,
        }).then((r) => r.content.slice(0, 300).toLowerCase()).catch(() => ""),
      ),
    );

    const validSamples = samples.filter(Boolean);
    if (validSamples.length < 2) return 0;

    // Pairwise Jaccard distance over word trigrams
    function trigrams(text: string): Set<string> {
      const words = text.split(/\s+/).filter(Boolean);
      const tgs = new Set<string>();
      for (let i = 0; i < words.length - 2; i++) {
        tgs.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
      }
      return tgs;
    }

    let totalDistance = 0;
    let pairs = 0;
    for (let i = 0; i < validSamples.length; i++) {
      for (let j = i + 1; j < validSamples.length; j++) {
        const a = trigrams(validSamples[i]!);
        const b = trigrams(validSamples[j]!);
        const intersection = new Set([...a].filter((x) => b.has(x)));
        const union = new Set([...a, ...b]);
        const jaccard = union.size === 0 ? 0 : intersection.size / union.size;
        totalDistance += 1 - jaccard; // distance = 1 - similarity
        pairs++;
      }
    }
    return pairs === 0 ? 0 : totalDistance / pairs;
  } catch {
    return 0; // on error, report zero entropy (no escalation)
  }
}

// ── Main router ───────────────────────────────────────────────────────────────

/**
 * Check whether the active RL model can handle all modalities present in the input.
 * Returns an escalation decision if a mismatch is detected, null otherwise.
 *
 * @param modalities   Set of modalities detected in the input ("text", "vision", "audio")
 * @param rlModelId    Base model ID of the active RL model
 * @param teacherModel Teacher model to escalate to
 */
export function checkModalityMismatch(
  modalities: Set<string>,
  rlModelId: string,
  teacherModel: string,
): RoutingDecision | null {
  if (modalities.has("vision") && !modelSupportsVision(rlModelId)) {
    return {
      model: teacherModel,
      escalated: true,
      signal: "modality_mismatch",
    };
  }
  return null;
}

/**
 * Evaluate the confidence router and return a routing decision.
 *
 * @param prompt           - The user prompt for this run
 * @param promptEmbedding  - Pre-computed embedding of the prompt (may be null)
 * @param rlModel          - The currently active RL-trained model endpoint
 * @param teacherModel     - The teacher model to escalate to (already selected)
 * @param apiKey           - OpenRouter API key
 * @param embeddingModel   - Model for embedding calls
 * @param omlsCfg          - OMLS configuration
 * @param modalities       - Set of modalities detected in the input
 */
export async function routeRequest(
  prompt: string,
  promptEmbedding: number[] | null,
  rlModel: string,
  teacherModel: string,
  apiKey: string,
  embeddingModel: string | null,
  omlsCfg?: OmlsConfig,
  modalities?: Set<string>,
): Promise<RoutingDecision> {
  const cfg = routerCfg(omlsCfg?.router);

  // ── Signal 0: Modality mismatch ───────────────────────────────────────────
  if (modalities && modalities.size > 0) {
    const mismatch = checkModalityMismatch(modalities, rlModel, teacherModel);
    if (mismatch) return mismatch;
  }

  // ── Signal 1: Task classifier ─────────────────────────────────────────────
  if (promptEmbedding && promptEmbedding.length > 0 && embeddingModel) {
    try {
      const hard = await isHardTask(promptEmbedding, apiKey, embeddingModel);
      if (hard) {
        return { model: teacherModel, escalated: true, signal: "task_classifier" };
      }
    } catch { /* non-fatal */ }
  }

  // ── Signal 2: Self-REF token ──────────────────────────────────────────────
  // This signal is evaluated AFTER we get a response from the RL model.
  // The caller (loop.ts) must check the response and call checkConfidenceToken()
  // post-generation. We return "local" here; the loop handles the re-routing.
  // (Pre-generation check only uses signal 1 and 3.)

  // ── Signal 3: Semantic entropy — only for borderline cases ───────────────
  // Only fire if we have a usable RL model endpoint (not the base model string).
  // Skip if rlModel is the same as teacherModel (nothing to compare against).
  if (rlModel !== teacherModel) {
    try {
      const entropy = await measureSemanticEntropy(prompt, rlModel, apiKey, cfg);
      if (entropy > cfg.entropyThreshold) {
        return {
          model: teacherModel,
          escalated: true,
          signal: "semantic_entropy",
          entropy,
        };
      }
    } catch { /* non-fatal */ }
  }

  return { model: rlModel, escalated: false, signal: "local" };
}

/**
 * Post-generation check: extract Self-REF confidence token from model output
 * and return an escalation decision if below threshold.
 *
 * Call this immediately after receiving the RL model response, before
 * streaming it to the user. If escalation is indicated, discard the response
 * and re-run with the teacher model.
 */
export function checkConfidenceToken(
  modelOutput: string,
  teacherModel: string,
  omlsCfg?: OmlsConfig,
): RoutingDecision | null {
  const cfg = routerCfg(omlsCfg?.router);
  const score = extractConfidenceScore(modelOutput);
  if (score === null) return null; // no token — model not yet Self-REF trained
  if (score < cfg.confidenceThreshold) {
    return {
      model: teacherModel,
      escalated: true,
      signal: "confidence_token",
      confidenceScore: score,
    };
  }
  return null; // score is acceptable — serve locally
}

// ── Teacher selection ─────────────────────────────────────────────────────────

/**
 * Select the teacher model(s) to use for this escalation.
 *
 * Teacher models are frontier cloud models (DeepSeek-R1, Qwen3-72B) called via
 * OpenRouter. They require PROTOCOL_API_KEY to be set — they are NOT the same
 * as the base model being fine-tuned locally, which requires no API key.
 *
 * In "race" mode: returns all teachers so they can be called in parallel.
 * In "sequential" mode: returns just the first (highest priority) teacher.
 *
 * When autoLearnRouting is enabled and winRates is provided, returns only the
 * consistently-winning teacher once the threshold is reached.
 */
export function selectTeachers(
  omlsCfg: OmlsConfig,
  winRates?: Record<string, number>,
  escalationCount?: number,
): string[] {
  const defaultTeacherIds = DEFAULT_TEACHER_MODELS.map((m) => m.id);
  const teachers = omlsCfg.teacherModels?.length
    ? omlsCfg.teacherModels
    : defaultTeacherIds;

  // Auto-learn routing: if we've accumulated enough escalations and one teacher
  // consistently wins, route exclusively to that teacher.
  const threshold = omlsCfg.autoLearnThreshold ?? 200;
  if (
    omlsCfg.autoLearnRouting !== false &&
    winRates &&
    escalationCount &&
    escalationCount >= threshold
  ) {
    const best = Object.entries(winRates).sort(([, a], [, b]) => b - a)[0];
    if (best && best[1] > 0.60) {
      // Winner has > 60% of wins — route exclusively
      return [best[0]];
    }
  }

  if (omlsCfg.teacherMode === "sequential") {
    return [teachers[0]!];
  }
  // Default: race mode — return all
  return teachers;
}
