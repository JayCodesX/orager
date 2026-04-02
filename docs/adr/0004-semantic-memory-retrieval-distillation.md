# ADR-0004: Semantic memory retrieval, auto-embedding, and long-term distillation

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-04-01 |
| **Deciders** | JayCodesX |

---

## Context

### Prior state (ADR-0001 baseline)

ADR-0001 established a four-layer hierarchical memory system backed by WASM SQLite. Retrieval at that point used a three-step progression:

1. **SQL exact-match** — structured field lookup
2. **Local scoring** — when the store exceeded a threshold (default 15 entries), a keyword/BM25-style scorer ranked entries against the prompt and returned the top 12
3. **Full store render** — fallback of last resort for small stores

This worked well for stores under ~100 entries where keyword overlap was sufficient. Two failure modes emerged as stores grew and usage diversified:

- **Semantic miss** — FTS5 keyword search returns nothing for a conceptually relevant query. A prompt asking about "auth architecture" misses an entry tagged `["login", "jwt-flow"]` because the surface terms don't overlap. The agent cold-starts on knowledge it already captured.
- **Store bloat** — the distillation (Phase 6C) trigger in ADR-0001 was planned but not implemented. Stores grew unboundedly. Long-term distillation was described in the design but not shipped.

Additionally, the dynamic section of the system prompt (master context + retrieved memory + auto-memory + prior session checkpoint) had no size ceiling. On large stores injected into small-context models, memory crowded out conversation history, degrading performance rather than improving it.

### Decision drivers

- Semantic fallback must be opt-in — not every deployment has an embedding model configured; the FTS path must remain the zero-cost default
- Auto-embedding must be non-fatal — an embedding API failure during ingest must never abort the agent run or block memory write
- Distillation must preserve importance-3 (critical) entries — only importance 1–2 entries are candidates for compression
- Dynamic memory section must be bounded — the combined injected memory must not exceed a configurable fraction of the model's context window
- All retrieval paths must be observable — operators need to know which path fired and at what cost to diagnose quality regressions

---

## Decision

Implement three connected enhancements to the memory retrieval pipeline, all shipped as part of Phase 6 and Phase 7:

### 1. FTS → embedding fallback (Phase 6A)

When `memoryRetrieval` is set to the default SQLite path and FTS5 returns zero results for the current prompt, and `memoryEmbeddingModel` is configured, orager falls back to cosine similarity scoring over stored embedding vectors.

**Retrieval path decision tree:**

```
memoryRetrieval = "embedding" (explicit)
  └─ embed prompt → cosine similarity over all stored vectors → top 12
     └─ on API failure: fall back to local scoring (non-fatal)

memoryRetrieval = "local" / default (SQLite path)
  └─ FTS5 search across namespace(s)
       ├─ results found → render top 12 (fast path, zero API cost)
       └─ no results + memoryEmbeddingModel configured
            └─ embed prompt → cosine similarity (fts_embedding_fallback)
                 └─ on API failure: full store render (non-fatal)
```

The FTS path is always attempted first. Embedding calls only happen on a genuine miss. This keeps the common case free of API latency and cost.

**Query embedding cache:** The prompt vector is cached in-process (`getCachedQueryEmbedding` / `setCachedQueryEmbedding`) keyed by model + prompt text. A single run that triggers both the primary FTS miss and a secondary retrieval call reuses the cached vector rather than making two API calls.

### 2. Auto-embedding on memory ingest (Phase 6B)

When `memoryEmbeddingModel` is configured and a `<memory_update>` block is ingested (Phase 4), orager immediately embeds the new entry content and stores the vector as a binary `Float32` BLOB in `memory_entries.embedding`. This happens inline, after the SQLite write, and is non-fatal — an embedding failure does not block the memory entry from being written.

**Why at ingest time, not at query time:**
- Embedding at ingest is a one-time cost per entry. Embedding at query time would require storing nothing but would call the embeddings API on every FTS miss for every entry in the store — O(n) API calls per retrieval.
- Ingest-time embedding front-loads the cost and makes the FTS fallback a single query-vector call regardless of store size.

**Schema:** `memory_entries` already has `embedding BLOB` and `embedding_model TEXT` columns from the Phase 6 migration. Binary `Float32` storage (not JSON text) was chosen for compact representation; a one-time migration converts any legacy JSON-string embeddings on startup.

### 3. Long-term distillation (Phase 6C)

When the non-expired entry count for a namespace exceeds **200 entries** (`DISTILL_ENTRY_THRESHOLD`), orager fires a distillation pass at session end (after session-end synthesis).

**Pass mechanics:**
- Pull the oldest **30 entries** (`DISTILL_BATCH_SIZE`) with importance ≤ 2 (importance-3 entries are never candidates)
- Only proceed if at least 10 qualifying entries are available — a smaller batch is not worth the API call
- Call the LLM (using `summarizeModel` if configured, otherwise the primary model) with a structured compression prompt: synthesise the batch into at most 5 denser entries preserving every unique fact
- Validate the response is a parseable JSON array; on failure return `[]` (non-fatal)
- Delete the source entries; write the distilled entries to `memory_entries` with `runId = sessionId`
- Log `memory_distilled` with before/after counts for observability

