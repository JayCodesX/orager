# Getting Started

## Prerequisites

- **Node.js** >= 20.3.0 (or **Bun** >= 1.0)
- A provider API key (OpenRouter, Anthropic, or compatible)

## Installation

Install globally from npm:

```bash
npm install -g @orager/core
```

Or run directly with npx without installing:

```bash
npx @orager/core run "Hello, world!"
```

## Configuration

Set your API key before first use:

```bash
export PROTOCOL_API_KEY=your_api_key_here
```

Then run the interactive setup wizard to verify your configuration:

```bash
orager setup
orager setup --check   # validate config and test the API key
```

The setup wizard creates `~/.orager/settings.json` with sensible defaults.

## First Run

Run a one-shot prompt and exit:

```bash
orager run "Summarize the README in this directory"
```

Start an interactive multi-turn conversation:

```bash
orager chat
```

## Key Concepts

### Commands

orager has three primary commands:

| Command | Description |
|---------|-------------|
| `orager run "prompt"` | Run the agent once, then exit |
| `orager chat` | Start an interactive REPL session |
| `orager serve` | Start the browser-based UI server |

### Models

The default model is `deepseek/deepseek-chat-v3-2`. Override it per-run:

```bash
orager run --model anthropic/claude-3-5-sonnet "prompt"
orager run --model openai/gpt-4o "prompt"
```

### Sessions

Every run creates a session that persists its history. Resume a previous session by ID:

```bash
orager chat --session-id <id>
```

List all sessions:

```bash
orager --list-sessions
```

### Memory

orager uses a three-layer memory system backed by SQLite. Memory persists across sessions within a namespace. Use `--memory-key` to scope memory to a project:

```bash
orager run --memory-key my-project "Continue working on the API design"
```

See the [Memory System guide](./memory.md) for details.

### Safety and Permissions

By default orager asks before executing shell commands. To require approval for all tool calls:

```bash
orager run --require-approval "prompt"
```

For automated pipelines where you trust the agent fully:

```bash
orager run --dangerously-skip-permissions "prompt"
```

## Browser UI

Start the web interface for browsing sessions, viewing costs, and managing configuration:

```bash
orager serve
orager serve --port 3457
```

Navigate to `http://localhost:3457` in your browser.

## Next Steps

- [CLI Reference](./cli-reference.md) — all commands and flags
- [Configuration](./configuration.md) — settings.json reference
- [Memory System](./memory.md) — how cross-session memory works
- [Skills & Learning](./skills.md) — SkillBank and self-improvement
