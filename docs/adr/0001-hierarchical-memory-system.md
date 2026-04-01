# ADR-0001: Hierarchical memory system for cross-session context retention

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-04-01 |
| **Deciders** | JayCodesX |

---

## Context

### Original solution

orager was built as the runtime engine behind [Paperclip](https://paperclipai.com), initially targeting a single consumer: the Paperclip product itself. The design intentionally mirrored the Claude Code CLI's session model — a flat JSON file per session storing the full message history, resumable via `--session-id`. This was the right call at the time:

- Paperclip ran short, single-topic agent tasks where cold-starting each session was acceptable
- Matching Claude's session format made integration predictable and fast to ship
- The operational surface was minimal — one file per session, easy to inspect and debug

### Where it broke down

As usage evolved toward longer, multi-day product work and additional models (DeepSeek, GPT-4o, Gemini), the flat-session design exposed a fundamental gap: **every session started cold**.

Claude Code's native memory works because Anthropic built `CLAUDE.md` awareness directly into the model's training. When orager ran DeepSeek or GPT-4o under the same design, those models had no equivalent convention — no warm context, no memory of prior decisions, no knowledge of the product being built.

Concretely:
- Agents repeatedly rediscovered facts they had already established in prior sessions
- Token pressure from long histories forced aggressive summarization that discarded critical context
- DeepSeek-class models performed significantly below Sonnet/Opus not because of model quality alone, but because they lacked the contextual foundation that Claude's training provided natively
- There was no structured place to store project-level facts (stack, conventions, decisions) that should survive indefinitely across sessions

The performance gap between models was as much an infrastructure problem as a model capability problem.

### Decision drivers

- Must be embeddable — no external services, works offline, survives `bun build --compile` single-binary pipeline
- Must be backward compatible — existing JSON-backed sessions continue to work
- Must be non-fatal — a memory read/write failure must never abort an agent run
- Must work for all model providers, not just those with built-in memory conventions
- Must keep the stable portion of the system prompt cacheable at the API level

---

## Decision

Implement a four-layer hierarchical memory system built on WASM SQLite, with each layer addressing a distinct retention horizon.

### Solution

- **Storage** — WASM SQLite (`@sqlite.org/sqlite-wasm`), WAL mode, auto-vacuum, 50ms debounced persistence. Embeds in the binary without a native extension. Opt-out via `ORAGER_DB_PATH=none` to preserve JSON fallback for constrained environments.

- **Layer 1 — Master context** — a single SQL row per `context_id` (max 8,000 chars, ~2k tokens) always injected at session start before any retrieval. Managed explicitly via `remember set_master` and `remember view_master`. Permanent: survives indefinitely, never auto-pruned.

- **Layer 2 — Episodic checkpoints** — dual-trigger summarization fires on turn count (`summarizeTurnInterval`) or token pressure (actual `prompt_tokens` from the API response, not a local estimate). A raw checkpoint is written to `session_checkpoints` *before* the synthesis API call so context is never lost on a crash. The generated summary is validated (min 100 chars + 30% entity coverage) before replacing conversation history.

- **Layer 3 — Frozen prefix + cache boundaries** — the system prompt is split at a `frozenSystemPromptLength` boundary. Stable content (base instructions, skills, project CLAUDE.md, project commands, memory update instruction) forms the frozen block. For Anthropic models this block is emitted with `cache_control: { type: "ephemeral" }` so it is cached at the API level independently of the dynamic memory suffix. Cache hits survive across sessions even when retrieved memory changes.

- **Layer 4 — Structured output ingestion** — the model is instructed to append `<memory_update>` JSON blocks to responses when it discovers facts worth persisting. Each block is parsed, validated, and written to `memory_entries` without requiring an explicit tool call. A raw checkpoint is saved on ingestion. The instruction lives in the frozen section so it is cached.

- **Retrieval progression** — SQL exact-match (structured fields) → FTS5 full-text search (synchronous, zero-cost, handles keyword/entity recall) → embeddings fallback (Phase 6, opt-in, for semantic recall when FTS returns nothing useful). Minimises latency and API cost while keeping the quality ceiling high.

---

## Alternatives Considered

### 1. MEMORY.md / plain file per project

The original approach: a single Markdown file per working directory that the agent reads and writes via `remember` tool actions. Works acceptably for Claude Code because `CLAUDE.md` awareness is baked into the model's training — Claude already knows to read and respect it.

**Rejected because:** No equivalent convention exists for DeepSeek, GPT-4o, Gemini, or other providers. The file is not queryable (no FTS, no structured retrieval), not size-bounded without a custom parser, harder to update programmatically, and breaks under concurrent writes from parallel agent runs.

### 2. Session history replay only

Keep the existing flat-session design and rely on `--session-id` resume to carry context forward. Already supported. Works for short follow-up turns.

**Rejected because:** Sessions exceeding the model's context window require summarization, which discards facts. Cost scales linearly with history length with no ceiling. Resuming a week-old session that has been through multiple summarizations gives the model an increasingly lossy view of the past. There is no mechanism to distinguish facts that should persist indefinitely (stack choices, user preferences, architectural decisions) from turn-by-turn conversation noise.

### 8. Per-turn LLM-extracted notes (automatic every turn)

Use a secondary model call each turn to extract structured facts from the assistant's response and store them automatically — no explicit instruction to the model required.

**Rejected because:** Doubles the number of LLM API calls and roughly doubles per-turn cost. Generates noise — the majority of turns do not contain facts worth persisting, and a secondary model has less context than the primary to judge what matters. The `<memory_update>` approach delegates that judgment to the main model, which already has full context and has already decided what is worth surfacing in its response.

### 9. Master context as a MEMORY.md write

Store the persistent project context in `~/.orager/memory/<key>/MEMORY.md` alongside the existing flat memory entries, updated via the `remember` tool.

**Rejected because:** Not queryable by SQL or FTS — finding the master context requires reading the whole file. Not size-bounded without a custom parser (a runaway write could inflate the system prompt). Harder to update programmatically (no atomic upsert). When `ORAGER_DB_PATH=none` is set for the JSON fallback, the master context would be silently unavailable unless a separate code path was maintained.

---

## Consequences

**Positive**
- All model providers now benefit from structured memory — the performance gap between DeepSeek and Sonnet/Opus narrows significantly on multi-session tasks
- Prompt caching hit rates improve materially for Anthropic models: the frozen section (often 3–10k tokens of CLAUDE.md + instructions) is cached across all sessions in the same project
- Context loss on crash is eliminated by the raw-checkpoint-first pattern
- The retrieval architecture has a clear upgrade path (embeddings in Phase 6, ANN in Phase 8) without breaking the current behaviour

**Negative / Trade-offs**
- SQLite WASM adds ~3MB to the binary size
- The 50ms persistence debounce means the last write could be lost if the process is killed with SIGKILL (not SIGTERM) between debounce ticks — acceptable for the use case
- `<memory_update>` relies on the model following instructions correctly; adversarial or poorly-aligned models could emit malformed or excessive blocks (validated and capped at 500 chars per entry)

**Neutral**
- The JSON session fallback (`ORAGER_DB_PATH=none`) remains fully functional — existing deployments are unaffected
- FTS5 retrieval is synchronous and adds <1ms per query; the embeddings path (Phase 6) introduces async latency only when opted in
