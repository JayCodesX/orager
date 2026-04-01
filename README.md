# orager

[![CI](https://github.com/JayCodesX/orager/actions/workflows/ci.yml/badge.svg)](https://github.com/JayCodesX/orager/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/orager)](https://www.npmjs.com/package/orager)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node ≥20](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](https://nodejs.org)
[![Bun](https://img.shields.io/badge/runtime-bun-black)](https://bun.sh)

A production-grade agent loop engine that runs multi-turn, tool-calling LLM workflows against any model provider — built as the runtime behind [Paperclip](https://paperclipai.com) agents.

---

## Table of Contents

- [Why orager](#why-orager)
- [How it works](#how-it-works)
- [Features](#features)
- [Install](#install)
- [Quick start](#quick-start)
- [Configuration](#configuration)
  - [Environment variables](#environment-variables)
  - [CLI flags](#cli-flags)
- [Model support](#model-support)
- [Memory system](#memory-system)
- [Session management](#session-management)
- [Architecture](#architecture)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

---

## Why orager

Running LLM agents in production requires more than a single API call:

- Repeatedly calling an LLM, executing tools, and managing context across long sessions
- Working with any model (Claude, DeepSeek, GPT-4o, Gemini, Llama) without code changes
- Retaining facts across sessions so agents don't start cold every time
- Preventing runaway token spend and context window overflow
- Keeping startup overhead low when agents fire every 30 seconds

Existing options are either locked to one provider, too bare-bones for production, or too slow for high-frequency heartbeats.

---

## How it works

```
                          ┌─────────────────────┐
                          │   Paperclip / CLI    │
                          └──────────┬──────────┘
                                     │
                        stdin or POST /run (JWT)
                                     │
                                     ▼
                          ┌─────────────────────┐
                          │     daemon.ts        │
                          │  HTTP server on      │
                          │  127.0.0.1           │
                          │                      │
                          │  POST /run           │
                          │  GET  /health        │
                          │  GET  /metrics       │
                          │  POST /drain         │
                          └──────────┬──────────┘
                                     │
                                     ▼
┌──────────────────────────────────────────────────────────────────────┐
│                          loop.ts — Agent Loop                        │
│                                                                      │
│  1. Assemble system prompt                                           │
│     ├─ [FROZEN]  base instructions · skills · CLAUDE.md · commands  │
│     │            ← cache_control breakpoint (Anthropic models)       │
│     └─ [DYNAMIC] master context · retrieved memory · auto-memory    │
│                                                                      │
│  2. Apply Anthropic cache breakpoints (tools · prior history)        │
│  3. Set X-Session-Id for OpenRouter sticky routing                   │
│                                                                      │
│  ┌────────────────────── Turn Loop ──────────────────────┐           │
│  │                                                        │           │
│  │  openrouter.ts ── call LLM (SSE stream) ──┐           │           │
│  │                                             │           │           │
│  │  Parse text + tool calls + reasoning        │           │           │
│  │  Parse <memory_update> blocks               │           │           │
│  │                                             ▼           │           │
│  │  tools/* ── execute tools (up to 10 concurrent)        │           │
│  │                                             │           │           │
│  │  Post-turn:                                 │           │           │
│  │    • Ingest memory updates → SQLite         │           │           │
│  │    • Cost cap · context threshold           │           │           │
│  │    • Auto-summarize + checkpoint            │           │           │
│  │    • Session save                           │           │           │
│  └────────────────────────────────────────────┘           │
│                                                            │
│  Emit NDJSON stream → stdout or HTTP response              │
└──────────────────────────────────────────────────────────┘
```

---

## Features

### Agent loop
Multi-turn execution engine. Calls the LLM, parses tool calls, executes them in parallel (up to 10 concurrent), tracks cost and token usage, and saves session state after every turn. Supports model fallback rotation on 429/503 and API key pool rotation mid-run.

### Tool system — 27 built-in tools

| Category | Tools |
|---|---|
| **File system** | `read_file`, `write_file`, `str_replace`, `edit_file`, `edit_files`, `list_dir`, `glob`, `delete_file`, `move_file`, `create_dir` |
| **Search** | `grep` — regex search with context lines, glob filter, case-insensitive mode |
| **Shell** | `bash` — command execution with timeout, blocklist, OS sandbox (macOS sandbox-exec, Linux bwrap) |
| **Web** | `web_fetch` (HTTP with SSRF protection), `web_search` (DuckDuckGo) |
| **Browser** | `browser_navigate`, `browser_screenshot`, `browser_click`, `browser_type`, `browser_key`, `browser_scroll`, `browser_execute`, `browser_close` |
| **Notebooks** | `notebook_read`, `notebook_edit` |
| **Control** | `finish`, `exit_plan_mode`, `todo_write`, `todo_read` |

### Daemon mode
Persistent HTTP server (JWT-authenticated, HS256, 5-min TTL) that eliminates ~200ms Node.js startup overhead per run. Skill caches, tool result caches, and LLM prompt caches stay warm between requests. Features concurrency control, graceful drain, idle auto-shutdown, and cache warming on startup.

### Memory system
Three-layer hierarchical memory built on embedded SQLite. See [Memory system](#memory-system) below.

### Context management
Automatic session summarization triggered by token pressure (actual `prompt_tokens` from the API response) or a configurable turn interval. Only assistant messages are summarized — tool results and system prompts are never sent to the summarization model. Raw checkpoints are written before synthesis to prevent data loss on crashes.

### Prompt caching (Anthropic models)
The system prompt is split into a **frozen prefix** (base instructions, skills, project CLAUDE.md) and a **dynamic suffix** (per-session memory). The frozen prefix emits with `cache_control: ephemeral` as a separate content block, caching it at the API level independently of memory that changes between sessions. Additional breakpoints on the last tool definition and last prior-turn message maximise hit rates across turns.

### Profiles
Opinionated presets: `code-review`, `bug-fix`, `research`, `refactor`, `test-writer`, `devops`. Custom profiles via `~/.orager/profiles/`.

### MCP client
Connects to external MCP servers (Streamable HTTP transport) with auto-reconnect. Auto-discovers from `~/.claude/claude_desktop_config.json`.

### Observability
- JSON metrics — active runs, model usage, provider health, circuit breaker states, per-agent costs
- Prometheus endpoint — `/metrics/prometheus`
- Health checks — minimal `/health` (public) + detailed `/health/detail` (authenticated, subsystem checks)
- Circuit breaker — per-provider OPEN/HALF_OPEN/CLOSED
- Audit log — append-only NDJSON at `~/.orager/audit.log` (0600), auto-rotation at 10 MB
- OpenTelemetry — trace/span integration

### Security
- JWT-authenticated daemon (key at `~/.orager/daemon.key`, chmod 600, auto-generated; dual-key rotation for zero-downtime changes)
- OS sandboxing enabled by default (macOS `sandbox-exec`, Linux `bwrap`)
- Secret redaction — regex-based stripping of API keys, tokens, passwords from streamed output
- Schema validation at API boundary; dangerous opts stripped from daemon requests
- Rate limiting — per-model tracking from response headers

---

## Install

```bash
npm install -g orager
```

**Set your API key:**

```bash
export PROTOCOL_API_KEY=sk-or-...   # OpenRouter (required)
export ANTHROPIC_API_KEY=sk-ant-... # Optional: enables direct Anthropic fast-path
```

Verify the install:

```bash
orager --version
```

---

## Quick start

```bash
# One-shot task via stdin
echo "Refactor the auth module to use async/await" | orager --print - --model deepseek/deepseek-chat-v3-0324

# Interactive daemon mode (eliminates per-run startup overhead)
orager --serve --port 3456

# Resume a previous session
orager --session-id <id> --print "Add error handling to what you wrote"

# Use a task profile
orager --profile code-review --print "Review the changes in src/loop.ts"

# Cap cost and set a turn limit
orager --max-cost-usd 0.50 --max-turns 20 --print "Audit the auth module for security issues"
```

---

## Configuration

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `PROTOCOL_API_KEY` | — | OpenRouter API key (required) |
| `ANTHROPIC_API_KEY` | — | Enables direct Anthropic fast-path, bypassing OpenRouter |
| `ORAGER_DB_PATH` | `~/.orager/orager.db` | SQLite database path |
| `ORAGER_DB_PATH=none` | — | Disables SQLite; falls back to JSON session + memory files |
| `ORAGER_SESSIONS_DIR` | `~/.orager/sessions/` | JSON session storage directory (fallback only) |
| `ORAGER_MEMORY_DIR` | `~/.orager/memory/` | JSON memory storage directory (fallback only) |
| `ORAGER_TLS_CERT` | — | Path to TLS certificate for daemon HTTPS |
| `ORAGER_TLS_KEY` | — | Path to TLS private key for daemon HTTPS |
| `ORAGER_SKIP_PID_LOCK` | — | Set to `1` to disable PID lock (useful in CI/tests) |

### CLI flags

| Flag | Default | Description |
|---|---|---|
| `--model` | `anthropic/claude-sonnet-4-5` | LLM model identifier (OpenRouter format) |
| `--print` | — | Run in print mode; pass prompt or `-` for stdin |
| `--serve` | — | Start HTTP daemon server |
| `--port` | `3456` | Daemon listen port |
| `--session-id` | — | Resume an existing session by ID |
| `--force-resume` | `false` | Resume even if saved CWD doesn't match current CWD |
| `--max-turns` | unlimited | Hard cap on agent loop iterations |
| `--max-cost-usd` | — | Hard cost limit in USD; aborts when exceeded |
| `--max-cost-usd-soft` | — | Soft cost limit; warns and stops gracefully |
| `--summarize-at` | `0` (off) | Summarize when prompt tokens exceed this fraction of context window (e.g. `0.8`) |
| `--summarize-turn-interval` | `0` (off) | Summarize every N turns regardless of token count |
| `--summarize-model` | same as `--model` | Model used for session summarization |
| `--memory-key` | derived from CWD | Namespace key for cross-session memory |
| `--add-dir` | — | Additional directory to load skills from |
| `--profile` | — | Apply a named task profile |
| `--plan-mode` | `false` | Start in read-only exploration mode |
| `--timeout-sec` | — | Hard wall-clock timeout for the entire run |
| `--dangerously-skip-permissions` | `false` | Bypass all tool approval prompts |

---

## Model support

orager routes through [OpenRouter](https://openrouter.ai) (300+ models, one API key). Set `ANTHROPIC_API_KEY` to call Anthropic directly — lower latency, no markup.

| Provider | Example models | Tool use | Vision | Notes |
|---|---|---|---|---|
| **Anthropic** | `anthropic/claude-sonnet-4-5`, `anthropic/claude-opus-4-5` | ✅ | ✅ | Direct fast-path available; prompt caching; frozen-prefix cache hits |
| **DeepSeek** | `deepseek/deepseek-chat-v3-0324`, `deepseek/deepseek-r1` | ✅ | ❌ | Excellent for code; benefits most from the memory system |
| **OpenAI** | `openai/gpt-4o`, `openai/o3-mini` | ✅ | ✅ | |
| **Google** | `google/gemini-2.0-flash`, `google/gemini-2.5-pro` | ✅ | ✅ | |
| **Meta** | `meta-llama/llama-3.3-70b-instruct` | ✅ | ❌ | |
| **Any OpenRouter model** | `provider/model-name` | varies | varies | Full list at [openrouter.ai/models](https://openrouter.ai/models) |

> **DeepSeek and other non-Anthropic models benefit most from the memory system.** Without it, every session starts cold — they have no equivalent of Claude's built-in `CLAUDE.md` awareness. The three-layer memory stack closes a significant portion of the performance gap on multi-session tasks.

---

## Memory system

orager maintains three layers of persistent memory backed by an embedded SQLite database at `~/.orager/orager.db`.

### Layer 1 — Master context (permanent)

Project-level facts that survive indefinitely: stack decisions, conventions, architectural choices, team preferences.

```bash
# Set the master context for the current project
orager --print "remember set_master with content: 'Stack: Next.js 15, Postgres 16, Bun runtime. All API routes live in src/app/api/. Tests use Bun test runner. Never use console.log in production code.'"

# View the current master context
orager --print "remember view_master"
```

Always injected at session start before any retrieval. Maximum ~2k tokens (8,000 chars). Update it as the project evolves.

### Layer 2 — Retrieved memory (per-session facts)

Facts the agent discovers during runs — bugs, decisions, user preferences, environment details. Stored in `memory_entries` and retrieved by relevance at the start of each new session.

The agent writes entries in two ways:

**Explicit tool call:**
```
remember add — "The payment webhook uses HMAC-SHA256 with the secret in STRIPE_WEBHOOK_SECRET"
```

**Automatic structured output** (no tool call required):
```
<memory_update>
{"content": "User prefers explicit error types over generic Error throws", "importance": 3, "tags": ["typescript", "conventions"]}
</memory_update>
```

### Layer 3 — Session checkpoints (episodic)

Compressed snapshots written automatically when sessions are summarized. Prevents context loss across long multi-day runs. Raw checkpoints are written *before* summarization so a crash mid-synthesis loses nothing.

### Disabling memory

```bash
ORAGER_DB_PATH=none orager --print "..."
```

Falls back to JSON session files. No cross-session memory, but all other features work normally.

---

## Session management

```bash
# List recent sessions
orager sessions list

# Search sessions by content
orager sessions search "auth refactor"

# Resume a session
orager --session-id <id> --print "continue where we left off"

# Force-resume from a different directory
orager --session-id <id> --force-resume --print "..."

# Trash a session (soft delete, recoverable)
orager sessions trash <id>

# Permanently delete trashed sessions
orager sessions empty-trash

# Prune sessions older than 30 days
orager sessions prune --older-than 30d
```

Sessions are stored in `~/.orager/orager.db` (SQLite, concurrent-safe via advisory locking). Set `ORAGER_DB_PATH=none` to use the legacy JSON file store.

---

## Architecture

| File | Responsibility |
|---|---|
| `src/loop.ts` | Main agent loop — prompt assembly, turn execution, summarization, memory ingestion |
| `src/loop-helpers.ts` | Pure utilities — token estimation, summarization, `parseMemoryUpdates`, cache helpers, memory header constants |
| `src/openrouter.ts` | API client — SSE streaming, Anthropic cache control, direct fast-path |
| `src/session.ts` | Session store abstraction — load/save/lock/prune |
| `src/session-sqlite.ts` | SQLite session store — WAL, FTS5 search, advisory locking, checkpoints |
| `src/memory-sqlite.ts` | Memory entry store — master context, FTS5 retrieval, embedding support |
| `src/memory.ts` | File-based memory store (fallback) and shared retrieval logic |
| `src/daemon/` | HTTP server, JWT auth, routes (`/run`, `/health`, `/metrics`, `/drain`) |
| `src/tools/` | Built-in tool executors |

For architectural decisions, see [`docs/adr/`](./docs/adr/).

---

## Development

```bash
# Install dependencies
bun install

# TypeScript type check
bun run typecheck

# Run tests for a specific file (fast — use this during development)
bun test ./tests/memory-sqlite.test.ts

# Run the full unit test suite
bun run test:bun

# Run integration tests (slow — let CI handle these)
bun run test:bun:int

# Watch mode — auto-reruns on save
bun run test:bun:watch

# Build (tsc → dist/)
bun run build

# Build a standalone binary (Apple Silicon)
bun run build:binary:local

# Start in dev mode (no compile step)
bun run dev
```

**Test isolation note:** Bun runs all test files in the same OS process. Modules with process-global singletons export a `_resetForTesting()` function. Tests that need the file-based store (not SQLite) set `ORAGER_DB_PATH=none` and call the reset function in `beforeEach`. See `CLAUDE.md` for the full isolation pattern.

---

## Contributing

1. Fork the repo and create a feature branch
2. Make your changes — add tests for new behaviour
3. Run `bun run typecheck && bun run test:bun` — all must pass
4. Open a PR; CI runs automatically on every push

For significant architectural changes, add an ADR in [`docs/adr/`](./docs/adr/) alongside your PR.

---

## License

MIT — see [LICENSE](./LICENSE)
