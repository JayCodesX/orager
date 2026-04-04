# ADR-0011: Skill Merge Pipeline — Consolidate Similar Skills into Meta-Skills

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-04-04 |
| **Deciders** | JayCodesX |

---

## Context

The SkillBank (ADR-0006) accumulates agent strategies extracted from successful runs. As usage grows, two problems emerge:

1. **Redundancy.** Related skills covering the same pattern accumulate independently. A topK=5 query over 500 near-duplicate skills returns noisier results than the same query over 50 well-differentiated ones.

2. **Scale.** At 100K+ skills the fixed `maxSkills` cap prunes by `success_rate ASC` — a lossy discard that silently drops potentially valuable strategies.

The existing deduplication threshold (cosine ≥ 0.92) prevents near-identical skills on write, but does not consolidate semantically similar skills that develop over time.

---

## Decision

Add a **merge pipeline** that:

1. **Clusters** live skills by embedding cosine similarity using greedy agglomerative clustering.
2. **Synthesizes** each cluster into a single meta-skill via an LLM call.
3. **Archives** the originals with provenance links (`merged_into`, `source_skills` columns).

The merge runs automatically when the live skill count hits a configurable threshold (`mergeAt`, default 100) and can be triggered manually via `orager skills merge`.

---

## Architecture

### Clustering Algorithm

Greedy agglomerative clustering (not k-means) because the number of clusters is unknown in advance:

1. For each unassigned skill, compute cosine similarity against all others.
2. Any pair with similarity ≥ `mergeThreshold` (default 0.78) seeds a cluster.
3. Expand greedily: add skills whose similarity to the cluster **centroid** (mean of member embeddings) meets threshold.
4. Discard clusters smaller than `mergeMinClusterSize` (default 3).

### LLM Synthesis

A single LLM call per cluster produces a ≤ 200-word meta-skill that subsumes all member strategies. The model may respond `NO_MERGE` if the cluster is too heterogeneous — in which case the originals are left untouched.

### DB Schema (additive migrations)

```sql
ALTER TABLE skills ADD COLUMN merged_into TEXT;    -- ID of meta-skill that absorbed this skill
ALTER TABLE skills ADD COLUMN source_skills TEXT;  -- JSON array of source IDs (on meta-skill)
```

### Write Path

All writes for one cluster (insert meta-skill + archive originals) are wrapped in a single `db.transaction()`. The ANN vec index (`skills_vectors`) and FTS5 index (`skills_fts`) are updated synchronously after each successful transaction.

### Auto-Trigger

After each successful skill insert in `extractSkillFromTrajectory`, if `liveCount >= mergeAt` and `mergeAt > 0`, a merge pass is kicked off via `setImmediate` — non-blocking, never delays the extraction caller.

### CLI

```bash
orager skills merge              # run merge pipeline
orager skills merge --dry-run    # show clusters without writing
orager skills merge --threshold=0.85  # override threshold for one pass
```

---

## Config

Added to `SkillBankConfig` in `settings.json`:

| Field | Type | Default | Description |
|---|---|---|---|
| `mergeAt` | `number` | `100` | Live skill count triggering auto-merge. Set to `0` to disable. |
| `mergeThreshold` | `number` | `0.78` | Minimum cosine similarity to form a cluster. |
| `mergeMinClusterSize` | `number` | `3` | Minimum cluster size for synthesis. |

---

## Consequences

### Positive
- Active skill count stays bounded without losing coverage.
- Meta-skills benefit from the combined `use_count` signal of their sources.
- Retrieval quality improves as redundant near-duplicates are replaced by consolidated strategies.
- Full provenance: every archived skill has `merged_into` pointing to its meta-skill.

### Negative
- Each merge pass costs N LLM calls (one per cluster). At 50 clusters × $0.001 ≈ $0.05/pass.
- Heterogeneous clusters may produce weaker meta-skills than the originals (`NO_MERGE` mitigates this).
- The `auto` mode in `omls.mode` (ADR-0012) considers live skill count — merging can temporarily drop count below `autoLoraThreshold`, reverting to prompt mode until threshold is re-reached.

### Migration

No data migration required — `merged_into` and `source_skills` columns are additive and default to `NULL`. Existing skill rows are unchanged.
