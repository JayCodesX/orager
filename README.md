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

## Session persistence

Sessions are saved to `~/.orager/sessions/<session-id>.json`. Resume a previous session:

```bash
orager --print - --output-format stream-json \
  --model deepseek/deepseek-r1 \
  --resume 550e8400-e29b-41d4-a716-446655440000 \
  <<< "Continue where you left off"
```

By default, resuming from a different working directory starts a fresh session with a warning. Use `--force-resume` to override.

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

## Development

```bash
npm install
npm run build    # tsc
npm run test     # vitest run
npm run dev      # tsx src/index.ts (run without building)
```
