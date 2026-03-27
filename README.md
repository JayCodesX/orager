# orager

A production-grade agentic CLI and daemon that runs multi-turn, tool-calling AI agent loops — built as the engine behind [Paperclip](https://paperclipai.com)'s OpenRouter adapter.

---

## Why we built this

Paperclip agents need a runtime that can: receive a task, call an LLM repeatedly, execute tools against a real filesystem and the web, manage conversation history across long sessions, and stream structured events back to the platform — all without breaking the bank.

The existing options were either too opinionated (Claude Code, which only speaks Anthropic), too bare-bones (raw LLM SDKs with no tool loop), or too slow (spinning up a new process for every single heartbeat).

**orager was built to solve three specific problems:**

1. **Model lock-in** — agents should run on any model (DeepSeek, GPT-4o, Gemini, Llama, Claude) without code changes. OpenRouter provides a unified API; orager speaks it fluently and adds a direct Anthropic fast-path when an `ANTHROPIC_API_KEY` is present.

2. **Per-heartbeat startup cost** — a new Node.js process takes 50–200ms before it even starts thinking. For Paperclip agents that fire every 30 seconds, this is pure waste. The daemon mode keeps orager alive between runs, keeping all caches (LLM prompt cache, skill cache, tool result cache) warm.

3. **Context management at scale** — agent sessions grow. Without summarization, a session that runs for hours will exceed any model's context window and fail. orager tracks token usage against the live model context size (fetched from OpenRouter's `/models` endpoint) and automatically summarizes when needed.

---

## Architecture

```
stdin / daemon /run request
        │
        ▼
  loop.ts  — agent loop
  ┌────────────────────────────────────────────────────────────────────┐
  │  1. Load skills from --add-dir paths (mtime-fingerprinted cache)   │
  │  2. Build system prompt (base + skills + appendSystemPrompt)       │
  │  3. Apply Anthropic cache breakpoints (system / tools / history)   │
  │  4. Set X-Session-Id header for OpenRouter sticky routing          │
  │                                                                    │
  │  TURN LOOP (up to --max-turns)                                     │
  │  ┌──────────────────────────────────────────────────────────┐      │
  │  │  callOpenRouter / callDirect (openrouter.ts)             │      │
  │  │    → streams SSE, parses tool calls + text + reasoning   │      │
  │  │    → accumulates usage (prompt / completion / cached)    │      │
  │  │                                                          │      │
  │  │  executeOne × N (parallel, up to 10 concurrent)         │      │
  │  │    → check tool result cache (read-only, 30s TTL)        │      │
  │  │    → run approval flow if required                       │      │
  │  │    → execute tool, emit result                           │      │
  │  │    → update metrics & file-change tracker               │      │
  │  │                                                          │      │
  │  │  after each turn:                                        │      │
  │  │    → fetchGenerationMeta (cost tracking from OpenRouter) │      │
  │  │    → check cost cap (maxCostUsd)                         │      │
  │  │    → check context threshold (summarizeAt)               │      │
  │  │    → save session to ~/.orager/sessions/<id>.json        │      │
  │  └──────────────────────────────────────────────────────────┘      │
  │                                                                    │
  │  emit stream-json events → stdout / NDJSON response               │
  └────────────────────────────────────────────────────────────────────┘
        │
        ▼
  {"type":"result","subtype":"success","result":"...","usage":{...}}
```

### Direct Anthropic fast-path

When `ANTHROPIC_API_KEY` is set and the model starts with `anthropic/`, orager bypasses OpenRouter entirely and calls `https://api.anthropic.com/v1/chat/completions` directly. The OpenRouter model metadata fetch is skipped; the static fallback map (200k for all Claude 3+ models) is used instead.

### Daemon mode

```
orager --serve --port 3456
        │
        ▼
  daemon.ts  HTTP server on 127.0.0.1
  ┌────────────────────────────────────────┐
  │  POST /run   → runAgentLoop()          │
  │  GET  /health                          │
  │  GET  /metrics                         │
  │  GET  /sessions                        │
  │  GET  /sessions/:id                    │
  │  GET  /sessions/search?q=              │
  │  POST /drain                           │
  │  All routes: HS256 JWT required        │
  └────────────────────────────────────────┘
        ↑
  adapter reads ~/.orager/daemon.key
  mints JWT { agentId, scope:"run", exp: now+5min }
  sends Authorization: Bearer <jwt>
```

---

## Install

```bash
npm install -g @paperclipai/orager
export OPENROUTER_API_KEY=sk-or-...
```

