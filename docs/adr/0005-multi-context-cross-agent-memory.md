# ADR-0005: Multi-context and cross-agent memory sharing

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-04-01 |
| **Deciders** | JayCodesX |

---

## Context

### Prior state (ADR-0001 baseline)

ADR-0001 established a single-namespace memory model: each agent run is bound to exactly one `memoryKey` (a string derived from the repo URL or working directory). The agent reads from and writes to that namespace exclusively.

This is correct for isolated single-agent workflows. It breaks down when multiple agents need to collaborate or share knowledge:

- **Shared project context** — a researcher agent and a synthesizer agent working on the same product should both read from the shared product-research namespace, but the synthesizer should write its conclusions there without the researcher's raw notes being mixed in.
- **Cross-agent specialisation** — a code-review agent and a documentation agent may each maintain their own namespace of domain-specific facts, but an orchestrator agent needs to read from both when composing a final report.
- **Read-only shared context** — a global `"org-conventions"` namespace should be readable by all agents but writable only by a designated conventions agent. Allowing arbitrary agents to write to it would corrupt the shared context.

The single-namespace model has no mechanism to express these distinctions. Every agent either has full read/write access to one namespace, or none at all.

### Decision drivers

- Write target must always be explicit — no implicit multi-write; an agent that can read from three namespaces must still write to exactly one
- Backward compatible — `memoryKey: string` (existing form) must continue to work identically; no migration required
- Single SQL query for multi-namespace retrieval — N parallel FTS queries are worse than one `IN(?)` query for latency, connection overhead, and lock contention
- The `remember` tool must surface available namespaces to the model — the agent must know which namespaces it can write to; this cannot be implicit
- Isolation must be verifiable — unknown `target_namespace` values must be rejected, not silently accepted

---

## Decision

Extend `memoryKey` to accept `string | string[]`. When an array is provided, index 0 is the write target and all elements are read sources. A new `searchMemoryFtsMulti` function handles multi-namespace FTS in a single query. The `remember` tool receives an `allowedNamespaces` list and exposes `target_namespace` as an explicit model-facing parameter.

### Solution

#### 1. `memoryKey: string | string[]` in `AgentLoopOptions`

```ts
// Single namespace — identical to prior behaviour
memoryKey: "product-research"

// Multi-namespace — reads from all three, writes to index 0
memoryKey: ["product-research", "org-conventions", "researcher-agent"]
```

**Derivation in `runAgentLoop`:**

```ts
const effectiveMemoryKeys: string[] = Array.isArray(opts.memoryKey)
  ? opts.memoryKey.map((k) => k.trim()).filter(Boolean)
  : typeof opts.memoryKey === "string" && opts.memoryKey.trim()
    ? [opts.memoryKey.trim()]
    : [resolvedDefault];

// index 0 is always the write target
const effectiveMemoryKey = effectiveMemoryKeys[0];
```

A single-element array is semantically identical to a plain string — the same code path handles both. The resolved default (repo URL or cwd derivation) is used when `memoryKey` is absent or empty.

**What uses `effectiveMemoryKey` (write target only):**
- Master context load and save
- Session checkpoint write
- Phase 6C distillation
- `makeRememberTool` primary write path
- All `log.info` `contextId` fields

**What uses `effectiveMemoryKeys` (all read sources):**
- `searchMemoryFtsMulti` — FTS retrieval across all namespaces
- `makeRememberTool` `allowedNamespaces` — the full set the model may write to

#### 2. `searchMemoryFtsMulti` — single `IN(?)` query

```sql
SELECT m.id, m.memory_key, m.content, m.tags, m.created_at, m.expires_at,
       m.run_id, m.importance, m.embedding, m.embedding_model
FROM memory_entries_fts f
JOIN memory_entries m ON m.rowid = f.rowid
WHERE memory_entries_fts MATCH ?
  AND m.memory_key IN (?, ?, ...)
  AND (m.expires_at IS NULL OR m.expires_at > ?)
ORDER BY rank
LIMIT ?
```

**Key properties:**
- Single prepared statement regardless of namespace count — no N-way fan-out
- FTS5 `rank` ordering is global across namespaces — the most relevant entries surface regardless of which namespace they came from
- Expiry filter applied in the same query — no post-processing needed
- Delegates to `searchMemoryFts` when `keys.length === 1` — no overhead for the common single-namespace case
- Returns `[]` immediately when `keys` is empty — no database round-trip

The caller (loop.ts) deduplicates by `id` after the query as a defensive measure against any future schema changes that could produce duplicate rowids.

