# orager

[![CI](https://github.com/JayCodesX/orager/actions/workflows/ci.yml/badge.svg)](https://github.com/JayCodesX/orager/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40orager%2Fcore)](https://www.npmjs.com/package/@orager/core)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node ≥20](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](https://nodejs.org)
[![Bun](https://img.shields.io/badge/runtime-bun-black)](https://bun.sh)
[![Join waitlist](https://img.shields.io/badge/oragerai.com-join%20waitlist-6c63ff)](https://oragerai.com)

**Production-grade AI agent runtime.** Multi-turn tool-calling, persistent memory, multimodal input, and multi-model routing — works with any model provider.

> Built as the runtime behind [Paperclip](https://paperclipai.com) agents.

---

## What is orager?

orager is a TypeScript library and CLI for running AI agents that:

- **Remember things** — persistent memory across sessions (SQLite-backed, 3-layer: master context, long-term distilled facts, short-term episodic)
- **Use tools** — bash, file read/write, web search, MCP servers, and custom tools
- **Handle multimodal input** — attach images, PDFs, audio (auto-transcribed via Whisper), and text files to any prompt
- **Route across models** — switch between Claude, DeepSeek, GPT-4o, Gemini, and Llama without changing your code; run locally via Ollama
- **Learn from experience** — SkillBank captures successful task patterns; OMLS trains LoRA adapters locally (Apple Silicon / NVIDIA GPU) or via cloud VPS
- **Scale safely** — token budget enforcement, auto-summarization, rate limiting, JWT auth, per-namespace session isolation

---

## Install

```bash
# CLI (global)
npm install -g @orager/core

# Library
npm install @orager/core
```

**Requirements:** Node ≥ 20 or Bun ≥ 1.3. Set `PROTOCOL_API_KEY` to your [OpenRouter](https://openrouter.ai) API key.

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

# Attach files (images, PDFs, audio, text)
orager run --file screenshot.png --file report.pdf "What does this show?"

# Run locally with Ollama
orager run --ollama --ollama-model llama3.2 "Refactor this function"
```

### Library

```typescript
import { runAgentLoop } from "@orager/core";

await runAgentLoop({
  prompt: "Write a test for the auth module",
  model: "deepseek/deepseek-chat",
  apiKey: process.env.PROTOCOL_API_KEY!,
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

orager maintains three memory layers per agent namespace, stored in per-namespace SQLite files (`~/.orager/memory/<key>.sqlite`):

| Layer | Scope | How it fills |
|---|---|---|
| **Master context** | Permanent | Set via `orager memory` — core facts the agent always knows |
| **Long-term distilled** | Cross-session | Auto-extracted from `<memory_update>` blocks; typed as `insight`, `fact`, `decision`, `risk`, `competitor`, or `open_question` |
| **Short-term episodic** | Within-session | Last N turns + condensed summary; auto-compresses at 70% token pressure or every 6 turns |

Retrieval uses FTS5 full-text search by default, with optional ANN vector search via `sqlite-vec` for embedding-based retrieval.

```bash
orager memory list             # see all stored memories
orager memory inspect          # preview what would be injected now
```

### Multimodal input

Attach files to any prompt with `--file`. Supported formats:

| Type | Extensions | Processing |
|---|---|---|
| **Images** | `.jpg`, `.png`, `.gif`, `.webp`, `.svg` | Encoded as base64 image blocks |
| **PDFs** | `.pdf` | Text extracted via `pdftotext` (falls back to raw text) |
| **Audio** | `.mp3`, `.wav`, `.m4a`, `.ogg`, `.flac` | Transcribed via local [Whisper](https://github.com/openai/whisper) if installed; otherwise stub |
| **Text / code** | Any other | Included as a fenced code block |

```bash
orager run --file diagram.png --file notes.txt "Summarise these"
orager run --file meeting.mp3 "What were the action items?"
```

Install Whisper for audio transcription: `pip install openai-whisper`

### Local model inference (Ollama)

Route requests to a locally running [Ollama](https://ollama.com) server instead of the cloud:

```bash
orager run --ollama --ollama-model llama3.2 "Explain this code"
orager chat --ollama --ollama-url http://localhost:11434
```

Or set defaults in `~/.orager/settings.json`:

```json
{
  "ollama": { "enabled": true, "model": "llama3.2" }
}
```

### OMLS — On-Machine Learning System

orager can fine-tune a LoRA adapter from your agent's own trajectory data. Training runs locally on Apple Silicon (MLX) or NVIDIA GPUs (peft/llama.cpp), or via a cloud VPS (Together AI, Vast.ai, RunPod).

```bash
# Train (auto-detects hardware)
orager skill-train --rl

# Force local training on Apple Silicon
orager skill-train --rl --local

# Force cloud VPS training
orager skill-train --rl --no-local

# Check status and buffer size
orager skill-train --status

# Roll back to the previous adapter version
orager skill-train --rollback

# Schedule automated training
orager skill-train --setup-cron
```

**Hardware requirements:**
- Apple Silicon: `pip install mlx-lm` (8 GB RAM minimum)
- NVIDIA GPU: `pip install peft transformers bitsandbytes accelerate datasets`
- CPU fallback: `pip install peft transformers accelerate datasets`

Trained adapters are stored at `~/.orager/models/<memoryKey>/<model>/`. Each training run archives the previous adapter as `adapter.v<N>.safetensors` so rollback is always non-destructive.

### SkillBank

Successful task patterns are automatically captured and reinjected in future prompts:

```bash
orager skills list             # see captured skills
orager skills show <id>        # view a skill
orager skills stats            # usage and hit rates
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

Sessions are stored as append-only JSONL transcripts (`~/.orager/sessions/<id>.jsonl`) with a lightweight SQLite index for search.

```bash
orager chat --session-id my-project   # resume or create
orager --list-sessions                # browse all sessions
orager --search-sessions "auth bug"   # full-text search
orager --fork-session <id>            # branch from an existing session
orager --rollback-session <id>        # undo the last turn
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
| `PROTOCOL_API_KEY` | — | **Required.** OpenRouter API key |
| `ORAGER_SESSIONS_DIR` | `~/.orager/sessions` | Session storage directory |
| `ORAGER_MEMORY_SQLITE_DIR` | `~/.orager/memory` | Per-namespace memory SQLite directory |
| `ORAGER_SKILLS_DB_PATH` | `~/.orager/skills/skills.sqlite` | SkillBank database path |
| `ORAGER_OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server URL |
| `ORAGER_MODEL` | — | Default model override |
| `ORAGER_MAX_TURNS` | `20` | Default max turns |
| `ORAGER_MAX_COST_USD` | — | Hard cost cap in USD |
| `ORAGER_PROFILES_DIR` | `~/.orager/profiles` | Custom profiles directory |
| `ORAGER_SETTINGS_ALLOWED_ROOTS` | — | Colon-separated roots for `--settings-file` |

### `~/.orager/settings.json`

```json
{
  "model": "deepseek/deepseek-chat",
  "memory": {
    "tokenPressureThreshold": 0.70,
    "turnInterval": 6,
    "keepRecentTurns": 4,
    "summarizationModel": "openai/gpt-4o-mini"
  },
  "ollama": {
    "enabled": false,
    "model": "llama3.2",
    "baseUrl": "http://localhost:11434"
  },
  "omls": {
    "enabled": true,
    "minBatchSize": 32
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
  --model <id>              Model ID (e.g. deepseek/deepseek-chat)
  --max-turns <n>           Maximum agent turns (default: 20)
  --max-cost-usd <n>        Abort if cost exceeds this USD amount
  --session-id <id>         Session to resume
  --memory-key <key>        Memory namespace
  --file <path>             Attach a file — repeatable
  --verbose                 Stream tool outputs and reasoning
  --subprocess              Run agent in isolated child process
  --ollama                  Route to local Ollama server
  --ollama-model <id>       Ollama model name
  --dangerously-skip-permissions  Skip approval prompts
```

---

## Browser UI

```bash
orager serve              # start on http://localhost:3457
orager serve --port 8080
```

The UI provides:
- **Dashboard** — live cost tracking, session list, OMLS adapter status
- **Configuration** — settings editor, Ollama and OMLS setup
- **Logs** — structured agent logs with filtering
- **Telemetry** — token usage and cost breakdown over time

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
┌──────────────────────────────────────────────────────┐
│              Your code / CLI                         │
│  orager run · orager chat · orager serve             │
│  runAgentLoop()  ·  runAgentWorkflow()               │
└──────────────┬───────────────────────────────────────┘
               │ in-process (default)
               │ or subprocess JSON-RPC 2.0
               ▼
┌──────────────────────────────────────────────────────┐
│                  loop.ts — Agent Loop                │
│                                                      │
│  Input processing                                    │
│  ├─ Text prompt + --file attachments                 │
│  │  (images, PDFs, audio/Whisper, text)              │
│  └─ Modality routing (vision / audio / document)     │
│                                                      │
│  System prompt assembly                              │
│  ├─ [FROZEN]  base rules · skills · CLAUDE.md        │
│  │            ← cache_control breakpoint             │
│  └─ [DYNAMIC] master context · memories · checkpoint │
│                                                      │
│  ┌─────────── Turn Loop ──────────────┐              │
│  │  callOpenRouter / Ollama           │              │
│  │  Parse text + tool calls + memory  │              │
│  │  Execute tools (10 concurrent max) │              │
│  │  Ingest <memory_update> blocks     │              │
│  │  Summarize at 70% token pressure   │              │
│  └────────────────────────────────────┘              │
│                                                      │
│  Session checkpoints · cost tracking · webhooks      │
└──────┬───────────────────────┬───────────────────────┘
       │                       │
       ▼                       ▼
┌─────────────────┐   ┌──────────────────────────────┐
│  SQLite stores  │   │  Model providers             │
│  memory/<k>.db  │   │  OpenRouter (100+ models)    │
│  sessions/      │   │  Ollama (local)              │
│  skills.sqlite  │   │  OMLS LoRA adapter (local)   │
└─────────────────┘   └──────────────────────────────┘
```

### Storage layout

```
~/.orager/
  memory/<memoryKey>.sqlite     # per-namespace memory (FTS5 + sqlite-vec ANN)
  skills/skills.sqlite          # SkillBank — captured task patterns
  sessions/
    index.sqlite                # session metadata + full-text search
    <sessionId>.jsonl           # append-only turn transcripts
  models/<key>/<model>/
    adapter.safetensors         # current trained LoRA adapter
    adapter.v<N>.safetensors    # archived previous versions (for rollback)
    adapter.meta.json           # version, backend, training metadata
```

---

## Development

```bash
git clone https://github.com/JayCodesX/orager
cd orager && bun install

bun test ./tests/some-file.test.ts   # run targeted test file
bun run test:bun                     # full unit test suite
bun run test:bun:int                 # integration tests
bun run typecheck
```

---

## Roadmap

- **Orager Cloud** — managed agents, hosted memory, zero infra
- **SkillBank Pro** — shared skills across teams + OMLS training jobs
- **Skill Marketplace** — publish and subscribe to community skill packs
- **Enterprise** — self-hosted deployment, SSO, audit logs, SLA

[Join the waitlist →](https://oragerai.com)

---

## License

MIT — see [LICENSE](./LICENSE)