For the direct Anthropic path:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
# Use any anthropic/* model — no OpenRouter key needed
orager --print - --model anthropic/claude-sonnet-4-6 <<< "Your task"
```

---

## Usage

```bash
echo "Refactor the auth module to use async/await" | orager \
  --print - \
  --output-format stream-json \
  --model deepseek/deepseek-chat-v3-0324 \
  --max-turns 20
```

```bash
orager --print - --output-format stream-json --model openai/gpt-4o <<< "Fix the failing tests"
```

---

## Built-in tools

Every tool was written to give the agent the same capabilities a developer has at a terminal. The design principle is: **one tool per clear action, no ambiguity about what it does or what it touches.**

### File system

| Tool | Why it exists |
|---|---|
| `read_file` | Reads any file with optional line-range slicing. Separate from `bash` so the agent doesn't need shell quoting and the platform can audit file reads independently of command execution. |
| `write_file` | Creates or fully overwrites a file. Used when generating new files from scratch. |
| `str_replace` | Targeted in-place string replacement — finds an exact string and replaces it. Safer than rewriting an entire file; fails explicitly if the target string isn't found or isn't unique. |
| `edit_file` | Batch version of `str_replace` — applies multiple `{ old_string, new_string }` pairs to a single file in one call, reducing round-trips on complex edits. Respects `--sandbox-root`. |
| `edit_files` | Multi-file batch editor — applies edits across several files in a single tool call. Built for large refactors where a single concept spans many files. All edits are validated before any file is written; if a write fails mid-way, already-written files are rolled back to their original content. Respects `--sandbox-root`. |
| `list_dir` | Recursive directory listing that automatically skips `node_modules`, `.git`, `dist`, and other noise directories. Gives the agent a clean map of a project without overwhelming it with irrelevant paths. |
| `glob` | Pattern-based file finder (`**/*.ts`, `src/**/*.test.js`). Faster and more precise than `list_dir` when the agent knows the shape of what it's looking for. |
| `delete_file` | Deletes a single file. Explicit tool rather than `bash rm` so deletions are auditable and sandboxed by `--sandbox-root`. |
| `move_file` | Renames or moves a file or directory. Handles both same-directory renames and cross-directory moves. |
| `create_dir` | Creates a directory (and all missing parents). Exists separately from `bash mkdir` so it respects sandbox boundaries and shows up in the audit log. |

### Search & navigation

| Tool | Why it exists |
|---|---|
| `grep` | Regex search across files — returns matching lines with file path, line number, and surrounding context. Backed by ripgrep semantics. Supports context lines, file glob filtering, and case-insensitive mode. The agent's primary tool for navigating large codebases without reading every file. |

### Shell

| Tool | Why it exists |
|---|---|
| `bash` | Runs arbitrary shell commands with a configurable timeout, SIGTERM → SIGKILL escalation, and a command blocklist (`blockedCommands` in bashPolicy). The most powerful tool and the most audited — every invocation goes through the approval flow if configured. Supports process group kill to clean up subprocesses. Git operations are done through `bash` directly. |

### Web

| Tool | Why it exists |
|---|---|
| `web_fetch` | Makes HTTP requests (GET, POST, PUT, PATCH, DELETE) and returns response text. Converts HTML to readable plain text automatically. Includes SSRF protection (blocks private IP ranges, validates every redirect hop). The agent's window to the outside web for reading docs, calling APIs, and posting webhooks. |
| `web_search` | DuckDuckGo instant-answer search. Returns a list of `{ title, url, description }` results without requiring an API key. Lets the agent find URLs to then fetch with `web_fetch` — combining them gives full research capability. |

### Browser (Playwright)

The browser tools give the agent a real Chromium instance for tasks that can't be done with raw HTTP — JavaScript-heavy SPAs, login flows, visual inspection.

| Tool | Why it exists |
|---|---|
| `browser_navigate` | Opens a URL in a named browser session. Sessions are keyed so the agent can maintain multiple browser windows across tool calls. |
| `browser_screenshot` | Takes a screenshot and returns it as a base64 PNG or JPEG. Capped at 3MB with automatic quality reduction fallback. The agent's eyes — used to verify visual output, debug layout bugs, and confirm form submissions. |
| `browser_click` | Clicks an element by CSS selector or absolute pixel coordinate. The primary action tool for navigating UI flows. |
| `browser_type` | Types text into an input field. Used for form filling, search queries, and CLI-style web apps. |
| `browser_key` | Sends keyboard events (Enter, Tab, Escape, arrow keys, etc.). Handles interactions that don't map to click+type. |
| `browser_scroll` | Scrolls the page by a pixel amount or to a CSS selector. Needed for infinite-scroll pages, sticky headers, and lazy-loaded content. |
| `browser_execute` | Executes arbitrary JavaScript in the page context. The escape hatch for interactions no other browser tool supports. |
| `browser_close` | Explicitly closes a named browser session to free memory. Sessions also close automatically on SIGTERM with a 5-second forced-exit timeout to prevent hangs if Playwright's `close()` stalls. |

### Notebooks

| Tool | Why it exists |
|---|---|
| `notebook_read` | Reads a Jupyter `.ipynb` file and returns its cells as formatted text (code + outputs + markdown). Agents working on data science or ML projects need to read notebooks without a Jupyter server. |
| `notebook_edit` | Applies structured edits to notebook cells — replace source, change cell type, insert or delete cells. Keeps the JSON structure valid so the notebook remains openable in Jupyter. |

### Agent control

| Tool | Why it exists |
|---|---|
| `finish` | The agent calls this to explicitly signal task completion when `--use-finish-tool` is set. Prevents the loop from running unnecessary turns after the task is done. |
| `exit_plan_mode` | Used in plan mode — the agent calls this to transition from planning to execution. Keeps planning and doing as separate named phases. |
| `todo_write` | Writes a structured task list (pending / in_progress / completed). Gives the agent persistent working memory for multi-step tasks within a session. |
| `todo_read` | Reads the current task list back. Used to check progress, pick the next task, and mark items complete. |

---

## Profiles

Profiles are opinionated presets that wire together system prompt, max turns, summarization threshold, tool output tagging, and loop-detection settings for common task types. Apply with `--profile <name>`.

| Profile | Max turns | What it's optimized for |
|---|---|---|
| `code-review` | 20 | Read-only analysis — tools tagged, output trimmed, no file writes |
| `bug-fix` | 30 | Iterative debugging — file change tracking, tagged outputs, summarizes at 70% context |
| `research` | 25 | Web research — web_fetch + web_search focus, tagged tool outputs |
| `refactor` | 50 | Large structural changes — full file change tracking, summarizes at 65% context |
| `test-writer` | 30 | Test generation — file tracking, runs test commands after writes |
| `devops` | 40 | Infrastructure and CI tasks — conservative bash policy, tagged outputs, summarizes at 70% |

Custom profiles can be defined in `~/.orager/profiles/` as JSON or YAML files with optional `extends` inheritance from built-in profiles.

---

## CLI flags

### Core

| Flag | Description |
|---|---|
| `--print -` | Read prompt from stdin |
| `--output-format stream-json` | Emit stream-json events on stdout (required for Paperclip) |
| `--model <id>` | OpenRouter model ID (default: `deepseek/deepseek-chat-v3-0324`) |
| `--model-fallback <id>` | Fallback model tried in order on 429/503, repeatable |
| `--max-turns <n>` | Maximum agent turns (default: `20`, `0` = unlimited) |
| `--resume <session-id>` | Resume a previous session from `~/.orager/sessions/` |
| `--force-resume` | Resume even if the session was from a different cwd |
| `--max-retries <n>` | API retries on transient errors (default: `3`) |
| `--verbose` | Log extra debug info to stderr |
| `--config-file <path>` | Load all options from a JSON file (file is deleted immediately after read) |
| `--profile <name>` | Apply a built-in or custom profile preset |
| `--timeout-sec <n>` | Total run timeout in seconds (`0` = unlimited). Composed with any caller-supplied `abortSignal` via `AbortSignal.any()`. |
| `--require-env <VARS>` | Comma-separated env var names that must be set. Run fails immediately with a clear error if any are missing. |

### Tools & permissions

| Flag | Description |
|---|---|
| `--dangerously-skip-permissions` | Skip all tool approval prompts |
| `--use-finish-tool` | Model calls a `finish` tool to signal completion |
| `--require-approval` | Require human approval before any tool runs |
| `--require-approval-for <tools>` | Comma-separated tools that require approval |
| `--tools-file <path>` | JSON file defining extra tools (repeatable) |
| `--add-dir <path>` | Skills directory to load (repeatable; skills are disk-cached by mtime) |
| `--sandbox-root <path>` | Restrict file operations to this directory |
| `--system-prompt-file <path>` | Append file contents to the system prompt |

### Cost controls

| Flag | Description |
|---|---|
| `--max-cost-usd <n>` | Stop if accumulated cost exceeds this amount |
| `--cost-per-input-token <n>` | Input token cost override for tracking |
| `--cost-per-output-token <n>` | Output token cost override for tracking |

### Sampling

| Flag | Description |
|---|---|
| `--temperature <n>` | Sampling temperature (0.0–2.0) |
| `--top-p <n>` | Nucleus sampling threshold (0.0–1.0) |
| `--top-k <n>` | Token selection pool size |
| `--seed <n>` | Seed for reproducible outputs |
| `--stop <seq>` | Stop sequence, repeatable |
| `--repetition-penalty <n>` | OpenRouter repetition penalty (0.0–2.0) |
| `--min-p <n>` | Minimum probability relative to top token |
| `--frequency-penalty <n>` | Frequency-based token penalty |
| `--presence-penalty <n>` | Presence-based token penalty |

### Reasoning (extended thinking)

| Flag | Description |
|---|---|
| `--reasoning-effort <level>` | `xhigh` / `high` / `medium` / `low` / `minimal` / `none` |
| `--reasoning-max-tokens <n>` | Exact reasoning token budget |
| `--reasoning-exclude` | Run reasoning internally but omit from response |

> Reasoning is excluded by default. Enable with `--reasoning-effort medium` or set `reasoning.exclude: false` in config.

### Provider routing

| Flag | Description |
|---|---|
| `--provider-order <slugs>` | Comma-separated preferred provider slugs |
| `--provider-only <slugs>` | Provider allowlist |
| `--provider-ignore <slugs>` | Provider blocklist |
| `--require-parameters` | Only route to providers that support all requested parameters |
| `--data-collection deny` | Exclude providers that train on your data |
| `--zdr` | Restrict to Zero Data Retention providers |
| `--sort price\|throughput\|latency` | Provider selection strategy (default: `latency`) |
| `--quantizations <list>` | Filter by quantization (e.g. `fp16,bf16`) |
| `--transforms <list>` | Comma-separated transforms (e.g. `middle-out`) |
| `--preset <slug>` | OpenRouter named preset |

### Context management

| Flag | Description |
|---|---|
| `--summarize-at <fraction>` | Trigger summarization at this fraction of context window (e.g. `0.8`) |
| `--summarize-model <id>` | Model to use for summarization (defaults to main model) |

### Parallel execution

| Flag | Description |
|---|---|
| `--parallel-tool-calls` | Execute multiple tool calls concurrently (default: on) |
| `--no-parallel-tool-calls` | Execute tool calls sequentially |

### Attribution

| Flag | Description |
|---|---|
| `--site-url <url>` | HTTP-Referer header for OpenRouter attribution |
| `--site-name <name>` | X-Title header for OpenRouter attribution |

---

## Daemon mode

Run orager as a persistent HTTP server to eliminate Node.js startup overhead and keep all caches warm between runs.

```bash
OPENROUTER_API_KEY=sk-or-... orager --serve --port 3456
```

### Daemon flags

| Flag | Default | Description |
|---|---|---|
| `--serve` | — | Start in daemon mode |
| `--port <n>` | `3456` | TCP port (always binds to 127.0.0.1) |
| `--max-concurrent <n>` | `3` | Max simultaneous agent runs (returns 503 if exceeded) |
| `--idle-timeout <n>m\|h` | `30m` | Auto-exit after this period of inactivity |

### Security model

- Binds exclusively to `127.0.0.1` — never `0.0.0.0`
- Every request requires a **short-lived HS256 JWT** (5-min TTL) signed with the key at `~/.orager/daemon.key` (chmod 600, auto-generated on first start)
- PID lock file (`~/.orager/daemon.pid`) uses atomic `O_EXCL` creation to prevent duplicate daemon processes
- Max concurrent runs enforced at server level
- Audit log written to `~/.orager/audit.log` (mode 0600): every tool approval decision is recorded with timestamp, session ID, tool name, and decision — prompt content is never logged
- `promptContent` structurally validated — only `text` and `image_url` content types accepted
- Dangerous run options (`sandboxRoot`, `requireApproval`, `bashPolicy`, `dangerouslySkipPermissions`) are stripped from daemon requests and controlled server-side only

### JWT token flow

```
adapter reads ~/.orager/daemon.key
adapter mints JWT { agentId, scope: "run", exp: now+5min }
adapter sends: Authorization: Bearer <jwt>
daemon verifies signature + expiry (constant-time HMAC compare)
daemon logs: { ts, sessionId, toolName, decision, mode, durationMs }
```

### Cache warming

- **Startup warm-up:** On daemon start, sends a 1-token no-op to pre-warm the LLM prompt cache
- **Keep-alive ping:** Lightweight 1-token ping every 4 minutes maintains Anthropic's 5-minute cache TTL between heartbeats

### Daemon API

| Endpoint | Description |
|---|---|
| `POST /run` | Start an agent run (NDJSON streaming response) |
| `GET /health` | Liveness check — returns `{ ok: true }` |
| `GET /metrics` | Active runs, completed count, uptime, model list |
| `GET /sessions` | Paginated session list (sorted by most-recent) |
| `GET /sessions/:id` | Single session summary |
| `GET /sessions/search?q=` | Full-text session search |
| `POST /drain` | Reject new runs, wait for active runs to finish |

---

## Performance

### Prompt caching (Anthropic models)

For `anthropic/*` models, orager injects `cache_control: { type: "ephemeral" }` breakpoints at three positions:

1. **System prompt** — the largest stable block
2. **Last tool definition** — tool list rarely changes mid-session
3. **Last prior-turn message** — marks the end of stable history

`X-Session-Id` is sent on every request for OpenRouter sticky routing (same session → same provider endpoint → maximum cache hits).

### Skills caching

Skills loaded via `--add-dir` are cached in memory, keyed by a fingerprint of all `SKILL.md` file modification times. Cache auto-invalidates when any file changes. Max TTL: 5 minutes.

### Tool result caching

Read-only tool calls are cached for 30 seconds per unique argument set. Write operations clear the entire cache. Never persisted to disk.

### Session summarization

When `--summarize-at` is set and token usage crosses the threshold:
- Only assistant messages (text + tool call names) are included in the summary — tool results and the system prompt are **never sent** to the summarization model
- The fixed prompt prefix prevents prompt injection via summarization
- History is replaced with: `[system prompt, { role: "user", content: "[Session summary]\n<summary>" }]`

### Loop detection & abort

If the agent calls the same tool(s) with identical arguments for `maxIdenticalToolCallTurns` consecutive turns, orager injects an escalating warning message. After 3 injected warnings with no change in behaviour, the run terminates with a `loop_abort` event — preventing runaway token spend.

### Model fallback rotation

On 429 or 503, orager first tries the next API key in the pool (if `apiKeys` contains more than one entry) before escalating to the next model in the `--model-fallback` chain. Key rotation happens mid-run — on the first rate-limit hit per model, the next key is tried immediately rather than failing the whole run. Each model gets one key-rotation attempt before the model itself is rotated. Once all fallback models are exhausted, the last error is returned.

---

## Session management

Sessions are saved to `~/.orager/sessions/<session-id>.json`.

```bash
orager --list-sessions
orager --trash-session <id>
orager --restore-session <id>
orager --delete-session <id>
orager --delete-trashed
orager --rollback-session <id> --to-turn 3
orager --prune-sessions --older-than 30d
```

---

## Config file

Pass all options as JSON instead of CLI args. The file is **read once and immediately deleted** before any API calls.

```json
{
  "model": "deepseek/deepseek-chat-v3-0324",
  "maxTurns": 20,
  "addDirs": ["/path/to/skills"],
  "parallel_tool_calls": true,
  "reasoningExclude": true,
  "summarizeAt": 0.8,
  "timeoutSec": 300,
  "apiKeys": ["sk-or-key1", "sk-or-key2"],
  "requiredEnvVars": ["GITHUB_TOKEN", "LINEAR_API_KEY"],
  "turnModelRules": [
    { "afterTurn": 5, "model": "anthropic/claude-sonnet-4-6" }
  ]
}
```

---

## Output format

```json
{"type":"system","subtype":"init","model":"deepseek/...","session_id":"abc-123"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I'll start by..."}]}}
{"type":"tool","content":[{"type":"tool_result","tool_use_id":"call-1","content":"output\n","is_error":false}]}
{"type":"warn","message":"[orager daemon] WARNING: ignoring disallowed opts fields from caller: sandboxRoot","dropped_opts":["sandboxRoot"]}
{"type":"result","subtype":"success","result":"Done.","session_id":"abc-123","finish_reason":"stop","usage":{"input_tokens":1200,"output_tokens":340,"cache_read_input_tokens":800},"total_cost_usd":0.00004}
```

`subtype`: `success` | `error_max_turns` | `error_max_cost` | `interrupted` | `error`

The `warn` event is emitted at the start of a daemon run when the caller passes opts fields not on the `ALLOWED_DAEMON_OPTS` allowlist. The dropped field names are listed in `dropped_opts`. The same warning is written to daemon stderr and the structured log.

---

## Source layout

```
src/
├── index.ts               CLI entry — arg parsing, session subcommands, main()
├── loop.ts                Agent loop — turns, tool execution, cost tracking, summarization
├── loop-helpers.ts        Token estimation, context window lookup, session summarization, concurrency, defaultTimeoutForModel
├── openrouter.ts          OpenRouter + direct Anthropic streaming API — SSE parsing, cache breakpoints
├── openrouter-model-meta.ts  Live model metadata (pricing, capabilities) from /api/v1/models
├── retry.ts               Retry + API key pool rotation + model fallback rotation on 429/503
├── session.ts             Session persistence (JSON) — queue-serialized writes, lock file, pruning
├── approval.ts            Interactive TTY approval prompt — control-char sanitized display
├── hooks.ts               Pre/post tool call hooks — user-defined shell commands
├── daemon.ts              HTTP daemon server — JWT auth, concurrency, drain, keep-alive
├── jwt.ts                 HS256 JWT mint/verify (Node.js built-in crypto)
├── circuit-breaker.ts     OpenRouter circuit breaker — OPEN/HALF_OPEN/CLOSED state machine
├── rate-limit-tracker.ts  Per-model rate limit header tracking
├── mcp-client.ts          MCP server client — connect, list tools, call tools with timeout + size cap
├── profiles.ts            Built-in and custom agent profiles
├── profile-loader.ts      Custom profile loader from ~/.orager/profiles/ (JSON/YAML)
├── settings.ts            ~/.orager/settings.json loader — permissions, bashPolicy, hooks
├── audit.ts               Append-only NDJSON audit log (mode 0600, 10MB rotation)
├── model-capabilities.ts  Static model capability map (tool support, vision, reasoning)
├── deprecated-models.ts   Deprecated model registry with migration hints
├── telemetry.ts           OpenTelemetry trace/span integration
├── logger.ts              Structured JSON logger
└── tools/
    ├── index.ts           Tool registry (ALL_TOOLS + BROWSER_TOOLS)
    ├── bash.ts            bash — shell execution with blocklist + timeout (git via bash)
    ├── read-file.ts       read_file — file reading with line ranges
    ├── write-file.ts      write_file + str_replace
    ├── edit.ts            edit_file — batch replacements on one file
    ├── edit-files.ts      edit_files — batch replacements across multiple files
    ├── list-dir.ts        list_dir — recursive directory listing
    ├── glob.ts            glob — pattern-based file finding
    ├── grep.ts            grep — regex content search with context, glob filter, case-insensitive
    ├── web-fetch.ts       web_fetch — HTTP with SSRF protection + redirect validation
    ├── web-search.ts      web_search — DuckDuckGo search (no API key required)
    ├── file-ops.ts        delete_file + move_file + create_dir
    ├── browser.ts         browser_navigate/screenshot/click/type/key/scroll/execute/close
    ├── notebook.ts        notebook_read + notebook_edit
    ├── todo.ts            todo_write + todo_read
    ├── plan.ts            exit_plan_mode
    ├── finish.ts          finish — explicit completion signal
    └── aliases.ts         Claude-compatible tool name aliases
```

---

## Popular model IDs

| Model | ID |
|---|---|
| DeepSeek V3 | `deepseek/deepseek-chat-v3-0324` |
| DeepSeek R1 | `deepseek/deepseek-r1` |
| Claude Sonnet 4.6 | `anthropic/claude-sonnet-4-6` |
| Claude Opus 4.6 | `anthropic/claude-opus-4-6` |
| Claude Haiku 4.5 | `anthropic/claude-haiku-4-5` |
| GPT-4o | `openai/gpt-4o` |
| OpenAI o3 | `openai/o3` |
| Gemini 2.5 Pro | `google/gemini-2.5-pro` |
| Gemini 2.5 Flash | `google/gemini-2.5-flash` |
| Llama 3.3 70B | `meta-llama/llama-3.3-70b-instruct` |

Append `:free`, `:nitro`, `:floor`, `:online`, `:thinking`, or `:extended` to any model ID. Full catalogue at [openrouter.ai/models](https://openrouter.ai/models).

---

## Development

```bash
npm install
npm run build       # tsc → dist/
npm run typecheck   # tsc --noEmit
npm run test        # vitest run
npm run dev         # tsx src/index.ts (no build needed)
```
