# orager

An agentic CLI that runs a multi-turn tool-calling loop backed by [OpenRouter](https://openrouter.ai) — works with any model available on the platform.

## Install

```bash
npm install -g @paperclipai/orager
export OPENROUTER_API_KEY=sk-or-...
```

## Usage

```bash
echo "Refactor the auth module to use async/await" | orager \
  --print - \
  --output-format stream-json \
  --model deepseek/deepseek-chat-v3-0324 \
  --max-turns 20
```

Or via heredoc:

```bash
orager --print - --output-format stream-json --model openai/gpt-4o <<< "Fix the failing tests"
```

---

## How it works

```
stdin (prompt)
    │
    ▼
Agent loop (loop.ts)
    │  loads skills from --add-dir paths (cached by mtime fingerprint)
    │  builds system prompt + tool list
    │  applies Anthropic cache breakpoints (anthropic/* models)
    │  sets X-Session-Id for sticky OpenRouter routing
    ▼
callOpenRouter (openrouter.ts)   ← streams SSE from OpenRouter
    │  accumulates text + reasoning + tool calls
    │  reports usage (prompt/completion/cached tokens)
    ▼
executeOne (parallel, up to 10 concurrent)
    │  checks tool result cache (read-only tools, 30s TTL)
    │  runs approval flow if --require-approval is set
    │  executes tool, updates cache
    ▼
messages.push(toolResults)
    │  if context > summarizeAt threshold → summarizeSession()
    │  if cost > maxCostUsd → stop
    ▼
emit stream-json events on stdout
```

---

## Built-in tools

| Tool | Description |
|---|---|
| `bash` | Runs shell commands with SIGTERM → SIGKILL timeout |
| `read_file` | Reads files with optional line ranges |
| `write_file` | Creates or overwrites files |
| `str_replace` | Targeted in-place string replacement |
| `list_dir` | Lists directories recursively (skips `node_modules`, `.git`, `dist`) |
| `web_fetch` | Fetches URLs over HTTPS, strips HTML tags |
| `finish` | Signals the agent loop is complete (used with `--use-finish-tool`) |

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

> **Default:** Reasoning is excluded by default (`--reasoning-exclude`). Enable it with `--reasoning-effort medium` or by setting `reasoning.exclude: false` in your config.

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
| `--preset <slug>` | OpenRouter named preset (server-side routing/model config) |

### Context management

| Flag | Description |
|---|---|
| `--summarize-at <fraction>` | Trigger session summarization at this fraction of context window (e.g. `0.8`) |
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

Run orager as a persistent HTTP server to eliminate Node.js startup overhead between runs. The daemon keeps skills caches, tool result caches, and LLM prompt caches warm across heartbeats.

```bash
# Start the daemon (127.0.0.1 only — never exposed to the network)
OPENROUTER_API_KEY=sk-or-... orager --serve --port 3456

# Optional: tune concurrency and timeouts
orager --serve --port 3456 --max-concurrent 5 --idle-timeout 60m --model deepseek/deepseek-chat-v3-0324
```

### Daemon flags

| Flag | Default | Description |
|---|---|---|
| `--serve` | — | Start in daemon mode |
| `--port <n>` | `3456` | TCP port (always binds to 127.0.0.1) |
| `--max-concurrent <n>` | `3` | Max simultaneous agent runs (503 if exceeded) |
| `--idle-timeout <n>m\|h` | `30m` | Auto-exit after this period of inactivity |
| `--model <id>` | default model | Model used for cache warming and keep-alive pings |

### How the daemon is discovered

On startup the daemon writes `~/.orager/daemon.port`. The Paperclip adapter reads this file (or uses `ORAGER_DAEMON_URL`) to route runs to the daemon automatically.

### Security

- Binds to `127.0.0.1` only — never `0.0.0.0`
- Every `/run` request requires a **short-lived JWT** (HS256, 5-min TTL)
- Signing key at `~/.orager/daemon.key` (chmod 600, auto-generated on first start)
- Audit log per request: `timestamp`, `agentId`, `durationMs`, `status` — **never** prompt or response content
- Max concurrent runs enforced at the server level (not just soft-checked)
- Auto-idle shutdown limits attack window

### JWT token flow

```
adapter reads ~/.orager/daemon.key
adapter mints JWT { agentId, scope: "run", exp: now+5min }
adapter sends: Authorization: Bearer <jwt>
daemon verifies signature + expiry on every request (constant-time compare)
daemon logs: { timestamp, agentId, durationMs, status }
```

### Cache warming

- **Startup warm-up (4c):** On daemon start, sends a 1-token no-op request to pre-warm the LLM prompt cache so the first real heartbeat hits cache immediately
- **Keep-alive ping (4e):** Sends a lightweight 1-token ping every 4 minutes to maintain Anthropic's 5-minute cache TTL between heartbeat runs

---

## Performance features

### Prompt caching (Anthropic models)

For `anthropic/*` models, orager injects `cache_control: { type: "ephemeral" }` breakpoints at three strategic positions:

1. **System prompt** — the largest stable block, shared across all agents with the same base prompt
2. **Last tool definition** — tool list rarely changes mid-session
3. **Last prior-turn message** — marks the end of stable history from the previous turn

The `X-Session-Id` header is sent on every request to enable sticky routing — OpenRouter tries to send all requests in the same session to the same provider endpoint, maximizing cache hit rates.

Non-Anthropic models (DeepSeek, OpenAI, Gemini) cache automatically via OpenRouter.

### Skills caching

Skills loaded via `--add-dir` are cached in memory per directory, keyed by a fingerprint of all `SKILL.md` file modification times. Cache is invalidated automatically when any skill file changes. Max TTL: 5 minutes regardless of mtime.

### Tool result caching

Read-only tool calls (name contains `get`, `list`, `read`, `fetch`) are cached for 30 seconds per unique argument set. Write operations (`post`, `update`, `delete`, `create`, `patch`) clear the entire cache. Cache is per invocation — never persisted to disk.

### Session summarization

When `--summarize-at` is set and token usage exceeds the threshold, orager pauses the loop and summarizes the session:

- Only assistant messages are included in the summary (text + tool call names)
- Tool results and system prompt are **never sent** to the summarization model (injection safety)
- The fixed prompt prefix prevents prompt injection in the summary text
- After summarization, the full history is replaced with: `[system prompt, { role: "user", content: "[Session summary...]\n<summary>" }]`
- Session is saved with `summarized: true` flag

```bash
# Summarize when context is 80% full
orager --print - --model deepseek/deepseek-chat-v3-0324 \
  --summarize-at 0.8 \
  --summarize-model deepseek/deepseek-chat-v3-0324 \
  <<< "Your task here"
```

### Model fallback rotation

On 429 (rate limit) or 503 (provider unavailable), orager rotates to the next model in the fallback chain before exhausting retries:

```bash
orager --print - \
  --model deepseek/deepseek-chat-v3-0324 \
  --model-fallback deepseek/deepseek-chat-v3-0324:nitro \
  --model-fallback anthropic/claude-haiku-4-5 \
  <<< "Your task here"
```

---

## Session management

Sessions are saved to `~/.orager/sessions/<session-id>.json`. Resume a previous session:

```bash
orager --print - --output-format stream-json \
  --model deepseek/deepseek-chat-v3-0324 \
  --resume 550e8400-e29b-41d4-a716-446655440000 \
  <<< "Continue where you left off"
```

By default, resuming from a different working directory starts a fresh session with a warning. Use `--force-resume` to override.

### Session management commands

```bash
# List all sessions (active + trashed)
orager --list-sessions

# Mark a session as trashed (preserved on disk, skipped on resume)
orager --trash-session <session-id>

# Restore a trashed session
orager --restore-session <session-id>

# Permanently delete a session
orager --delete-session <session-id>

# Delete all trashed sessions
orager --delete-trashed
```

### Session rollback

Roll back a session to a prior turn, discarding everything after that point:

```bash
# Roll back to after turn 3 (discards turns 4, 5, ...)
orager --rollback-session <session-id> --to-turn 3

# Roll back to before any assistant turn (keep only the initial prompt)
orager --rollback-session <session-id> --to-turn 0
```

After rollback, resume the session normally:

```bash
orager --print - --resume <session-id> <<< "Try a different approach"
```

### Pruning old sessions

```bash
# Delete sessions not modified in the last 30 days (default)
orager --prune-sessions

# Custom age threshold
orager --prune-sessions --older-than 7d
orager --prune-sessions --older-than 24h
```

Time units: `d` (days), `h` (hours), `m` (minutes).

---

## Config file

For programmatic use, pass all options as a JSON file instead of CLI args:

```bash
orager --print - --config-file /tmp/my-config.json <<< "Your task"
```

The file is **read once and immediately deleted** before any API calls. Write it with mode `0600` to prevent other users from reading it while it exists. The Paperclip adapter does this automatically (crypto-random filename, chmod 600 before write).

```json
{
  "model": "deepseek/deepseek-chat-v3-0324",
  "maxTurns": 20,
  "addDirs": ["/path/to/skills"],
  "parallel_tool_calls": true,
  "reasoningExclude": true,
  "sort": "latency",
  "require_parameters": true,
  "summarizeAt": 0.8,
  "summarizeModel": "deepseek/deepseek-chat-v3-0324"
}
```

### Per-turn model routing (config file only)

Use `turnModelRules` to switch models dynamically mid-session based on turn number, cost, or token count. Rules are evaluated before each API call; the first match wins.

```json
{
  "model": "deepseek/deepseek-chat-v3-0324",
  "turnModelRules": [
    { "afterTurn": 5, "model": "anthropic/claude-sonnet-4-6" },
    { "costAbove": 0.02, "model": "deepseek/deepseek-r1", "once": true }
  ]
}
```

| Field | Description |
|---|---|
| `model` | Model to switch to when this rule matches |
| `afterTurn` | Match when turn ≥ this value (0-indexed) |
| `costAbove` | Match when cumulative cost > this USD value |
| `tokensAbove` | Match when cumulative prompt tokens > this count |
| `once` | Apply for one turn only, then stop matching (default: false) |

### Multimodal prompts (config file only)

Use `promptContent` to pass image URLs alongside the text prompt. Any vision-capable model on OpenRouter will receive the images as part of the first user message.

```json
{
  "model": "openai/gpt-4o",
  "promptContent": [
    { "type": "text", "text": "Fix the layout bug shown in this screenshot" },
    { "type": "image_url", "image_url": { "url": "https://cdn.example.com/screenshot.png" } }
  ]
}
```

The Paperclip adapter populates `promptContent` automatically when the execution context includes image attachments.

---

## Output format

Orager emits one JSON object per line (`stream-json`):

```json
{"type":"system","subtype":"init","model":"deepseek/...","session_id":"abc-123"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I'll start by..."}]}}
{"type":"tool","content":[{"type":"tool_result","tool_use_id":"call-1","content":"output\n","is_error":false}]}
{"type":"result","subtype":"success","result":"Done.","session_id":"abc-123","finish_reason":"stop","usage":{"input_tokens":1200,"output_tokens":340,"cache_read_input_tokens":800},"total_cost_usd":0.00004}
```

`subtype` on the result event: `success`, `error_max_turns`, `error_max_cost`, `interrupted`, or `error`.

`cache_read_input_tokens` reflects tokens served from the prompt cache (Anthropic or OpenRouter-managed).

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

## MCP server

orager ships an [MCP](https://modelcontextprotocol.io) server so any MCP-compatible client (Cursor, Claude Desktop, VS Code, etc.) can delegate tasks to OpenRouter models.

### Setup

```json
{
  "mcpServers": {
    "orager": {
      "command": "node",
      "args": ["/path/to/orager/dist/mcp.js"],
      "env": {
        "OPENROUTER_API_KEY": "sk-or-...",
        "ORAGER_DEFAULT_MODEL": "deepseek/deepseek-chat-v3-0324"
      }
    }
  }
}
```

### Tools exposed

| Tool | Description |
|---|---|
| `run_agent` | Run an agent to completion. Returns result text and `session_id` for continuation. |
| `list_models` | Return the configured default model for this server instance. |

### `run_agent` parameters

| Parameter | Type | Description |
|---|---|---|
| `prompt` | string | **Required.** Task or question for the agent. |
| `model` | string | OpenRouter model ID (default: `ORAGER_DEFAULT_MODEL`). |
| `session_id` | string | Resume a previous session. |
| `cwd` | string | Working directory (default: server process cwd). |
| `max_turns` | number | Max agent turns (default: `20`). |
| `max_cost_usd` | number | Stop if cost exceeds this USD value. |
| `system_prompt` | string | Extra text appended to the system prompt. |
| `dangerously_skip_permissions` | boolean | Skip tool approval prompts. |

### Environment variables

| Variable | Description |
|---|---|
| `OPENROUTER_API_KEY` | OpenRouter API key (required) |
| `ORAGER_DEFAULT_MODEL` | Default model if `model` not specified in tool call |
| `ORAGER_MAX_TURNS` | Default max turns (default: `20`) |
| `ORAGER_MAX_COST_USD` | Default cost cap in USD (default: none) |

---

## Development

```bash
npm install
npm run build       # tsc → dist/
npm run typecheck   # tsc --noEmit
npm run test        # vitest run
npm run dev         # tsx src/index.ts (no build needed)
npm run mcp         # tsx src/mcp.ts  (MCP server without building)
```

---

## Architecture

```
src/
├── index.ts          CLI entry point — arg parsing, session subcommands, main()
├── loop.ts           Agent loop — turns, tool execution, summarization, cost tracking
├── openrouter.ts     OpenRouter streaming API — SSE parsing, Anthropic cache breakpoints
├── session.ts        Session persistence (~/.orager/sessions/*.json)
├── skills.ts         Skills loader — mtime-fingerprinted disk cache, SKILL.md parsing
├── retry.ts          Retry + model fallback rotation on 429/503
├── emit.ts           stream-json emitter (stdout)
├── approval.ts       Interactive TTY approval prompt
├── daemon.ts         HTTP daemon server (--serve mode) with JWT auth + keep-alive
├── jwt.ts            HS256 JWT mint/verify using Node.js built-in crypto
└── tools/
    ├── index.ts      Tool registry (ALL_TOOLS)
    ├── bash.ts       bash tool
    ├── read-file.ts  read_file tool
    ├── write-file.ts write_file tool
    ├── str-replace.ts str_replace tool
    ├── list-dir.ts   list_dir tool
    ├── web-fetch.ts  web_fetch tool
    ├── finish.ts     finish tool
    └── load-tools.ts loads extra tools from JSON spec files
```

---

## Future enhancements

- **Explicit read-only flag on tools** — add `readonly: boolean` to `ToolDefinition` so the tool result cache doesn't depend on name-pattern heuristics
- **Per-tool cache TTL** — allow tools to declare their own cache duration instead of the global 30s
- **Daemon auto-start** — auto-start the daemon if not running when the adapter detects daemon mode is configured
- **Daemon metrics endpoint** — `GET /metrics` exposing active runs, cache hit rates, token counts since startup
- **Structured output tools** — first-class support for `response_format: json_schema` with auto-enabled response-healing plugin
- **Context window map expansion** — add Gemini 2.5 (1M), Llama 3 (128k), Mistral models to `getContextWindow()`
- **Selective summarization** — allow summarizing only tool results older than N turns (keep recent turns intact)
- **Session export/import** — `orager --export-session <id> > session.json` and `orager --import-session session.json` for cross-machine use
- **OpenTelemetry traces** — emit spans per turn + per tool call for observability integrations
- **Multi-agent shared sessions** — allow two agent processes to append to the same session (useful for parallel sub-agents)
- **Streaming cost estimates** — emit a `cost_estimate` event after each turn (before the run finishes) so callers can act on cost early
- **Plugin registry** — expose `plugins` field in CLI options for other OpenRouter plugins beyond response-healing
