/**
 * Pre-flight model checks extracted from runAgentLoop (Sprint 6 decomposition).
 *
 * Handles: model metadata fetch, deprecation warning, capability check,
 * vision model swap, Ollama backend check, and tool-use capability warning.
 *
 * Returns the (possibly swapped) effective model string.
 */

import type { AgentLoopOptions } from "./types.js";
import { shouldUseDirect } from "./openrouter.js";
import { fetchModelContextLengths, isModelContextCacheWarm } from "./model-cache.js";
import { fetchLiveModelMeta, isLiveModelMetaCacheWarm, liveModelSupportsTools, liveModelSupportsVision } from "./openrouter-model-meta.js";
import { checkDeprecatedModel } from "./deprecated-models.js";
import { getModelCapabilities } from "./model-capabilities.js";
import { isOllamaRunning, resolveOllamaBaseUrl, toOllamaTag, isModelPulled } from "./ollama.js";
import { log } from "./logger.js";

export interface PreflightResult {
  /** Effective model after any vision swap. */
  model: string;
  /** Resolved Ollama base URL when Ollama is enabled and reachable; undefined otherwise. */
  ollamaBaseUrl: string | undefined;
}

/**
 * Run pre-flight checks for a single agent loop invocation.
 *
 * @param model              - Requested model (may be replaced by visionModel).
 * @param apiKey             - API key for OpenRouter model-meta fetch.
 * @param opts               - Full agent loop options.
 * @param sessionId          - Resolved session ID (for log entries).
 * @param promptContentBlocks - Prompt content blocks (checked for images).
 * @param onLog              - Optional log callback (stderr).
 */
export async function runPreflight(
  model: string,
  apiKey: string,
  opts: AgentLoopOptions,
  sessionId: string,
  promptContentBlocks: Array<{ type: string }> | undefined,
  onLog?: (stream: "stdout" | "stderr", chunk: string) => void,
): Promise<PreflightResult> {
  // ── Model metadata fetch ─────────────────────────────────────────────────────
  // Skipped for the direct Anthropic path — the OpenRouter /models endpoint requires an
  // OpenRouter key and returns no data the direct path can use. The static fallback map
  // (200k for anthropic/* models) is authoritative and used instead.
  // Also skipped when both caches are warm (e.g. pre-warmed at daemon startup) to avoid
  // the function-call overhead on every run in long-lived daemon processes.
  if (!shouldUseDirect(model) && !(isModelContextCacheWarm() && isLiveModelMetaCacheWarm())) {
    await Promise.all([
      fetchModelContextLengths(apiKey),
      fetchLiveModelMeta(apiKey),
    ]);
  }

  // ── Deprecation check ────────────────────────────────────────────────────────
  const deprecation = checkDeprecatedModel(model);
  if (deprecation) {
    onLog?.(
      "stderr",
      `[orager] WARNING: model '${model}' is deprecated (${deprecation.deprecated}). ` +
      `Suggested replacement: '${deprecation.replacement}'.` +
      (deprecation.reason ? ` Reason: ${deprecation.reason}` : "") + "\n",
    );
    log.warn("deprecated_model", { sessionId, model, replacement: deprecation.replacement });
  }

  // ── Capability check ─────────────────────────────────────────────────────────
  if (opts.requiredCapabilities && opts.requiredCapabilities.length > 0) {
    const caps = getModelCapabilities(model);
    const missing = opts.requiredCapabilities.filter(
      (c) => !caps[c as keyof typeof caps],
    );
    if (missing.length > 0) {
      onLog?.(
        "stderr",
        `[orager] WARNING: model '${model}' may not support: ${missing.join(", ")}. ` +
        `Run may fail or produce degraded results.\n`,
      );
      log.warn("capability_mismatch", { sessionId, model, missing });
    }
  }

  // ── Vision model routing ─────────────────────────────────────────────────────
  // If the prompt contains image_url blocks and the primary model does not
  // support vision, swap to opts.visionModel for this run.  The model meta
  // cache is warm at this point (fetched above), so liveModelSupportsVision is
  // a cheap synchronous lookup — no extra network call.
  const hasImages = (promptContentBlocks ?? []).some((b) => b.type === "image_url");
  if (hasImages) {
    const visionOk = liveModelSupportsVision(model);
    if (visionOk === false) {
      if (opts.visionModel) {
        onLog?.(
          "stderr",
          `[orager] model '${model}' does not support vision — switching to visionModel '${opts.visionModel}' for this run.\n`,
        );
        log.warn("vision_model_swap", {
          sessionId,
          originalModel: model,
          visionModel: opts.visionModel,
        });
        model = opts.visionModel;
      } else {
        onLog?.(
          "stderr",
          `[orager] WARNING: model '${model}' does not support vision and no visionModel is configured. ` +
          `Images may be silently stripped or cause an API error. ` +
          `Set visionModel in ~/.orager/config.json or pass --vision-model.\n`,
        );
        log.warn("vision_not_supported", {
          sessionId,
          model,
          message: "no visionModel configured",
        });
      }
    } else if (visionOk === null) {
      // Could not verify from cache — soft warning only, proceed as-is.
      onLog?.(
        "stderr",
        `[orager] WARNING: could not verify vision support for '${model}' — proceeding. ` +
        `If the run fails, set visionModel in config.\n`,
      );
    }
    // visionOk === true: confirmed, no action needed.
  }

  // ── Ollama backend startup check ──────────────────────────────────────────────
  const _ollamaCfg = opts.ollama;
  let ollamaBaseUrl: string | undefined;
  if (_ollamaCfg?.enabled) {
    const ollamaUrl = resolveOllamaBaseUrl(_ollamaCfg);
    const running = await isOllamaRunning(ollamaUrl);
    if (!running) {
      const msg = `[orager] Ollama is not running at ${ollamaUrl}. ` +
        `Start Ollama with \`ollama serve\` and retry, or set opts.ollama.enabled = false to use OpenRouter.\n`;
      onLog?.("stderr", msg);
      throw new Error(`Ollama not reachable at ${ollamaUrl}`);
    }
    const ollamaTag = toOllamaTag(model, _ollamaCfg);
    if (_ollamaCfg.checkModel !== false) {
      const pulled = await isModelPulled(ollamaTag, ollamaUrl);
      if (!pulled) {
        const msg = `[orager] Ollama model "${ollamaTag}" is not pulled. ` +
          `Run \`ollama pull ${ollamaTag}\` then retry.\n`;
        onLog?.("stderr", msg);
        throw new Error(`Ollama model "${ollamaTag}" not pulled`);
      }
    }
    ollamaBaseUrl = ollamaUrl;
    onLog?.("stderr", `[orager] using local Ollama backend: ${ollamaTag} @ ${ollamaUrl}\n`);
  }

  // Log if direct Anthropic mode is active (bypasses OpenRouter)
  if (!ollamaBaseUrl && shouldUseDirect(model)) {
    onLog?.("stderr", `[orager] using direct Anthropic API for model ${model} (ANTHROPIC_API_KEY is set)\n`);
  }

  // ── Tool use capability check ─────────────────────────────────────────────────
  // Prefer live tool-support data over static regex table
  const liveToolSupport = liveModelSupportsTools(model);
  if (liveToolSupport === false) {
    onLog?.("stderr", `[orager] WARNING: model '${model}' does not support tool/function calling (confirmed via OpenRouter model metadata).\n`);
  } else if (liveToolSupport === null && !getModelCapabilities(model).toolUse) {
    onLog?.("stderr", `[orager] WARNING: model '${model}' may not support tool/function calling (based on static table).\n`);
  }

  return { model, ollamaBaseUrl };
}