#### 3. `makeRememberTool` — `allowedNamespaces` + `target_namespace`

The `remember` tool receives the full `allowedNamespaces` list at construction time:

```ts
makeRememberTool(
  effectiveMemoryKey,       // primary write target
  memoryMaxChars,
  embeddingOpts,
  contextId,
  effectiveMemoryKeys.length > 1 ? effectiveMemoryKeys : undefined,
)
```

When `allowedNamespaces` contains more than one entry, the tool schema gains a `target_namespace` parameter with a dynamic description listing the available namespaces:

```
target_namespace (optional): Namespace to write to.
Must be one of: product-research, org-conventions, researcher-agent.
Defaults to product-research.
```

**Write target resolution at call time:**

```ts
const writeTarget: string = (() => {
  if (!rawTarget) return memoryKey;                          // default: primary key
  if (readNamespaces.includes(rawTarget)) return rawTarget; // validated: known namespace
  return memoryKey;                                          // unknown: fall back to primary
})();
```

Unknown `target_namespace` values fall back to the primary key rather than erroring. This is intentional: a model that hallucinates a namespace name should degrade gracefully to the default write target rather than failing the tool call entirely.

**`list` action with multiple namespaces:** When `allowedNamespaces` has more than one entry, `list` loads all namespaces in parallel, merges the stores, and renders a combined view labelled by namespace. This gives the model a complete picture of available memory without requiring separate `list` calls per namespace.

---

## Alternatives Considered

### 1. Separate `readMemoryKeys` and `writeMemoryKey` fields

Two distinct fields instead of encoding write-target-as-index-0 in a single array.

**Rejected because:** More surface area in `AgentLoopOptions` for a distinction that can be expressed concisely in the array convention. Index 0 as write target is explicit, consistent, and easy to document. Two fields create the possibility of `writeMemoryKey` not appearing in `readMemoryKeys`, requiring additional validation.

### 2. N parallel FTS queries merged in application code

Call `searchMemoryFts` once per namespace concurrently with `Promise.all`, then merge and re-rank results.

**Rejected because:** N database connections for what is expressible as one query. FTS5 `rank` ordering is computed per-query — merging N ranked lists requires a secondary sort pass and loses the global relevance ordering. One `IN(?)` query is strictly better: fewer round-trips, single rank, single expiry check.

### 3. Allow writes to any namespace (no `allowedNamespaces` restriction)

Let the model write to any namespace it names in `target_namespace` without validation.

**Rejected because:** An agent that can arbitrarily write to any namespace in the database can corrupt shared contexts (e.g., overwriting `org-conventions` with run-specific noise). The `allowedNamespaces` list is the caller's explicit declaration of which namespaces this agent is permitted to affect. Validation enforces that contract; unknown namespaces fall back to the primary key rather than succeeding silently.

### 4. Hard-error on unknown `target_namespace`

Return a tool error when the model supplies an unknown namespace rather than falling back to the primary key.

**Rejected because:** Tool errors visible to the model create unnecessary friction and can cause retry loops. A graceful fallback to the primary write target preserves the memory write while logging the unexpected input. The content is not lost; the write lands in the most authoritative namespace for that agent.

---

## Consequences

**Positive**
- Multi-agent workflows can share a common read context without coupling write targets — a researcher and synthesizer can both read `product-research` while writing to their own namespaces
- A single `IN(?)` query replaces N parallel queries for multi-namespace retrieval — lower latency, fewer SQLite connections, global FTS rank ordering preserved
- The model always knows which namespaces it can write to — `target_namespace` is surfaced in the tool schema with an explicit enumeration; no implicit behaviour
- Fully backward compatible — `memoryKey: "my-namespace"` is unchanged in every respect; no migration required for existing deployments

**Negative / Trade-offs**
- The index-0 write target convention is implicit — callers must know that the first element of the array is the write target; this is documented but not enforced by the type system
- Multi-namespace `list` loads all namespaces in parallel — on large stores across many namespaces this adds I/O proportional to namespace count; acceptable given `list` is an infrequent, human-facing action

**Neutral**
- Master context, session checkpoints, and distillation remain single-namespace operations (always against `effectiveMemoryKey`) — multi-context is a read-layer feature; write-layer operations are not fanned out
- The `fts_embedding_fallback` path (ADR-0004) works transparently with multi-namespace keys — `searchMemoryFtsMulti` returns zero results, triggering the fallback against the already-loaded primary store
