# orager

[![CI](https://github.com/JayCodesX/orager/actions/workflows/ci.yml/badge.svg)](https://github.com/JayCodesX/orager/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40orager%2Fcore)](https://www.npmjs.com/package/@orager/core)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node ≥20](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](https://nodejs.org)
[![Bun](https://img.shields.io/badge/runtime-bun-black)](https://bun.sh)
[![Join waitlist](https://img.shields.io/badge/oragerai.com-join%20waitlist-6c63ff)](https://oragerai.com)

**Production-grade AI agent runtime.** Multi-turn tool-calling, persistent memory, and multi-model routing — works with any model provider.

> Built as the runtime behind [Paperclip](https://paperclipai.com) agents.

---

## What is orager?

orager is a TypeScript library and CLI for running AI agents that:

- **Remember things** — persistent memory across sessions (SQLite-backed, 3-layer: master context, long-term distilled facts, short-term episodic)
- **Use tools** — bash, file read/write, web search, MCP servers, and custom tools
- **Route across models** — switch between Claude, DeepSeek, GPT-4o, Gemini, and Llama without changing your code
- **Learn from experience** — SkillBank captures successful task patterns and reinjects them in future runs; OMLS trains LoRA adapters from trajectory data overnight
- **Scale safely** — token budget enforcement, auto-summarization, rate limiting, JWT auth, session isolation

---

## Install

```bash
# CLI (global)
npm install -g @orager/core

# Library
npm install @orager/core
```

**Requirements:** Node ≥ 20 or Bun ≥ 1.3. Set `OPENROUTER_API_KEY` in your environment.

---

## Quick start

### CLI

```bash
# One-shot run
orager run "Summarise the last 10 git commits in this repo"

# Interactive chat (resumable sessions)
orager chat
orager chat --session-id <id>   # resume a session

# Use a specific model
orager run --model deepseek/deepseek-chat "Explain this codebase"
```

### Library

```typescript
import { runAgentLoop } from "@orager/core";

await runAgentLoop({
  prompt: "Write a test for the auth module",
  model: "deepseek/deepseek-chat",
  apiKey: process.env.OPENROUTER_API_KEY!,
  cwd: process.cwd(),
  maxTurns: 20,
  onEmit: (e) => console.log(e),
});
```

### Multi-agent workflows

```typescript
import { runAgentWorkflow } from "@orager/core";
import type { AgentWorkflow } from "@orager/core";

const workflow: AgentWorkflow = {
  steps: [
    { role: "researcher", model: "deepseek/deepseek-r1" },
    { role: "writer",     model: "anthropic/claude-sonnet-4-5" },
    { role: "reviewer",   model: "deepseek/deepseek-chat" },
  ],
};

await runAgentWorkflow(workflow, "Investigate and write a report on...");
```

---

## Features

### Memory system

orager maintains three memory layers per agent namespace:

| Layer | Scope | How it fills |
|---|---|---|
| **Master context** | Permanent | Set via `orager memory` — core facts the agent always knows |
| **Long-term distilled** | Cross-session | Auto-extracted from `<memory_update>` blocks; typed as `insight`, `fact`, `decision`, `risk`, `competitor`, or `open_question` |
| **Short-term episodic** | Within-session | Last N turns + condensed summary; auto-compresses at 70% token pressure or every 6 turns |

Memory is stored in SQLite (`~/.orager/orager.db`) with FTS5 full-text search and optional embedding-based retrieval.

```bash
orager memory list             # see all stored memories
orager memory inspect          # preview what would be injected now
```

### SkillBank

Successful task patterns are automatically captured and reused:

```bash
orager skills list             # see captured skills
orager skills show <id>        # view a skill
orager skill-train             # trigger training manually
```

### Model routing

Switch models mid-session or use turn-based escalation rules:

```typescript
await runAgentLoop({
  model: "deepseek/deepseek-chat",
  turnModelRules: [
    { afterTurn: 5, model: "anthropic/claude-sonnet-4-5" },
  ],
});
```

### Session management

```bash
orager chat --session-id my-project   # resume or create
orager sessions list                  # browse all sessions
orager sessions search "auth bug"     # full-text search
```

### MCP server support

```typescript
await runAgentLoop({
  mcpServers: {
    filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
  },
});
```

---

## Configuration

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `OPENROUTER_API_KEY` | — | **Required.** OpenRouter API key |
| `ORAGER_DB_PATH` | `~/.orager/orager.db` | SQLite database path (`none` = file-based fallback) |
| `ORAGER_MEMORY_DIR` | `~/.orager/memory` | File-based memory directory (legacy) |
| `ORAGER_SESSIONS_DIR` | `~/.orager/sessions` | Session storage directory |

### settings.json (`~/.orager/settings.json`)

```json
{
  "memory": {
    "tokenPressureThreshold": 0.70,
    "turnInterval": 6,
    "keepRecentTurns": 4,
    "summarizationModel": "openai/gpt-4o-mini"
  },
  "bashPolicy": {
    "blockedCommands": ["rm -rf /", "sudo"]
  },
  "permissions": {
    "bash": "ask",
    "write_file": "allow"
  }
}
```

### Key CLI flags

```
orager run [options] <prompt>
  -m, --model           Model ID (e.g. deepseek/deepseek-chat)
  --max-turns           Maximum agent turns
  --max-cost-usd        Abort if cost exceeds this USD amount
  --session-id          Session to resume
  --memory-key          Memory namespace
  --verbose             Stream tool outputs and reasoning
  --subprocess          Run agent in isolated child process
  --dangerously-skip-permissions  Skip approval prompts
```

---

## Standalone binaries

Pre-built binaries require no Node.js or Bun installation:

```bash
# macOS (Apple Silicon)
curl -L https://github.com/JayCodesX/orager/releases/latest/download/orager-darwin-arm64 \
  -o /usr/local/bin/orager && chmod +x /usr/local/bin/orager

# Linux (x64)
curl -L https://github.com/JayCodesX/orager/releases/latest/download/orager-linux-x64 \
  -o /usr/local/bin/orager && chmod +x /usr/local/bin/orager
```

Build from source: `bun run build:binary`

---

## Architecture

```
┌──────────────────────────────────────┐
│        Your code / CLI               │
│  orager run · orager chat            │
│  runAgentLoop()  (library)           │
│  runAgentWorkflow()  (library)       │
└──────────────┬───────────────────────┘
               │ in-process (default)
               │ or subprocess JSON-RPC 2.0
               ▼
┌──────────────────────────────────────────────────────┐
│               loop.ts — Agent Loop                   │
│                                                      │
│  System prompt assembly                              │
│  ├─ [FROZEN]  base rules · skills · CLAUDE.md        │
│  │            ← cache_control breakpoint             │
│  └─ [DYNAMIC] master context · memories · checkpoint │
│                                                      │
│  ┌─────────── Turn Loop ──────────────┐              │
│  │  callOpenRouter (any model)        │              │
│  │  Parse text + tool calls + memory  │              │
│  │  Execute tools (10 concurrent max) │              │
│  │  Ingest <memory_update> blocks     │              │
│  │  Summarize at 70% token pressure   │              │
│  └────────────────────────────────────┘              │
│                                                      │
│  Session checkpoints · cost tracking · webhooks      │
└──────────────────────────────────────────────────────┘
         │                        │
         ▼                        ▼
  SQLite memory             OpenRouter API
  (3-layer store)       (100+ models, any provider)
```

---

## Development

```bash
git clone https://github.com/JayCodesX/orager
cd orager && bun install

bun run test:bun        # unit tests
bun run test:bun:int    # integration tests
bun run typecheck
```

---

## Roadmap

- **Orager Cloud** — managed agents, hosted memory, zero infra
- **SkillBank Pro** — shared skills across teams + OMLS training jobs
- **Skill Marketplace** — publish and subscribe to community skill packs
- **Enterprise** — self-hosted deployment, SSO, audit logs, SLA

[Join the waitlist →](https://orager.dev)

---

## License

MIT — see [LICENSE](./LICENSE)
