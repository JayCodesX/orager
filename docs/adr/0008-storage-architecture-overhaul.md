# ADR-0008: Storage Architecture Overhaul — bun:sqlite, Per-Namespace Files, sqlite-vec, and JSONL Sessions

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-04-02 |
| **Deciders** | JayCodesX |

---

## Context

### The current storage stack and its failure modes

Orager's current storage layer was designed for single-agent, single-session use. It consists of a single monolithic SQLite database at `~/.orager/orager.db`, driven by `@sqlite.org/sqlite-wasm` — a WebAssembly port of SQLite that holds the entire database in RAM and serializes to disk on a 50ms debounce.

This design has three compounding problems that become critical as orager moves toward multi-agent workflows (ADR-0003, `spawn_agent` tool) and eventual cloud deployment:

#### Problem 1: WASM SQLite is the wrong driver for a CLI runtime

`@sqlite.org/sqlite-wasm` was designed for browser environments where native SQLite is unavailable. Running it in a Bun CLI process pays a significant tax with no benefit:

- **2.04–2.23x slower** than native SQLite for reads and writes
- **~500ms cold start** to download and parse the 938.9 kB WASM module — paid by every spawned subprocess agent before it can execute a single query
- **WAL mode is silently ignored** — falls back to in-memory journaling, removing all concurrency guarantees
- **Silent data loss on crash** — writes are debounced 50ms; any unclean exit in that window loses data with no recovery path
- **~1.25 MB binary size inflation** — the WASM blob must be base64-encoded into the compiled binary

Bun ships `bun:sqlite` as a first-class built-in: native, synchronous, zero dependencies, real WAL mode, memory-mapped files. There is no reason to use WASM in a Bun runtime.

#### Problem 2: Monolithic shared DB breaks under concurrent agents

The `spawn_agent` tool (ADR-0003) allows a parent agent to spawn multiple sub-agents in parallel. Each agent is a separate OS process or an in-process coroutine. All share `~/.orager/orager.db`.

With the current WASM driver, each process loads its own RAM snapshot of the DB at startup. Concurrent writes produce a last-flush-wins race — the second process to flush silently overwrites the first's changes. There is no error, no log, no recovery.

Even with a native driver, a single shared DB file creates write serialization pressure proportional to the number of agents. At 5 parent agents × 50 sub-agents = 255 concurrent agents:

| Metric | Current (WASM, monolithic) |
|--------|---------------------------|
| Startup overhead | 255 × 500ms = **127.5 seconds** |
| RAM for DB snapshots | 255 × ~15 MB = **~3.8 GB** |
| Session writes/turn | 1,020–2,550 hitting one file |
| Data loss risk | **Guaranteed** at this scale |
| SQLITE_BUSY errors | Constant |

The system falls over well before 255 agents. Real contention begins around 5–10 concurrent subprocess agents.

#### Problem 3: Vector similarity search scales poorly

Memory retrieval and SkillBank deduplication both work by loading all embedding BLOBs from SQLite into JavaScript and computing cosine similarity in a loop:

```typescript
// Current pattern — memory-sqlite.ts, skillbank.ts
const rows = db.prepare("SELECT * FROM memory_entries").all();
for (const row of rows) {
  const emb = blobToEmbedding(row.embedding);
  const score = cosineSimilarity(queryEmbedding, emb);
}
```

Performance degrades linearly with entry count:

| Entries | Current JS cosine loop | Notes |
|---------|----------------------|-------|
| 500 | ~5–15ms | Acceptable today |
| 2,000 | ~20–60ms | Noticeable latency |
| 10,000 | ~200–500ms | Approaches unusable |
| 255 agents querying simultaneously | CPU saturation | Agents stall on similarity search |

The crossover point where this becomes a user-visible problem is approximately 2,000 memory entries — reachable by an active user within weeks.

#### Problem 4: Session saves generate unnecessary write pressure

The agent loop saves session state 4–10 times per turn (after approval, on cancellation, after summarization, at turn end, in the finally block, etc.). Each save serializes and writes the full session JSON blob. Under concurrent agents this generates the bulk of write contention:

```
255 agents × 7 saves/turn = 1,785 full-blob writes/turn to one DB file
```

Most of these writes are redundant — the session state at turn N+1 is a superset of turn N. Rewriting the full blob on every save is both wasteful and the primary source of lock contention.

---

## Decision

Replace the current storage stack with a three-component architecture:

### Component 1: `bun:sqlite` as the native driver

Replace `@sqlite.org/sqlite-wasm` with Bun's built-in `bun:sqlite` across all storage modules (`memory-sqlite.ts`, `session-sqlite.ts`, `skillbank.ts`, `wasm-sqlite.ts`).

The `WasmCompatDb` shim (`wasm-sqlite.ts`) is removed. All DB access uses `bun:sqlite` directly via a thin wrapper that preserves the existing synchronous API surface.

