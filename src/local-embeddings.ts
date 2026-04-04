/**
 * Local embedding inference via Transformers.js (all-MiniLM-L6-v2).
 *
 * Produces 384-dimension vectors entirely in-process — no API call, no cost.
 * Lazy-loads the model on first call (~50 MB download, cached in ~/.cache/huggingface).
 *
 * Graceful degradation: when @huggingface/transformers is not installed the
 * module exports a no-op that returns null, and callers fall back to the
 * OpenRouter embedding API.
 */

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
export const LOCAL_EMBEDDING_DIM = 384;

// ── Lazy singleton ──────────────────────────────────────────────────────────────

type Pipeline = (text: string, opts?: Record<string, unknown>) => Promise<{ data: Float32Array }>;

let _pipeline: Pipeline | null | false = null; // null = not tried, false = unavailable

async function _getPipeline(): Promise<Pipeline | null> {
  if (_pipeline === false) return null; // already failed
  if (_pipeline) return _pipeline;

  try {
    // Dynamic import — tree-shaken when not installed
    // @ts-expect-error — optional dependency, may not be installed
    const { pipeline } = await import("@huggingface/transformers");
    const pipe = await pipeline("feature-extraction", MODEL_ID, {
      quantized: true,
      // Prefer WASM for maximum compatibility; WebGPU/Metal can be added later
    });
    _pipeline = pipe as unknown as Pipeline;
    process.stderr.write(`[local-embeddings] loaded ${MODEL_ID} (${LOCAL_EMBEDDING_DIM}-dim)\n`);
    return _pipeline;
  } catch {
    _pipeline = false;
    process.stderr.write(
      `[local-embeddings] @huggingface/transformers not available — using OpenRouter API fallback\n`,
    );
    return null;
  }
}

// ── Public API ──────────────────────────────────────────────────────────────────

/**
 * Embed a single text string using the local MiniLM model.
 * Returns a 384-dim unit vector, or null when the local model is unavailable.
 */
export async function localEmbed(text: string): Promise<number[] | null> {
  const pipe = await _getPipeline();
  if (!pipe) return null;

  try {
    const output = await pipe(text, { pooling: "mean", normalize: true });
    return Array.from(output.data);
  } catch (err) {
    process.stderr.write(
      `[local-embeddings] inference failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return null;
  }
}

/**
 * Embed multiple texts. Returns one vector per input, or null if unavailable.
 */
export async function localEmbedBatch(texts: string[]): Promise<number[][] | null> {
  const pipe = await _getPipeline();
  if (!pipe) return null;

  try {
    const results: number[][] = [];
    for (const text of texts) {
      const output = await pipe(text, { pooling: "mean", normalize: true });
      results.push(Array.from(output.data));
    }
    return results;
  } catch (err) {
    process.stderr.write(
      `[local-embeddings] batch inference failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return null;
  }
}

/**
 * Returns true when the local embedding model is loaded and ready.
 * Does NOT trigger loading — call localEmbed() to trigger lazy init.
 */
export function isLocalEmbeddingAvailable(): boolean {
  return _pipeline !== null && _pipeline !== false;
}

/** Reset for testing — clears the pipeline singleton. */
export function _resetLocalEmbeddingsForTesting(): void {
  _pipeline = null;
}
