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

---

### `omls`

Configure the Opportunistic Model Learning System (ADR-0007). This feature trains LoRA adapters from your usage patterns.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `false` | Enable OMLS. Disabled by default |

Use `orager skill-train` to manage training runs manually.

---

### `telemetry`

Configure OpenTelemetry trace and metric export. Disabled by default.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `false` | Enable OTLP trace/metric export |
| `endpoint` | `string` | — | OTLP HTTP endpoint (e.g. `http://localhost:4318`). Overrides `OTEL_EXPORTER_OTLP_ENDPOINT` |

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