**Pragmas applied to all databases:**

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
PRAGMA auto_vacuum = INCREMENTAL;
PRAGMA mmap_size = 134217728; -- 128 MB memory-mapped I/O
```

`busy_timeout = 5000` means agents wait up to 5 seconds on a locked write rather than failing immediately — eliminating spurious `SQLITE_BUSY` errors under moderate contention.

### Component 2: Per-namespace SQLite files for memory and skills

Split the monolithic `~/.orager/orager.db` into separate SQLite files per logical namespace:

```
~/.orager/
  memory/
    <memoryKey>.sqlite       # one file per memory namespace
  skills/
    <memoryKey>.sqlite       # one file per skill namespace (or shared)
  sessions/
    index.sqlite             # lightweight metadata index only
    <sessionId>.jsonl        # session transcripts (see Component 3)
```

**Why this eliminates multi-agent contention:**

Agents operating in different namespaces (`memoryKey`) never touch the same file. They cannot contend. Agents sharing a namespace get real WAL concurrency — unlimited concurrent reads, serialized writes that queue rather than fail.

At 255 concurrent agents with diverse memory keys, the vast majority of agents are writing to different files. The shared-key case (multiple agents in the same namespace) is the minority and is handled safely by WAL.

This mirrors the approach used by OpenClaw (`~/.openclaw/memory/<agentId>.sqlite`) and validated at production scale.

**Cross-namespace queries** (currently handled by `searchMemoryFtsMulti`) continue to work by opening multiple SQLite connections and merging results in JavaScript — the same in-JS merge already performed for cosine similarity scoring.

### Component 3: JSONL append-only session transcripts

Replace session blob storage with an append-only JSONL transcript per session, mirroring Claude Code's approach:

```
~/.orager/sessions/<sessionId>.jsonl   # one JSON line per turn event
~/.orager/sessions/index.sqlite         # metadata: model, cwd, timestamps, summary
```

**Turn event format:**
```jsonl
{"type":"turn","turn":1,"role":"assistant","content":"...","model":"...","ts":"2026-04-02T20:00:00Z"}
{"type":"tool","turn":1,"name":"bash","result":"...","ts":"2026-04-02T20:00:01Z"}
{"type":"memory","turn":1,"key":"personal","entries":3,"ts":"2026-04-02T20:00:02Z"}
{"type":"summary","turn":6,"content":"...","ts":"2026-04-02T20:00:10Z"}
```

**Properties:**
- Each turn appended as a single `fs.appendFile()` call — microsecond latency, no lock acquired
- 255 agents writing 255 different session files = zero contention (different files)
- Crash resilience: only the last incomplete line is lost, recoverable by trimming
- Session resume: replay JSONL from disk, no deserialization of large JSON blobs
- `index.sqlite` written once at session close — write pressure drops ~90%

**Session save frequency drops from 4–10 writes/turn (full blob) to 1 append/turn (single JSON line).**

### Component 4: `sqlite-vec` for native vector similarity search

Load the `sqlite-vec` extension into each memory and skills SQLite database:

```typescript
db.loadExtension("sqlite-vec");
```

Replace JavaScript cosine similarity loops with native SQL:

```sql
-- Before: load all embeddings into JS, loop
SELECT * FROM memory_entries WHERE memory_key = ?

