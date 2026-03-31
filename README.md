# orager

A production-grade agent engine that runs multi-turn, tool-calling AI loops against any LLM provider — built as the runtime behind [Paperclip](https://paperclipai.com) agents.

## Problem

Running AI agents in production requires:
- Calling an LLM repeatedly, executing tools, and managing context across long sessions
- Working with any model (Claude, GPT-4o, DeepSeek, Gemini, Llama) without code changes
- Keeping startup costs low when agents fire every 30 seconds
- Preventing runaway token spend and context window overflow

Existing options are either locked to one provider, too bare-bones for production use, or too slow for high-frequency agent heartbeats.

## Solution

orager is a CLI and HTTP daemon that runs a complete agent loop — prompt assembly, LLM calls, tool execution, cost tracking, session persistence, and context summarization — with:

- **Any model via OpenRouter** — one API key, 300+ models. Direct Anthropic fast-path when `ANTHROPIC_API_KEY` is set.
- **Daemon mode** — persistent HTTP server eliminates ~200ms Node.js startup overhead per run. Skill caches, tool result caches, and LLM prompt caches stay warm.
- **Automatic context management** — tracks token usage against live model context sizes and summarizes when needed. Loop detection prevents runaway turns.
- **Production security** — JWT-authenticated daemon, audit logging with rotation, OS sandboxing, secret redaction in output, per-agent cost budgets.

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
                          │  Routes:             │
                          │  POST /run           │
                          │  GET  /health        │
                          │  GET  /health/detail │
                          │  GET  /metrics       │
                          │  GET  /metrics/prom  │
                          │  POST /drain         │
                          │  POST /runs/:id/     │
                          │       cancel         │
                          └──────────┬──────────┘
                                     │
                                     ▼
┌──────────────────────────────────────────────────────────────────────┐
│                          loop.ts — Agent Loop                        │
│                                                                      │
│  1. Load skills from --add-dir (mtime-fingerprinted cache)           │
│  2. Build system prompt (base + skills + instructions)               │
│  3. Apply Anthropic cache breakpoints (system / tools / history)     │
│  4. Set X-Session-Id for OpenRouter sticky routing                   │
│                                                                      │
│  ┌────────────────────── Turn Loop ──────────────────────┐           │
│  │                                                        │           │
│  │  openrouter.ts ─── call LLM (SSE stream) ──┐          │           │
│  │                                              │          │           │
│  │  Parse text + tool calls + reasoning         │          │           │
│  │                                              ▼          │           │
│  │  tools/* ─── execute tools (up to 10 concurrent)       │           │
│  │    bash, read_file, write_file, grep, glob,            │           │
│  │    web_fetch, web_search, browser_*, notebook_*        │           │
│  │                                              │          │           │
│  │  Post-turn checks:                           │          │           │
│  │    • Cost cap (--max-cost-usd)               │          │           │
│  │    • Context threshold (auto-summarize)       │          │           │
│  │    • Loop detection (identical tool calls)    │          │           │
│  │    • Session save to disk / SQLite            │          │           │
│  └────────────────────────────────────────────────┘           │
│                                                              │
│  Emit NDJSON stream events → stdout or HTTP response         │
└──────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
              {"type":"result","subtype":"success","usage":{...}}
```

## Features

### Agent loop (`loop.ts`)
Multi-turn execution engine. Calls the LLM, parses tool calls, executes them in parallel (up to 10 concurrent), tracks cost and token usage, and saves session state after every turn. Supports model fallback rotation on 429/503 and API key pool rotation mid-run.

### Tool system (`tools/`)
27 built-in tools organized by category:

| Category | Tools |
|---|---|
| **File system** | `read_file`, `write_file`, `str_replace`, `edit_file`, `edit_files`, `list_dir`, `glob`, `delete_file`, `move_file`, `create_dir` |
| **Search** | `grep` — regex search with context lines, glob filter, case-insensitive mode |
| **Shell** | `bash` — command execution with timeout, blocklist, OS sandbox (macOS sandbox-exec, Linux bwrap) |
| **Web** | `web_fetch` (HTTP with SSRF protection), `web_search` (DuckDuckGo) |
| **Browser** | `browser_navigate`, `browser_screenshot`, `browser_click`, `browser_type`, `browser_key`, `browser_scroll`, `browser_execute`, `browser_close` |
| **Notebooks** | `notebook_read`, `notebook_edit` |
| **Control** | `finish`, `exit_plan_mode`, `todo_write`, `todo_read` |

### Daemon mode (`daemon.ts`)
Persistent HTTP server that eliminates per-run startup cost. JWT-authenticated (HS256, 5-min TTL). Supports TLS via `ORAGER_TLS_CERT`/`ORAGER_TLS_KEY` env vars. Features:
- Concurrency control (`--max-concurrent`)
- Graceful drain with warning period before abort
- Idle auto-shutdown
- Cache warming on startup + keep-alive pings every 4 minutes
- Per-agent cost tracking with budget enforcement (returns 402 when exceeded)

### Context management (`loop-helpers.ts`)
Automatic session summarization when token usage crosses a configurable threshold. Only assistant messages are summarized — tool results and system prompts are never sent to the summarization model. History is replaced with a compact summary to stay within the context window.

### Session persistence (`session.ts`, `session-sqlite.ts`)
Sessions saved to `~/.orager/sessions/` as JSON or SQLite. Supports resume, rollback to a specific turn, trash/restore, and time-based pruning. Queue-serialized writes with lock files prevent corruption.

### Security
- **JWT auth** — daemon key at `~/.orager/daemon.key` (chmod 600, auto-generated). Dual-key rotation for zero-downtime key changes.
- **Audit log** — append-only NDJSON at `~/.orager/audit.log` (mode 0600). Automatic rotation at 10MB, max 3 rotated files.
- **OS sandbox** — enabled by default. macOS sandbox-exec, Linux bwrap.
- **Secret redaction** — regex-based pattern matching strips API keys, tokens, and passwords from streamed output.
- **Request validation** — schema validation at API boundary. Dangerous opts stripped from daemon requests.
- **Rate limiting** — per-model rate limit tracking from response headers.

### Prompt caching (Anthropic models)
Cache breakpoints injected at system prompt, last tool definition, and last prior-turn message. `X-Session-Id` enables OpenRouter sticky routing for maximum cache hits.

### Profiles (`profiles.ts`)
Opinionated presets for common task types: `code-review`, `bug-fix`, `research`, `refactor`, `test-writer`, `devops`. Custom profiles supported via `~/.orager/profiles/`.

### MCP client (`mcp-client.ts`)
Connects to external MCP servers (Streamable HTTP transport). Handles reconnection with transport cleanup on failure.

### Observability
- **JSON metrics endpoint** — active runs, completed/error counts, uptime, model usage, provider health, circuit breaker states, per-agent costs
- **Prometheus endpoint** — `/metrics/prometheus` in exposition format
- **Health checks** — minimal `/health` (public) + detailed `/health/detail` (authenticated, subsystem checks)
- **Circuit breaker** — per-provider OPEN/HALF_OPEN/CLOSED state machine
- **OpenTelemetry** — trace/span integration via `telemetry.ts`

## Install

```bash
npm install -g @paperclipai/orager
export PROTOCOL_API_KEY=sk-or-...
```

## Quick start

```bash
# CLI mode
echo "Refactor the auth module" | orager --print - --model deepseek/deepseek-chat-v3-0324

# Daemon mode
orager --serve --port 3456
```

## Development

```bash
npm install
npm run build       # tsc → dist/
npm run typecheck   # tsc --noEmit
bun run test:bun    # unit tests (fast)
```
