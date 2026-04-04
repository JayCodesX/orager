# Configuration

orager uses two configuration files in `~/.orager/`:

| File | Purpose |
|------|---------|
| `settings.json` | Runtime behaviour, permissions, hooks, memory, SkillBank, OMLS, and telemetry |
| `model-meta-cache.json` | Cached model metadata (auto-managed, do not edit) |

## settings.json

The primary configuration file. All fields are optional — omitting a field uses the built-in default. Created by `orager setup`.

### Full example

```json
{
  "permissions": {
    "bash": "ask",
    "read_file": "allow",
    "write_file": "ask"
  },
  "bashPolicy": {
    "blockedCommands": ["rm -rf /", "sudo"],
    "stripEnvKeys": ["AWS_SECRET_ACCESS_KEY"],
    "allowNetwork": true
  },
  "hooks": {
    "pre_tool_call": "~/.orager/hooks/pre-tool.sh",
    "post_tool_call": "~/.orager/hooks/post-tool.sh"
  },
  "hooksEnabled": true,
  "memory": {
    "tokenPressureThreshold": 0.70,
    "turnInterval": 6,
    "keepRecentTurns": 4,
    "summarizationModel": "deepseek/deepseek-chat-v3-2"
  },
  "skillbank": {
    "enabled": true,
    "maxSkills": 500,
    "topK": 5,
    "retentionDays": 30,
    "autoExtract": true,
    "similarityThreshold": 0.65,
    "deduplicationThreshold": 0.92
  },
  "omls": {
    "enabled": false
  },
  "telemetry": {
    "enabled": false,
    "endpoint": "http://localhost:4318"
  },
  "providers": {
    "openrouter": {
      "siteUrl": "https://myapp.com",
      "siteName": "MyApp"
    },
    "ollama": {
      "enabled": false
    }
  }
}
```

### `permissions`

Controls whether tool calls require approval. Applies to any tool name as the key.

| Value | Behaviour |
|-------|-----------|
| `"allow"` | Execute without prompting |
| `"deny"` | Block the tool call |
| `"ask"` | Prompt the user before each call |

**Example:**
```json
{
  "permissions": {
    "bash": "ask",
    "write_file": "allow"
  }
}
```

---

### `bashPolicy`

Restrict what the Bash tool can do.

| Field | Type | Description |
|-------|------|-------------|
| `blockedCommands` | `string[]` | Shell fragments that are forbidden. Any command containing these strings is rejected |
| `stripEnvKeys` | `string[]` | Environment variable names to remove from the shell environment before executing |
| `allowedEnvKeys` | `string[]` | When set, only these env vars are passed to the shell (whitelist mode) |
| `isolateEnv` | `boolean` | Start with a clean environment (no inherited env vars) |
| `osSandbox` | `boolean` | Enable OS-level sandbox for Bash (macOS sandbox-exec on supported systems) |
| `allowNetwork` | `boolean` | Whether to allow network access from Bash commands. Default: `true` |

---

### `hooks`

Lifecycle hooks — shell scripts (or any executable) invoked at key points.

| Field | Description |
|-------|-------------|
| `pre_tool_call` | Path to script run before each tool call. Exit non-zero to abort the call |
| `post_tool_call` | Path to script run after each tool call |

The hook receives tool name and input as JSON on stdin.

| Field | Type | Description |
|-------|------|-------------|
| `hooksEnabled` | `boolean` | Master switch for all hooks. Default: `true` |

---

### `memory`

Tune the automatic context summarization behaviour.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `tokenPressureThreshold` | `number` | `0.70` | Fraction of the context window (0–1) at which summarization is triggered. Set to `0` to disable pressure-based summarization |
| `turnInterval` | `number` | `6` | Summarize every N turns regardless of token pressure. Set to `0` to disable turn-based summarization |
| `keepRecentTurns` | `number` | `4` | Number of recent assistant turns to keep intact (unsummarized) |
| `summarizationModel` | `string` | session model | Model to use for summarization. Defaults to the session's primary model |

---

### `skillbank`

Configure the SkillBank self-improvement system (ADR-0006).

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable or disable SkillBank entirely |
| `autoExtract` | `boolean` | `true` | Automatically extract skills at the end of successful runs |
| `maxSkills` | `number` | `500` | Maximum number of skills to retain |
| `topK` | `number` | `5` | Number of skills to inject into the system prompt per run |
| `similarityThreshold` | `number` | `0.65` | Cosine similarity threshold for skill retrieval |
| `deduplicationThreshold` | `number` | `0.92` | Cosine similarity above which two skills are considered duplicates |
| `retentionDays` | `number` | `30` | Days after which unused skills are pruned |
| `extractionModel` | `string` | session model | Model used to extract skills from run history |
| `mergeAt` | `number` | `100` | Live skill count at which the merge pipeline fires automatically. Set to `0` to disable. |
| `mergeThreshold` | `number` | `0.78` | Minimum cosine similarity to group two skills into a merge cluster |
| `mergeMinClusterSize` | `number` | `3` | Minimum cluster size before LLM synthesis is attempted |

Run `orager skills merge --dry-run` to preview clusters without writing, or `orager skills merge` to trigger a merge pass manually.

---

### `omls`

