# Memory System

orager uses a three-layer hierarchical memory system backed by SQLite (ADR-0001, ADR-0004, ADR-0008). Memory persists across sessions and can be scoped to projects via namespaces.

## Architecture

```
┌─────────────────────────────────────────┐
│           System Prompt                  │
│  ┌──────────────────────────────────┐   │
│  │  1. Master Context (permanent)   │   │  ← always injected
│  ├──────────────────────────────────┤   │
│  │  2. Retrieved Entries (FTS/vec)  │   │  ← retrieved per-run
│  ├──────────────────────────────────┤   │
│  │  3. Session Checkpoints          │   │  ← episodic, current session
│  └──────────────────────────────────┘   │
└─────────────────────────────────────────┘
```

### Layer 1: Master Context

Permanent key-value entries that are always injected into every run in a given namespace. Use this for facts that should never be forgotten: project conventions, standing instructions, architectural constraints.

Written with `write_memory` (tool) or `orager memory` (CLI).

### Layer 2: Long-Term Retrieval

Distilled entries retrieved at the start of each run using full-text search (FTS5) and vector similarity. The top matches for the current prompt are injected automatically. This layer grows over time as the agent distills useful information from sessions.

Embedding generation uses the configured model or a default embeddings endpoint.

### Layer 3: Session Checkpoints (Episodic)

Short-term episodic memory for the current session. Checkpoints are written automatically at configurable intervals (turn count or token pressure). When the context window fills, older turns are summarized and saved as a checkpoint so the session can continue without losing important context.

## Namespaces

Memory is scoped by a namespace key. Use `--memory-key` to separate projects:

```bash
orager run --memory-key myapp "What are the current open issues?"
orager chat --memory-key myapp
```

Multiple namespaces can be read simultaneously:

```bash
orager run --memory-key "myapp,shared-conventions" "prompt"
```

The default namespace is an empty string (global).

## Storage

All memory data is stored in `~/.orager/`:

| File | Contents |
|------|---------|
| `memory-<namespace>.db` | Master context, long-term entries, and session checkpoints for a namespace |
| `sessions/` | JSONL session transcripts |

## CLI Commands

### List namespaces

```bash
orager memory list
```

### Inspect a namespace

```bash
orager memory inspect
orager memory inspect myapp
```

### Export memory

```bash
orager memory export > memory-backup.json
orager memory export myapp > myapp-memory.json
```

### Clear memory

```bash
orager memory clear myapp
```

## Tuning Summarization

The summarization behaviour is controlled in `settings.json` under the `memory` key:

```json
{
  "memory": {
    "tokenPressureThreshold": 0.70,
    "turnInterval": 6,
    "keepRecentTurns": 4,
    "summarizationModel": "deepseek/deepseek-chat-v3-2"
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `tokenPressureThreshold` | `0.70` | Summarize when context is 70% full. Set to `0` to disable |
| `turnInterval` | `6` | Summarize every 6 turns. Set to `0` to disable |
| `keepRecentTurns` | `4` | Keep the last 4 turns intact when summarizing |
| `summarizationModel` | session model | Override the model used for summarization |

Or override per-run:

```bash
orager chat --summarize-at 0.8 --summarize-model deepseek/deepseek-chat-v3-2 --summarize-keep-recent-turns 6
```

## Prompt Caching

For Anthropic models, orager uses the `cache_control: ephemeral` breakpoint to cache the frozen portion of the system prompt (base instructions + skills + CLAUDE.md) separately from the dynamic memory suffix. This significantly reduces costs on long sessions by reusing cached prefixes across turns.

## Session Management

Sessions capture the full conversation history as JSONL. Use session commands to browse and manage them:

```bash
orager --list-sessions
orager --search-sessions "keyword"
orager --fork-session <id> --resume           # branch from a session
orager --compact-session <id>                 # summarize in-place
orager --rollback-session <id>                # undo last turn
orager --prune-sessions --older-than 30d      # clean up old sessions
```
