# CLI Reference

## Commands

### `orager run`

Run the agent once with a prompt and exit (non-interactive).

```bash
orager run [OPTIONS] "prompt"
```

**Examples:**

```bash
orager run "Fix the failing tests"
orager run --model anthropic/claude-opus-4 --max-turns 10 "Refactor the auth module"
orager run --subprocess "Run the build and report any errors"
```

---

### `orager chat`

Start an interactive multi-turn REPL conversation.

```bash
orager chat [OPTIONS]
```

**Examples:**

```bash
orager chat
orager chat --session-id abc123   # resume an existing session
orager chat --model openai/gpt-4o
```

---

### `orager serve` / `orager ui`

Start the browser-based UI server for browsing sessions, viewing costs, and managing configuration. Does **not** run agents.

```bash
orager serve [--port <n>]
orager ui [--port <n>]
```

Default port: `3457`.

---

### `orager setup`

Run the interactive setup wizard to configure your API key and default settings.

```bash
orager setup
orager setup --check   # validate config and test API key without prompting
```

---

### `orager memory`

Manage memory namespaces.

```bash
orager memory list
orager memory inspect [<namespace>]
orager memory export [<namespace>]
orager memory clear [<namespace>]
```

---

### `orager skills`

Manage SkillBank learned skills.

```bash
orager skills list
orager skills show <id>
orager skills delete <id>
orager skills stats
orager skills extract
```

---

### `orager skill-train`

Manage OMLS opportunistic RL training.

```bash
orager skill-train            # start training
orager skill-train --rl       # RL-mode training
orager skill-train --status   # check training status
orager skill-train --rollback # roll back the last adapter
orager skill-train --setup-cron  # install the training cron job
```

---

## Common Flags

The following flags apply to both `run` and `chat` unless otherwise noted.

### Core

| Flag | Description |
|------|-------------|
| `--model <id>` | Model to use. Default: `deepseek/deepseek-chat-v3-2` |
| `--session-id <id>` | Resume an existing session. Alias: `--resume` |
| `--max-turns <n>` | Maximum agent turns. Default: `20` |
| `--max-cost-usd <n>` | Hard stop when cumulative cost exceeds this value (USD) |
| `--max-cost-usd-soft <n>` | Warn (but continue) when cost exceeds this value |
| `--memory-key <key>` | Memory namespace for this run |
| `--file <path>` | Attach a file (image, PDF, audio, text). Repeatable |
| `--subprocess` | Run agent in an isolated subprocess via JSON-RPC transport |
| `--verbose` | Enable verbose diagnostic logging to stderr |
| `--timeout-sec <n>` | Run-level timeout in seconds |

### Model Parameters

| Flag | Description |
|------|-------------|
| `--temperature <n>` | Sampling temperature (0.0–2.0) |
| `--top-p <n>` | Nucleus sampling threshold |
| `--top-k <n>` | Top-K sampling |
| `--frequency-penalty <n>` | Frequency penalty |
| `--presence-penalty <n>` | Presence penalty |
| `--repetition-penalty <n>` | Repetition penalty |
| `--min-p <n>` | Min-P sampling |
| `--seed <n>` | Random seed for reproducibility |
| `--stop <string>` | Stop sequence. Repeatable |
| `--reasoning-effort <level>` | Reasoning effort: `xhigh`, `high`, `medium`, `low`, `minimal`, `none` |
| `--reasoning-max-tokens <n>` | Maximum tokens for reasoning |
| `--reasoning-exclude` | Exclude reasoning tokens from output |

### Profiles

| Flag | Description |
|------|-------------|
| `--profile <name>` | Apply a named profile preset: `code-review`, `bug-fix`, `research`, `refactor`, `test-writer`, `devops` |

### Multi-Model & Fallback

| Flag | Description |
|------|-------------|
| `--model-fallback <id>` | Add a fallback model. Repeatable. Tried in order if primary fails |
| `--provider-order <list>` | Comma-separated provider preference order |
| `--provider-only <list>` | Only use these providers (comma-separated) |
| `--provider-ignore <list>` | Ignore these providers (comma-separated) |
| `--sort <criterion>` | Sort providers by: `price`, `throughput`, `latency` |
| `--quantizations <list>` | Allowed quantizations (comma-separated) |
| `--data-collection <allow\|deny>` | Control provider data collection policy |
| `--zdr` | Enable zero data retention (provider-level, if supported) |

### Tools & Safety

