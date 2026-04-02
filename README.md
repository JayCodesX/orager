# orager

[![CI](https://github.com/JayCodesX/orager/actions/workflows/ci.yml/badge.svg)](https://github.com/JayCodesX/orager/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@jaycodesx/orager)](https://www.npmjs.com/package/@jaycodesx/orager)
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
- [Multi-agent workflows](#multi-agent-workflows)
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
- Orchestrating multi-agent workflows where one agent's output feeds the next

Existing options are either locked to one provider, too bare-bones for production, or too complex to embed in your own stack.

---

## How it works

```
┌──────────────────────────────────────┐
│          Your code / CLI             │
│                                      │
│  orager run "prompt"                 │
│  orager chat                         │
│  runAgentLoop(opts)      (library)   │
│  runAgentWorkflow(wf, p) (library)   │
└─────────────────┬────────────────────┘
                  │  in-process  (default)
                  │  or subprocess JSON-RPC 2.0
                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│                        loop.ts — Agent Loop                          │
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
│  Emit NDJSON stream → stdout                               │
└──────────────────────────────────────────────────────────┘
```

---

## Features

### `orager run` — non-interactive agent
Run an agent once with a prompt and exit. Output is streamed to stdout as NDJSON events. Machine-readable and composable with pipes.

### `orager chat` — interactive REPL
Multi-turn conversation that preserves session context across turns. Assistant text written directly to stdout. `Ctrl+D` or `exit` to quit.

### `orager serve` — browser UI
Start a local browser UI (port 3457) for viewing config, settings, logs, costs, and session history. Agents still run in-process via `orager run` or `orager chat` — the server is UI-only.

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

### Multi-agent workflows
Compose sequential pipelines where each agent is a named step. Each step's output is passed as the next step's prompt via a configurable `handoff` function.

```ts
import { runAgentWorkflow } from "@jaycodesx/orager";

await runAgentWorkflow({
  base: { apiKey, onEmit, cwd: process.cwd(), /* ... */ },
  steps: [
    { role: "researcher",   model: "deepseek/deepseek-r1",          maxTurns: 5 },
    { role: "synthesizer",  model: "anthropic/claude-sonnet-4-6",   maxTurns: 3 },
    { role: "code-writer",  model: "deepseek/deepseek-chat-v3-0324" },
  ],
}, "Analyse the auth module and propose a rewrite");
```

### Subprocess transport
Run the agent loop in an isolated child process over JSON-RPC 2.0 (same protocol as Claude Code MCP servers). Useful when you need process isolation, memory limits, or parallel agent execution.

```ts
import { runAgentLoop } from "@jaycodesx/orager";

await runAgentLoop({
  // ...
  subprocess: { enabled: true, timeoutMs: 60_000 },
});
```

Or from the CLI:

```bash
orager run --subprocess "audit the codebase for security issues"
```

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
- JSON metrics via `orager serve` UI
- Audit log — append-only NDJSON at `~/.orager/audit.log` (0600), auto-rotation at 10 MB
- OpenTelemetry — trace/span integration

---

## Install

```bash
npm install -g @jaycodesx/orager
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
# Non-interactive: run agent once and exit
orager run "Refactor the auth module to use async/await"

# Use a specific model
orager run --model deepseek/deepseek-r1 "Review the changes in src/loop.ts"

# Interactive multi-turn conversation
orager chat

# Resume a previous session in chat
orager chat --session-id <id>

# Cap cost and set a turn limit
orager run --max-cost-usd 0.50 --max-turns 20 "Audit the auth module for security issues"

# Use a task profile
orager run --profile code-review "Review PR #42"

# Use a named memory namespace
orager run --memory-key my-project "What do you remember about this codebase?"

# Run agent in an isolated subprocess
orager run --subprocess "generate the test suite for src/auth.ts"

# Start the browser UI (config, logs, costs)
orager serve
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
| `ORAGER_SKIP_PID_LOCK` | — | Set to `1` to disable PID lock (useful in CI/tests) |

### CLI flags

**Commands**

| Command | Description |
|---|---|
| `orager run "prompt"` | Run agent once and exit (non-interactive) |
| `orager chat` | Interactive multi-turn conversation |
| `orager serve [--port n]` | Start browser UI server (default port 3457) |
| `orager ui [--port n]` | Alias for `orager serve` |
| `orager setup` | Run interactive setup wizard |
| `orager memory <list\|inspect\|export\|clear>` | Manage memory namespaces |

**Common flags (run & chat)**

| Flag | Default | Description |
|---|---|---|
| `--model <id>` | `deepseek/deepseek-chat-v3-2` | LLM model identifier (OpenRouter format) |
| `--session-id <id>` | — | Resume an existing session by ID (alias: `--resume`) |
| `--force-resume` | `false` | Resume even if saved CWD doesn't match current CWD |
| `--max-turns <n>` | `20` | Hard cap on agent loop iterations |
| `--max-cost-usd <n>` | — | Hard cost limit in USD; aborts when exceeded |
| `--max-cost-usd-soft <n>` | — | Soft cost limit; warns and stops gracefully |
| `--memory-key <key>` | derived from CWD | Namespace key for cross-session memory |
| `--subprocess` | `false` | Run agent in an isolated child process (JSON-RPC 2.0 transport) |
| `--profile <name>` | — | Apply a named task profile |
| `--verbose` | `false` | Verbose logging |
| `--dangerously-skip-permissions` | `false` | Bypass all tool approval prompts |
| `--timeout-sec <n>` | — | Hard wall-clock timeout for the entire run |
| `--summarize-at <0–1>` | off | Summarize when prompt tokens exceed this fraction of context window |
| `--summarize-model <id>` | same as `--model` | Model used for session summarization |
| `--add-dir <path>` | — | Additional directory to load skills from |
| `--plan-mode` | `false` | Start in read-only exploration mode |

---

## Model support

orager routes through [OpenRouter](https://openrouter.ai) (300+ models, one API key). Set `ANTHROPIC_API_KEY` to call Anthropic directly — lower latency, no markup.

| Provider | Example models | Tool use | Vision | Notes |
|---|---|---|---|---|
| **Anthropic** | `anthropic/claude-sonnet-4-6`, `anthropic/claude-opus-4-6` | ✅ | ✅ | Direct fast-path available; prompt caching; frozen-prefix cache hits |
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
orager run "remember set_master with content: 'Stack: Next.js 15, Postgres 16, Bun runtime. All API routes live in src/app/api/. Tests use Bun test runner. Never use console.log in production code.'"

# View the current master context
orager run "remember view_master"
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

### Multi-context memory

An agent can read from multiple memory namespaces simultaneously. The first key is the write target; additional keys are read-only sources.

```ts
await runAgentLoop({
  memoryKey: ["project-alpha", "shared-conventions"],
  // ...
});
```

### Disabling memory

```bash
ORAGER_DB_PATH=none orager run "..."
```

Falls back to JSON session files. No cross-session memory, but all other features work normally.

---

## Session management

```bash
# List recent sessions
orager --list-sessions

# Search sessions by content
orager --search-sessions "auth refactor"

# Resume a session
orager chat --session-id <id>

# Force-resume from a different directory
orager run --session-id <id> --force-resume "continue where we left off"

# Trash a session (soft delete, recoverable)
orager --trash-session <id>

# Restore a trashed session
orager --restore-session <id>

# Permanently delete trashed sessions
orager --delete-trashed

# Prune sessions older than 30 days
orager --prune-sessions --older-than 30d
```

Sessions are stored in `~/.orager/orager.db` (SQLite, concurrent-safe via advisory locking). Set `ORAGER_DB_PATH=none` to use the legacy JSON file store.

---

## Multi-agent workflows

Use `runAgentWorkflow` to compose sequential multi-agent pipelines as a library.

```ts
import { runAgentWorkflow } from "@jaycodesx/orager";
import type { AgentWorkflow } from "@jaycodesx/orager";

const workflow: AgentWorkflow = {
  base: {
    apiKey: process.env.PROTOCOL_API_KEY!,
    cwd: process.cwd(),
    addDirs: [],
    sessionId: null,
    dangerouslySkipPermissions: false,
    verbose: false,
    onEmit: (event) => { /* stream events to your UI */ },
  },
  steps: [
    {
      role: "researcher",
      model: "deepseek/deepseek-r1",
      maxTurns: 5,
    },
    {
      role: "synthesizer",
      model: "anthropic/claude-sonnet-4-6",
      maxTurns: 3,
      appendSystemPrompt: "Be concise. Output bullet points only.",
    },
  ],
  // Optional: transform output between steps
  handoff: (stepIndex, output) => `Step ${stepIndex} result:\n${output}\n\nNow synthesize.`,
};

await runAgentWorkflow(workflow, "Analyse the auth module and suggest improvements");
```

Each step's text output is automatically passed as the next step's prompt (default pass-through). Use `handoff` to transform or augment it.

---

## Architecture

| File | Responsibility |
|---|---|
| `src/loop.ts` | Main agent loop — prompt assembly, turn execution, summarization, memory ingestion |
| `src/loop-helpers.ts` | Pure utilities — token estimation, summarization, `parseMemoryUpdates`, cache helpers |
| `src/workflow.ts` | Sequential multi-agent orchestration (`runAgentWorkflow`) |
| `src/subprocess.ts` | JSON-RPC 2.0 subprocess transport — orchestrator + server sides |
| `src/openrouter.ts` | API client — SSE streaming, Anthropic cache control, direct fast-path |
| `src/session.ts` | Session store abstraction — load/save/lock/prune |
| `src/session-sqlite.ts` | SQLite session store — WAL, FTS5 search, advisory locking, checkpoints |
| `src/memory-sqlite.ts` | Memory entry store — master context, FTS5 retrieval, embedding support |
| `src/memory.ts` | File-based memory store (fallback) and shared retrieval logic |
| `src/daemon/` | Status/metrics/sessions HTTP server (health, metrics, sessions, rotate-key) |
| `src/ui-server.ts` | Browser UI server (`orager serve`) — config, settings, logs, costs |
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