**Why 200 entries / 30 batch:**
- At 200 entries, brute-force cosine similarity is still sub-millisecond (ADR-0002 threshold analysis)
- 30 entries fits comfortably in one LLM context window with room for the synthesis response
- Batch size of 30 → at most 5 distilled = 6:1 compression ratio targeting the oldest, lowest-importance material

**Distillation does not replace ADR-0002 (ANN index):** Distillation keeps stores compact so the brute-force path remains fast. If distillation is insufficient and stores still grow beyond ADR-0002's trigger thresholds, the ANN upgrade path remains open.

### 4. Dynamic memory token budget (Phase 7)

The combined dynamic section of the system prompt — master context + retrieved memory + auto-memory + prior session checkpoint — is capped at **20% of the model's context window** (`MEMORY_DYNAMIC_BUDGET_FRACTION`, default `0.20`, override via `ORAGER_MEMORY_BUDGET_FRACTION`).

At the `frozenSystemPromptLength` boundary (set in Phase 3 of ADR-0001), orager measures the dynamic section in characters using a 4 chars/token heuristic. If the section exceeds the budget, it is truncated and a `[Memory section truncated — exceeded context budget]` marker is appended.

**Why 20%:** At 20%, a 200k-token model allows ~40k tokens of injected memory; a 32k model caps at ~6.4k. The budget scales with the model rather than being a fixed character count, so the same orager configuration works correctly across models with very different context windows.

### 5. Retrieval observability (Phase 7)

Every retrieval operation logs a `memory_retrieval` event with:

| Field | Description |
|---|---|
| `path` | Which retrieval path fired: `fts`, `fts_embedding_fallback`, `embedding`, `local_scored`, `full_store`, `full_store_embedding_err` |
| `count` | Number of entries returned |
| `totalEntries` | Total non-expired entries in the namespace |
| `durationMs` | Wall-clock time from retrieval start to log write |
| `sessionId` | Current session |
| `contextId` | Memory namespace (primary key) |

The `path` field is the primary signal for diagnosing retrieval quality:
- Sustained `fts` → healthy; FTS is resolving queries without embedding API calls
- Sustained `fts_embedding_fallback` → FTS is missing; consider reviewing entry tagging or enabling `memoryEmbeddingModel`
- `full_store` on large stores → neither FTS nor embeddings is configured; store may be outgrowing the full-render approach
- `full_store_embedding_err` → embedding API is failing; check API key and model availability

The `memory_budget_enforced` event logs when the dynamic section is truncated, including `dynamicCharsBefore`, `budgetChars`, `contextWindow`, and `fraction` — giving operators visibility into which models are memory-constrained.

---

## Alternatives Considered

### 1. Embed all entries at query time (no ingest-time embedding)

Compute embeddings for every store entry on each retrieval call rather than storing vectors.

**Rejected because:** O(n) embedding API calls per retrieval. A 200-entry store with a 512-dimension model would require batching and multiple API calls on every FTS miss. Ingest-time embedding is a one-time cost per entry; query time cost is fixed at one call regardless of store size.

### 2. Always use embedding retrieval (skip FTS entirely)

Make embedding the default retrieval path, removing the FTS step.

**Rejected because:** FTS5 is synchronous, zero-cost, and works without any external API. Making it opt-out would impose embedding API latency and cost on every run, including those where keyword search is sufficient. The fallback design preserves the zero-cost common case.

### 3. Distillation on every session end (unconditional)

Run distillation after every session regardless of store size.

**Rejected because:** Unnecessary API calls on small stores. The 200-entry threshold ensures distillation only fires when there is material to compress. A 50-entry store has nothing to gain from a compression pass.

### 4. Fixed character cap for dynamic memory section

Use a fixed character limit (e.g., 20,000 chars) rather than a fraction of the context window.

**Rejected because:** A fixed cap is too large for 8k-token models and too small for 200k-token models. Scaling by context window fraction gives consistent headroom across models without requiring per-model configuration.

---

## Consequences

**Positive**
- Semantic recall: entries missed by keyword search are now recoverable via embedding fallback — the gap between FTS recall and embedding recall is closed without making embeddings mandatory
- Store hygiene: distillation at 200 entries keeps stores compact and brute-force cosine similarity fast, deferring the ANN upgrade (ADR-0002) further
- Memory safety: the 20% budget cap prevents memory injection from crowding out conversation history on small-context models
- Full observability: `memory_retrieval.path` gives operators a clear signal for retrieval quality without requiring log analysis

**Negative / Trade-offs**
- Ingest-time embedding adds latency to `<memory_update>` ingestion when `memoryEmbeddingModel` is configured — typically 100–300ms per entry; non-blocking since it's a post-write async call
- Distillation consumes one LLM API call per pass (at session end, using `summarizeModel`); on accounts with tight rate limits this adds to per-session cost
- The 4 chars/token heuristic for budget enforcement is coarse — actual token counts vary by model vocabulary; the heuristic errs on the side of truncating slightly early for non-English content

**Neutral**
- `memoryEmbeddingModel` is opt-in — all Phase 6 embedding features are no-ops when the field is not set; existing deployments are unaffected
- Distillation only fires on SQLite-backed stores (`isSqliteMemoryEnabled()`) — the JSON file fallback is unaffected
- ADR-0002 (ANN index) remains the upgrade path when distillation is insufficient; this ADR does not supersede it
