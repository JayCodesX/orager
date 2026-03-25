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
  --model deepseek/deepseek-r1 \
  --max-turns 20
```

Or via heredoc:

```bash
orager --print - --output-format stream-json --model openai/gpt-4o <<< "Fix the failing tests"
```

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

## CLI flags

### Core

| Flag | Description |
|---|---|
| `--print -` | Read prompt from stdin |
| `--output-format stream-json` | Emit stream-json events on stdout (required for Paperclip) |
| `--model <id>` | OpenRouter model ID (default: `deepseek/deepseek-chat-v3-2`) |
| `--model-fallback <id>` | Fallback model, repeatable |
| `--max-turns <n>` | Maximum agent turns (default: `20`) |
| `--resume <session-id>` | Resume a previous session from `~/.orager/sessions/` |
| `--force-resume` | Resume even if the session was from a different cwd |
| `--max-retries <n>` | API retries on transient errors (default: `3`) |
| `--verbose` | Log extra debug info to stderr |

### Tools & permissions

| Flag | Description |
|---|---|
| `--dangerously-skip-permissions` | Skip all tool approval prompts |
| `--use-finish-tool` | Model calls a `finish` tool to signal completion |
| `--require-approval` | Require human approval before any tool runs |
| `--require-approval-for <tools>` | Comma-separated tools that require approval |
| `--tools-file <path>` | JSON file defining extra tools (repeatable) |
| `--add-dir <path>` | Skills directory to load (repeatable) |
| `--sandbox-root <path>` | Restrict file operations to this directory |

### Cost controls

| Flag | Description |
|---|---|
| `--max-cost-usd <n>` | Stop if accumulated cost exceeds this amount |
| `--cost-per-input-token <n>` | Override input token cost for tracking |
| `--cost-per-output-token <n>` | Override output token cost for tracking |

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

### Provider routing

| Flag | Description |
|---|---|
| `--provider-order <slugs>` | Comma-separated preferred provider slugs |
| `--provider-only <slugs>` | Provider allowlist |
| `--provider-ignore <slugs>` | Provider blocklist |
| `--data-collection deny` | Exclude providers that train on your data |
| `--zdr` | Restrict to Zero Data Retention providers |
| `--sort price\|throughput\|latency` | Provider selection strategy |
| `--quantizations <list>` | Filter by quantization (e.g. `fp16,bf16`) |
| `--transforms <list>` | Comma-separated transforms (e.g. `middle-out`) |

### Attribution

| Flag | Description |
|---|---|
| `--site-url <url>` | HTTP-Referer header for OpenRouter attribution |
| `--site-name <name>` | X-Title header for OpenRouter attribution |

## Session management

Sessions are saved to `~/.orager/sessions/<session-id>.json`. Resume a previous session:

```bash
orager --print - --output-format stream-json \
  --model deepseek/deepseek-r1 \
  --resume 550e8400-e29b-41d4-a716-446655440000 \
  <<< "Continue where you left off"
```

By default, resuming from a different working directory starts a fresh session with a warning. Use `--force-resume` to override.

### Pruning old sessions

Session files accumulate indefinitely. Prune sessions that haven't been used recently:

```bash
# Delete sessions not modified in the last 30 days (default)
orager --prune-sessions

# Custom age threshold
orager --prune-sessions --older-than 7d
orager --prune-sessions --older-than 24h
```

Time units: `d` (days), `h` (hours), `m` (minutes).

## Output format

Orager emits one JSON object per line (`stream-json`):

```json
{"type":"system","subtype":"init","model":"deepseek/...","session_id":"abc-123"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I'll start by..."}]}}
{"type":"tool","content":[{"type":"tool_result","tool_use_id":"call-1","content":"output\n","is_error":false}]}
{"type":"result","subtype":"success","result":"Done.","session_id":"abc-123","usage":{"input_tokens":1200,"output_tokens":340,"cache_read_input_tokens":80},"total_cost_usd":0.0004}
```

`subtype` on the result event is one of: `success`, `error_max_turns`, `interrupted`, or `error`.

## Popular model IDs

| Model | ID |
|---|---|
| DeepSeek V3.2 | `deepseek/deepseek-chat-v3-2` |
| DeepSeek R1 | `deepseek/deepseek-r1` |
| Claude Sonnet 4.6 | `anthropic/claude-sonnet-4-6` |
| Claude Opus 4.6 | `anthropic/claude-opus-4-6` |
| GPT-4o | `openai/gpt-4o` |
| OpenAI o3 | `openai/o3` |
| Gemini 2.5 Pro | `google/gemini-2.5-pro` |
| Llama 3.3 70B | `meta-llama/llama-3.3-70b-instruct` |

Append `:free`, `:nitro`, `:floor`, `:online`, `:thinking`, or `:extended` to any model ID. Full catalogue at [openrouter.ai/models](https://openrouter.ai/models).

## MCP server

orager ships an [MCP](https://modelcontextprotocol.io) server so any MCP-compatible client (Cursor, Claude Desktop, VS Code, etc.) can delegate tasks to OpenRouter models without leaving their editor.

### Setup

Add to your editor's MCP config (e.g. `~/.cursor/mcp.json` or Claude Desktop's `claude_desktop_config.json`):

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

Or run directly during development:

```bash
npm run mcp
```

### Tools exposed

| Tool | Description |
|---|---|
| `run_agent` | Run an agent to completion. Returns the result text and a `session_id` you can pass on the next call to continue. |
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

### Model chaining

Because OpenRouter proxies all major models under one API key, you can chain models within a single workflow — use a cheap fast model for implementation and a smarter model for review:

```
Claude (via run_agent, model: anthropic/claude-sonnet-4-6)
  └── reviews diff produced by
DeepSeek (previous run_agent call, model: deepseek/deepseek-chat-v3-0324)
```

Both calls go through the same OpenRouter API key. No separate Anthropic API key needed.

### Graceful shutdown

When the MCP server receives SIGTERM or SIGINT it stops accepting new `run_agent` calls and waits up to 60 seconds for any in-flight calls to complete before exiting. Each in-flight call saves session state after every turn, so a mid-task shutdown loses at most the current turn — the next call can resume via `session_id`.

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
npm run build    # tsc
npm run test     # vitest run
npm run dev      # tsx src/index.ts (run without building)
npm run mcp      # tsx src/mcp.ts (run MCP server without building)
```
