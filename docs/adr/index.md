# Architecture Decision Records

This directory contains the Architecture Decision Records (ADRs) for orager.

ADRs document significant architectural choices: the context that drove them, the decision made, alternatives considered, and the consequences. They are written once and amended only when a decision is revisited or superseded.

## Index

| # | Title | Status | Date |
|---|-------|--------|------|
| [ADR-0001](./0001-hierarchical-memory-system.md) | Hierarchical memory system for cross-session context retention | Accepted | 2026-04-01 |
| [ADR-0002](./0002-ann-vector-index.md) | ANN vector index for semantic memory retrieval at scale | Proposed (deferred) | 2026-04-01 |
| [ADR-0003](./0003-in-process-agents-remove-daemon.md) | In-process agents with optional subprocess fallback — remove the daemon | Accepted | 2026-04-01 |
| [ADR-0004](./0004-semantic-memory-retrieval-distillation.md) | Semantic memory retrieval, auto-embedding, and long-term distillation | Accepted | 2026-04-01 |
| [ADR-0005](./0005-multi-context-cross-agent-memory.md) | Multi-context and cross-agent memory sharing | Accepted | 2026-04-01 |
| [ADR-0006](./0006-skillbank-persistent-skill-memory.md) | SkillBank — Persistent Skill Memory and Injection | Accepted | 2026-04-02 |
| [ADR-0007](./0007-omls-opportunistic-rl-training.md) | OMLS — Opportunistic RL Training with VPS Burst, Confidence Routing, and Teacher Distillation | Accepted | 2026-04-02 |
| [ADR-0008](./0008-storage-architecture-overhaul.md) | Storage Architecture Overhaul — bun:sqlite, Per-Namespace Files, sqlite-vec, and JSONL Sessions | Accepted | 2026-04-02 |
| [ADR-0009](./0009-local-first-inference-client-architecture.md) | Local-First Inference, Desktop Client Architecture, and Subscription Model | Proposed | 2026-04-02 |
| [ADR-0010](./0010-provider-adapter-system.md) | Provider Adapter System — Decouple Model Routing from OpenRouter | Accepted | 2026-04-03 |

## Format

ADRs in this project follow the [MADR](https://adr.github.io/madr/) template with the Nygard core fields (Status, Context, Decision, Consequences) extended with Alternatives Considered and Decision Drivers.

## Adding a New ADR

1. Copy the structure from an existing ADR
2. Number sequentially (`0010-…`, `0011-…`)
3. Set status to `Proposed` until merged
4. Add a row to the index above