Configure the Opportunistic Model Learning System (ADR-0007). This feature trains LoRA adapters from your usage patterns.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `false` | Enable OMLS. Disabled by default |
| `mode` | `"prompt" \| "lora" \| "auto"` | `"auto"` | Learning mode. `prompt` = SkillBank only (no LoRA, no cloud spend). `lora` = always train adapters. `auto` = prompt until `autoLoraThreshold` skills, then LoRA. |
| `autoLoraThreshold` | `number` | `150` | Skill count at which `auto` mode transitions from prompt to LoRA training |
| `minBatchSize` | `number` | `8` | Minimum distillable trajectories required before a training run fires |
| `teacherModels` | `string[]` | `["deepseek/deepseek-r1", "qwen/qwen3-72b"]` | Frontier models used as oracles for distillation and PRM scoring |
| `schedule` | `string` | `*/15 * * * *` | Cron expression for the idle check |
| `sleepStart` | `string` | `"23:00"` | Start of guaranteed idle window (HH:MM, 24h) |
| `sleepEnd` | `string` | `"07:00"` | End of guaranteed idle window (HH:MM, 24h) |
| `idleThresholdMinutes` | `number` | `10` | Minutes of keyboard inactivity before training may start |

Use `orager skill-train --status` to see the current mode and buffer size, and `orager skill-train --rl` to trigger a training run manually.

---

### `telemetry`

Configure OpenTelemetry trace and metric export. Disabled by default.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `false` | Enable OTLP trace/metric export |
| `endpoint` | `string` | — | OTLP HTTP endpoint (e.g. `http://localhost:4318`). Overrides `OTEL_EXPORTER_OTLP_ENDPOINT` |

---

### `providers`

Scopes provider-specific configuration to its own namespace instead of polluting the root config (ADR-0010). All fields are optional — when absent, flat config fields (`apiKey`, `siteUrl`, `--ollama`, etc.) are used as fallback.

```json
{
  "providers": {
    "openrouter": {
      "apiKey": "sk-or-...",
      "apiKeys": ["sk-or-backup1", "sk-or-backup2"],
      "siteUrl": "https://myapp.com",
      "siteName": "MyApp",
      "preset": "my-preset",
      "transforms": ["middle-out"],
      "zdr": true,
      "dataCollection": "deny",
      "sort": "price",
      "quantizations": ["fp8"],
      "require_parameters": false
    },
    "anthropic": {
      "apiKey": "sk-ant-..."
    },
    "ollama": {
      "enabled": true,
      "baseUrl": "http://localhost:11434",
      "model": "qwen2.5:7b",
      "checkModel": true
    }
  }
}
```

#### `providers.openrouter`

OpenRouter-specific routing and attribution fields. Only relevant when using the OpenRouter gateway.

| Field | Type | Description |
|-------|------|-------------|
| `apiKey` | `string` | OpenRouter API key (lowest priority — env var and CLI flag override) |
| `apiKeys` | `string[]` | Additional keys for rotation on rate limits |
| `siteUrl` | `string` | Sent as `HTTP-Referer` for dashboard attribution |
| `siteName` | `string` | Sent as `X-Title` for dashboard display |
| `preset` | `string` | Named server-side config preset slug |
| `transforms` | `string[]` | Context transforms (e.g. `["middle-out"]`) |
| `zdr` | `boolean` | Zero Data Retention mode |
| `dataCollection` | `"allow" \| "deny"` | Data collection preference |
| `sort` | `"price" \| "throughput" \| "latency"` | Sort providers by this metric |
| `quantizations` | `string[]` | Allowed quantization levels |
| `require_parameters` | `boolean` | Only route to providers supporting all specified parameters |
| `provider` | `object` | Provider routing object (`order`, `ignore`, `only`, etc.) |

#### `providers.anthropic`

Anthropic Direct API configuration. When `apiKey` is set (or `ANTHROPIC_API_KEY` env var), requests for `anthropic/*` models bypass OpenRouter for lower latency and cost.

| Field | Type | Description |
|-------|------|-------------|
| `apiKey` | `string` | Anthropic API key (or use `ANTHROPIC_API_KEY` env var) |

#### `providers.ollama`

Ollama local inference backend. Routes LLM calls to a local Ollama server — no API key required.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `false` | Enable Ollama backend |
| `baseUrl` | `string` | `http://localhost:11434` | Ollama server URL (or `ORAGER_OLLAMA_BASE_URL` env var) |
| `model` | `string` | auto-mapped | Explicit Ollama model tag (overrides automatic HuggingFace→Ollama mapping) |
| `checkModel` | `boolean` | `true` | Verify model is pulled before starting a run |

::: tip Provider priority
When multiple providers are configured, orager resolves in this order:
1. **Ollama** — when explicitly enabled
2. **Anthropic Direct** — when model is `anthropic/*` and API key is set
3. **OpenRouter** — universal fallback
:::

---

## MCP Server Integration

orager reads MCP server configurations from `~/.claude/claude_desktop_config.json` automatically. Any servers configured in Claude Desktop are available as tool sources. No additional configuration is required.

## Profiles

Profiles are named presets stored in `~/.orager/profiles/` (or the directory set by `ORAGER_PROFILES_DIR`). A profile is a JSON file matching the `CliOptions` shape that overrides defaults for a class of tasks.

Built-in profile names: `code-review`, `bug-fix`, `research`, `refactor`, `test-writer`, `devops`.

Activate a profile:

```bash
orager run --profile code-review "Review the changes in the last commit"
```

## Custom Settings File

Pass a different settings file with `--settings-file`:

```bash
orager run --settings-file ./project-settings.json "prompt"
```

The allowed roots for `--settings-file` are controlled by `ORAGER_SETTINGS_ALLOWED_ROOTS` (colon-separated absolute paths). This prevents an untrusted `--settings-file` value from loading arbitrary files outside your project.
