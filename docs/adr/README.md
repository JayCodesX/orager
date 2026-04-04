# Architecture Decision Records

This directory contains the Architecture Decision Records (ADRs) for orager.

ADRs document significant architectural choices: the context that drove them, the decision made, alternatives that were considered, and the consequences of that decision. They are written once and amended only when a decision is revisited or superseded.

## Index

| # | Title | Status | Date |
|---|---|---|---|
| [0001](./0001-hierarchical-memory-system.md) | Hierarchical memory system for cross-session context retention | Accepted | 2026-04-01 |
| [0002](./0002-ann-vector-index.md) | ANN vector index for semantic memory retrieval at scale | Accepted | 2026-04-01 |
| [0003](./0003-in-process-agents-remove-daemon.md) | In-process agents, remove HTTP daemon exec path | Accepted | 2026-04-02 |
| [0004](./0004-semantic-memory-retrieval-distillation.md) | Semantic memory retrieval and distillation | Accepted | 2026-04-02 |
| [0005](./0005-multi-context-cross-agent-memory.md) | Multi-context cross-agent memory | Accepted | 2026-04-02 |
| [0006](./0006-skillbank-persistent-skill-memory.md) | SkillBank — persistent skill memory | Accepted | 2026-04-02 |
| [0007](./0007-omls-opportunistic-rl-training.md) | OMLS — opportunistic RL training pipeline | Accepted | 2026-04-02 |
| [0008](./0008-storage-architecture-overhaul.md) | Storage architecture overhaul (native SQLite) | Accepted | 2026-04-03 |
| [0009](./0009-local-first-inference-client-architecture.md) | Local-first inference client architecture | Accepted | 2026-04-03 |
| [0010](./0010-provider-adapter-system.md) | Provider adapter system — decouple model routing from OpenRouter | Accepted | 2026-04-03 |
| [0011](./0011-skill-merge-pipeline.md) | Skill merge pipeline — consolidate similar skills into meta-skills | Accepted | 2026-04-04 |
| [0012](./0012-omls-mode.md) | OMLS mode — graduated learning from prompt to LoRA | Accepted | 2026-04-04 |

## Format

ADRs in this project follow the [MADR](https://adr.github.io/madr/) template with the Nygard core fields (Status, Context, Decision, Consequences) extended with Alternatives Considered and Decision Drivers.

## Adding a new ADR

1. Copy the structure from an existing ADR
2. Number sequentially (`0002-…`, `0003-…`)
3. Set status to `Proposed` until merged
4. Add a row to the index above