| Flag | Description |
|------|-------------|
| `--dangerously-skip-permissions` | Skip all tool-use permission checks |
| `--require-approval` | Require approval for all tool calls |
| `--require-approval-for <tools>` | Require approval for specific tools (comma-separated) |
| `--approval-mode <tty\|question>` | How to present approval prompts |
| `--tool-choice <none\|auto\|required>` | Override tool selection strategy |
| `--parallel-tool-calls` | Allow parallel tool calls |
| `--no-parallel-tool-calls` | Disable parallel tool calls |
| `--require-parameters` | Require all tool parameters to be filled |
| `--use-finish-tool` | Require the agent to call a `finish` tool to signal completion |
| `--tools-file <path>` | Load additional tool definitions from a JSON file |
| `--hook-error-mode <ignore\|warn\|fail>` | How to handle hook errors |
| `--tool-error-budget-hard-stop` | Hard stop when the tool error budget is exceeded |
| `--auto-memory` | Enable `write_memory`/`read_memory` tools |
| `--enable-browser-tools` | Enable browser automation tools |

### Sandbox

| Flag | Description |
|------|-------------|
| `--sandbox-root <path>` | Restrict file operations to this root directory |
| `--add-dir <path>` | Add an extra directory to the agent's working context. Repeatable |

### Context & Summarization

| Flag | Description |
|------|-------------|
| `--summarize-at <ratio>` | Fraction of context window at which to trigger summarization (0.0–1.0) |
| `--summarize-model <id>` | Model to use for summarization calls |
| `--summarize-keep-recent-turns <n>` | Keep the last N turns intact when summarizing |
| `--system-prompt-file <path>` | Path to a file containing the system prompt |
| `--online-search` | Enable online search tool |
| `--plan-mode` | Run in plan-only mode (no execution) |
| `--inject-context` | Inject additional repo context |
| `--vision-model <id>` | Override the vision model for image tasks |

### Output & Diagnostics

| Flag | Description |
|------|-------------|
| `--output-format <stream-json\|text>` | Output format (default: `stream-json`) |
| `--tag-tool-outputs` | Tag tool outputs with XML-style markers |
| `--no-tag-tool-outputs` | Disable tool output tagging |
| `--track-file-changes` | Track file changes made during a run |
| `--transforms <list>` | Comma-separated prompt transforms to apply |

### Sessions

| Flag | Description |
|------|-------------|
| `--list-sessions` | List all sessions |
| `--search-sessions <query>` | Search sessions by content |
| `--limit <n>` | Limit results (paired with `--search-sessions`, default 20) |
| `--offset <n>` | Skip first N results (pagination) |
| `--trash-session <id>` | Move a session to trash |
| `--restore-session <id>` | Restore a trashed session |
| `--delete-session <id>` | Permanently delete a session |
| `--delete-trashed` | Delete all trashed sessions |
| `--rollback-session <id>` | Roll back a session to previous turn |
| `--fork-session <id>` | Fork a session at the latest or a specific turn |
| `--at-turn <n>` | Used with `--fork-session`: fork at this turn number |
| `--compact-session <id>` | Summarize a session's history in-place |
| `--prune-sessions` | Delete sessions older than 30 days |
| `--older-than <value>` | Override prune threshold (e.g. `7d`, `24h`, `1h`) |
| `--force-resume` | Force resume even if the session is in a bad state |

### Other

| Flag | Description |
|------|-------------|
| `--settings-file <path>` | Path to a custom settings JSON file |
| `--preset <name>` | Apply a named inference preset |
| `--require-env <vars>` | Require comma-separated env vars to be set before running |
| `--max-retries <n>` | Maximum retries on recoverable errors (default: 3) |
| `--max-spawn-depth <n>` | Maximum recursion depth for spawned sub-agents |
| `--agent-id <id>` | Explicit agent ID for this run |
| `--repo-url <url>` | Repository URL to inject into context |
| `--site-url <url>` | Site URL for context |
| `--site-name <name>` | Site name for context |
| `--ollama` | Use a local Ollama instance |
| `--ollama-model <id>` | Model name on the Ollama instance |
| `--ollama-url <url>` | Base URL for the Ollama API |
| `--version`, `-v` | Print version and exit |
| `--help`, `-h` | Print help and exit |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PROTOCOL_API_KEY` | LLM provider API key (required) |
| `ORAGER_MAX_TURNS` | Override default max turns (overridden by `--max-turns`) |
| `ORAGER_JSON_LOGS` | Set to `1` to emit structured JSON startup log to stderr |
| `ORAGER_SESSIONS_DIR` | Override the sessions directory |
| `ORAGER_PROFILES_DIR` | Override the profiles directory |
| `ORAGER_SETTINGS_ALLOWED_ROOTS` | Colon-separated path roots allowed for `--settings-file` |
