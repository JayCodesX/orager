# ADR-0002: ANN vector index for semantic memory retrieval at scale

| Field | Value |
|---|---|
| **Status** | Accepted — unblocked by ADR-0008 Phase 4 (sqlite-vec loaded); implement when trigger thresholds are met |
| **Date** | 2026-04-01 |
| **Deciders** | JayCodesX |

---

## Context

### Current approach

Memory retrieval uses a three-step progression (ADR-0001):

1. **FTS5 full-text search** — synchronous, zero-cost, handles keyword/entity recall
2. **Embeddings fallback** — when FTS5 returns nothing and `memoryEmbeddingModel` is configured, the query is embedded and cosine similarity is computed in-process against all stored entry vectors (Phase 6A)
3. **Full store render** — fallback of last resort

Step 2 is brute-force: it loads all entries for the namespace into memory and computes cosine similarity for each. This is fast and allocation-free at ≤500 entries (sub-millisecond), but degrades linearly with store size.

Long-term distillation (Phase 6C) fires at 200 entries to keep stores compact. In practice this means the embeddings path is operating over a small, well-maintained set and the brute-force approach has no measurable cost.

### Why defer

- sqlite-vec adds ~3–5 MB to the compiled binary
- ANN index overhead (build time, memory) is only justified when the brute-force path becomes measurably slow
- Distillation actively prevents stores from reaching the scale where ANN matters
- The three observable signals below give a clear, data-driven trigger rather than a speculative one

### Decision drivers

- Must remain embeddable — no external services, survives `bun build --compile`
- Must keep the existing `retrieveEntriesWithEmbeddings` interface so callers are unaffected
- Must not add binary size cost until the performance problem is real

---

## Decision

Defer implementation until at least two of the following three signals are simultaneously true for any production namespace:

| Signal | Threshold | Observable via |
|---|---|---|
| **Entry count** | Any namespace sustains >500 entries after distillation has run | `log.info("memory_distilled")` — if total after distillation keeps growing |
| **Retrieval latency** | `retrieveEntriesWithEmbeddings` p95 >5ms | `log.info("memory_retrieval")` span timing |
| **FTS miss rate** | `fts_embedding_fallback` path fires in >30% of sessions for a namespace | `log.info("memory_retrieval", { path: "fts_embedding_fallback" })` |

When two or more signals are met, implement ANN using `sqlite-vec` (https://alexgarcia.xyz/sqlite-vec/), which provides a native SQLite extension for approximate nearest neighbor search and is compatible with the WASM build pipeline.

---

## Proposed solution (when triggered)

- Add `sqlite-vec` as a dependency; load alongside the existing WASM SQLite DB
- Add a `memory_entry_vectors` virtual table (or shadow table) keyed by entry `id`
- On `addMemoryEntrySqlite`: insert the Float32 vector into the ANN index alongside the main row
- On `deleteMemoryEntriesByIds`: delete the corresponding ANN index rows
- Replace the brute-force `retrieveEntriesWithEmbeddings` call in the `fts_embedding_fallback` path with an ANN query (top-K by cosine distance); fall back to brute-force if the index is unavailable
- Existing callers using `retrieval: "embedding"` mode get the same upgrade transparently

---

## Alternatives Considered

### 1. pgvector / external vector DB

A dedicated vector database (Qdrant, Weaviate, pgvector) would offer better ANN quality at scale.

**Rejected:** Violates the embeddable constraint. Requires an external service, breaks offline use, and is incompatible with `bun build --compile` single-binary delivery.

### 2. Pure in-process HNSW (e.g. hnswlib-node)

A JavaScript/WASM HNSW implementation without SQLite integration.

**Rejected:** Cannot be persisted to the same SQLite file, requires separate index serialisation, and adds its own binary size cost. sqlite-vec keeps the vector store co-located with the rest of the DB.

### 3. Keep brute-force indefinitely

Accept linear scan over all entries as the permanent solution.

**Rejected (conditionally):** Acceptable until the trigger thresholds are met. If distillation keeps stores small, this alternative may remain valid indefinitely.

---

## Consequences

**When implemented:**
- Binary size increases by ~3–5 MB (sqlite-vec WASM)
- Retrieval latency for the embedding path becomes sub-linear at large store sizes
- Existing interface unchanged — callers specify `retrieval: "embedding"` or benefit from the FTS fallback automatically

**Until implemented:**
- No action required; continue monitoring the three signals via structured logs
- Distillation (Phase 6C) is the primary mechanism for keeping stores small enough that ANN is not needed