-- After: native ANN search inside SQLite
SELECT *, vec_distance_cosine(embedding, ?) AS score
FROM memory_entries
WHERE memory_key = ?
ORDER BY score ASC
LIMIT 20
```

**Performance at orager's scale:**

| Entries | sqlite-vec latency | Current JS loop | Improvement |
|---------|-------------------|----------------|-------------|
| 500 | < 1ms | 5–15ms | 5–15x |
| 2,000 | < 2ms | 20–60ms | 10–30x |
| 10,000 | < 17ms | 200–500ms | 12–30x |
| 100,000 | ~4ms (quantized) | CPU saturation | Practical ceiling removed |

Use 8-bit quantization for embeddings beyond 10,000 entries — 4x memory reduction with ~95% accuracy preserved.

**SkillBank deduplication** (currently a full table scan in JS) becomes a single SQL query, eliminating the O(n) load of all skill embeddings per extraction.

---

## Consequences

### Positive

**Performance at 255 concurrent agents:**

| Metric | Current | After ADR-0008 |
|--------|---------|----------------|
| Startup overhead (255 agents) | 127.5 seconds | ~0 seconds |
| RAM for DB instances | ~3.8 GB | ~50–100 MB |
| Session write contention | 1,785 writes/turn, one file | 255 appends, 255 files, zero contention |
| Memory query latency (2,000 entries) | 20–60ms | < 2ms |
| Silent data loss risk | Guaranteed at scale | Eliminated |
| SQLITE_BUSY errors | Constant under load | Eliminated (busy_timeout queues) |
| Binary size | +1.25 MB WASM blob | Removed |
| WAL mode | No-op (silently ignored) | Real WAL, 4x write throughput |

**Crash resilience:** JSONL sessions lose at most one incomplete line. Memory SQLite uses real WAL — uncommitted transactions roll back automatically on restart.

**Operational simplicity:** Per-namespace files can be inspected, backed up, or deleted individually without touching other agents' data. `cp ~/.orager/memory/personal.sqlite ~/backup/` is a complete memory backup.

### Negative

**Cross-namespace queries require multi-file merging.** `searchMemoryFtsMulti` must open N SQLite connections and merge in JS. This is already the pattern for cosine similarity scoring and adds minimal overhead for the typical case of 2–3 namespaces.

**`sqlite-vec` is a loadable extension** — it must be present on the host system or bundled with the binary. For binary builds, `sqlite-vec` is compiled as a static extension linked into the Bun binary via the build script. This adds complexity to `scripts/build-binary.mjs`.

**Migration required for existing users.** A one-time migration script reads the monolithic `~/.orager/orager.db` and writes per-namespace files. Sessions are re-emitted as JSONL from stored JSON blobs. The migration runs automatically on first launch after upgrade and takes < 1 second for typical DB sizes.

**`wasm-sqlite.ts` is deleted.** Any external code importing from this module breaks. Since it is not part of the public API surface (`index.ts` does not re-export it), impact is internal only.

### Neutral

**The `withMemoryLock` race condition** (loop.ts line 1962 calls `saveMemoryStoreAny` without the per-key mutex) is fixed as part of this migration. Per-namespace SQLite files with WAL provide the isolation layer; the in-process mutex is still applied for in-process concurrent coroutines sharing a key.

**Session resume UX is unchanged.** `orager chat --session-id <id>` replays the JSONL transcript to reconstruct state. Latency is equivalent to the current JSON parse.

---

## Alternatives Considered

### DB proxy process (ADR-0010, parked)

A single writer process accepting DB operations over a Unix socket eliminates all write contention regardless of driver or file layout. This is the correct solution if a single hot memory namespace is being written by 25+ concurrent agents simultaneously.

**Rejected for now:** The per-namespace file approach eliminates contention for the common case (diverse namespaces) at zero architectural complexity. The proxy is retained as ADR-0010 to be implemented if a single-namespace hot-write scenario is observed in production.

### PostgreSQL + pgvector for all storage

Correct for the Orager Cloud multi-tenant backend (ADR-0009). Wrong for the local CLI — requires a running server, network stack, and connection management. Adds ~100ms query latency vs microseconds for local SQLite. Incompatible with offline-first and privacy-first positioning.

### Keep monolithic DB, add write batching

Reduces write frequency but does not eliminate contention or the WASM silent-corruption risk. A partial fix that leaves the fundamental problems in place.

### LevelDB / RocksDB

Strong write throughput, poor FTS support, no vector search, no SQL. Would require reimplementing query logic currently handled by SQLite's query planner. Not worth the trade-off given SQLite's improving vector support via `sqlite-vec`.

---

## Implementation Plan

**Phase 1 — Driver swap (no schema changes)**
1. Replace `@sqlite.org/sqlite-wasm` dependency with `bun:sqlite`
2. Delete `wasm-sqlite.ts`, rewrite `db.ts` with native connection management
3. Apply WAL pragmas + `busy_timeout`
4. Fix `withMemoryLock` usage in `loop.ts`
5. All existing tests pass with new driver

**Phase 2 — Per-namespace file split**
1. Update `memory-sqlite.ts` to open `~/.orager/memory/<memoryKey>.sqlite`
2. Update `skillbank.ts` to open `~/.orager/skills/<memoryKey>.sqlite`
3. Update `searchMemoryFtsMulti` to merge across connections
4. Write one-time migration script
5. Update `ORAGER_DB_PATH` env var semantics (now a directory, not a file)

**Phase 3 — JSONL sessions**
1. Add JSONL writer to `session-sqlite.ts`
2. Update `loop.ts` to append turn events instead of full-blob saves
3. Add replay loader for session resume
4. Migrate `index.sqlite` to metadata-only schema

**Phase 4 — sqlite-vec**
1. Add `sqlite-vec` to `build-binary.mjs` as static extension
2. Replace JS cosine loops in `memory-sqlite.ts` and `skillbank.ts`
3. Add 8-bit quantization option for large memory stores
4. Update `searchMemoryFts` to use `vec_distance_cosine` for hybrid FTS + vector ranking

Each phase is independently shippable and does not break existing functionality.

---

## References

- [sqlite-vec stable release benchmarks](https://alexgarcia.xyz/blog/2024/sqlite-vec-stable-release/index.html)
- [bun:sqlite documentation](https://bun.com/docs/runtime/sqlite)
- [better-sqlite3 benchmarks](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/benchmark.md)
- [SQLite WAL mode internals — Fly.io](https://fly.io/blog/sqlite-internals-wal/)
- [OpenClaw memory architecture](https://docs.openclaw.ai/concepts/memory)
- [Claude Code local storage design — Milvus](https://milvus.io/blog/why-claude-code-feels-so-stable-a-developers-deep-dive-into-its-local-storage-design.md)
- [SQLite concurrent write transactions](https://oldmoe.blog/2024/07/08/the-write-stuff-concurrent-write-transactions-in-sqlite/)
- ADR-0003: In-process agents, removal of HTTP daemon
- ADR-0006: SkillBank persistent skill memory
