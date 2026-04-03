/**
 * Loads ~/.orager/settings.json and merges it with runtime AgentLoopOptions.
 * Runtime options always take precedence over file config.
 *
 * Schema:
 * {
 *   "permissions": { "bash": "allow" | "deny" | "ask", ... },
 *   "bashPolicy": { "blockedCommands": [...], "isolateEnv": false, ... },
 *   "hooks": { "PreToolCall": "...", "PostToolCall": "...", ... },
 *   "hooksEnabled": true,
 *   "memory": {
 *     "tokenPressureThreshold": 0.70,
 *     "turnInterval": 6,
 *     "keepRecentTurns": 4,
 *     "summarizationModel": "openai/gpt-4o-mini"
 *   }
 * }
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { BashPolicy } from "./types.js";
import type { HookConfig } from "./hooks.js";
import type { McpServerConfig } from "./mcp-client.js";

/**
 * Structured memory configuration block in settings.json.
 * All fields are optional — omitting them uses the loop defaults.
 */
export interface MemoryConfig {
  /** Fraction of context window at which to trigger summarization (0–1). Default: 0.70. Set to 0 to disable. */
  tokenPressureThreshold?: number;
  /** Summarize every N turns regardless of token pressure. Default: 6. Set to 0 to disable. */
  turnInterval?: number;
  /** When summarizing, keep the last N assistant turns intact. Default: 4. */
  keepRecentTurns?: number;
  /** Model to use for summarization calls. Defaults to the session's primary model. */
  summarizationModel?: string;
}

/**
 * Telemetry / OpenTelemetry configuration.
 * Disabled by default — no spans are exported unless `enabled` is true.
 */
export interface TelemetryConfig {
  /**
   * Enable OTLP trace/metric export. Default: false.
   * When true, requires either `endpoint` here or OTEL_EXPORTER_OTLP_ENDPOINT env var.
   */
  enabled?: boolean;
  /**
   * OTLP HTTP endpoint to export to (e.g. "http://localhost:4318").
   * Overrides the OTEL_EXPORTER_OTLP_ENDPOINT environment variable.
   */
  endpoint?: string;
}

export interface OragerSettings {
  permissions?: Record<string, "allow" | "deny" | "ask">;
  bashPolicy?: BashPolicy;
  hooks?: HookConfig;
  hooksEnabled?: boolean;
  /** SkillBank configuration (ADR-0006). */
  skillbank?: import("./types.js").SkillBankConfig;
  /** OMLS opportunistic RL training configuration (ADR-0007). */
  omls?: import("./types.js").OmlsConfig;
  /** Memory system configuration — summarization thresholds, model overrides. */
  memory?: MemoryConfig;
  /** OpenTelemetry export configuration. Disabled by default. */
  telemetry?: TelemetryConfig;
}

interface CachedSettings {
  mtime: number;
  settings: OragerSettings;
}

const _cache = new Map<string, CachedSettings>();

const KNOWN_SETTINGS_KEYS = new Set(["permissions", "bashPolicy", "hooks", "hooksEnabled", "skillbank", "omls", "memory"]);
const KNOWN_MEMORY_KEYS = new Set(["tokenPressureThreshold", "turnInterval", "keepRecentTurns", "summarizationModel"]);
const KNOWN_BASH_POLICY_KEYS = new Set(["blockedCommands", "stripEnvKeys", "isolateEnv", "allowedEnvKeys", "osSandbox", "allowNetwork"]);
const KNOWN_SKILLBANK_KEYS = new Set(["enabled", "extractionModel", "maxSkills", "similarityThreshold", "deduplicationThreshold", "topK", "retentionDays", "autoExtract"]);
const KNOWN_TELEMETRY_KEYS = new Set(["enabled", "endpoint"]);

/**
 * Validate and sanitise a raw settings object.
 * Invalid values are removed (falling back to defaults) rather than crashing.
 * Returns the cleaned settings plus arrays of warnings and errors for callers
 * to surface to the user.
 */
export function validateSettings(
  raw: unknown,
  filePath = "settings.json",
): { settings: OragerSettings; warnings: string[]; errors: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    errors.push(`${filePath}: expected a JSON object at the top level`);
    return { settings: {}, warnings, errors };
  }

  const obj = raw as Record<string, unknown>;

  // ── Unknown top-level keys ───────────────────────────────────────────────
  for (const key of Object.keys(obj)) {
    if (!KNOWN_SETTINGS_KEYS.has(key)) {
      warnings.push(`unknown key '${key}' — did you mean one of: ${[...KNOWN_SETTINGS_KEYS].join(", ")}?`);
      delete obj[key];
    }
  }

  const settings: OragerSettings = obj as OragerSettings;

  // ── permissions ──────────────────────────────────────────────────────────
  if (settings.permissions !== undefined) {
    if (typeof settings.permissions !== "object" || settings.permissions === null) {
      warnings.push(`'permissions' must be an object — ignoring`);
      delete settings.permissions;
    } else {
      const VALID_PERMS = new Set<string>(["allow", "deny", "ask"]);
      const TOOL_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;
      for (const [tool, val] of Object.entries(settings.permissions)) {
        if (!VALID_PERMS.has(val as string)) {
          warnings.push(`invalid permission value '${String(val)}' for tool '${tool}' — ignoring (use "allow", "deny", or "ask")`);
          delete (settings.permissions as Record<string, string>)[tool];
        } else if (!TOOL_NAME_RE.test(tool)) {
          warnings.push(`permission key '${tool}' does not look like a tool name (expected snake_case identifier) — verify spelling`);
        }
      }
    }
  }

  // ── memory ───────────────────────────────────────────────────────────────
  if (settings.memory !== undefined) {
    if (typeof settings.memory !== "object" || settings.memory === null) {
      warnings.push(`'memory' must be an object — ignoring`);
      delete settings.memory;
    } else {
      const m = settings.memory as Record<string, unknown>;

      // Unknown keys
      for (const key of Object.keys(m)) {
        if (!KNOWN_MEMORY_KEYS.has(key)) {
          warnings.push(`unknown key 'memory.${key}'`);
        }
      }

      // tokenPressureThreshold: number 0–1
      if (m.tokenPressureThreshold !== undefined) {
        const v = m.tokenPressureThreshold;
        if (typeof v !== "number" || v < 0 || v > 1) {
          warnings.push(`'memory.tokenPressureThreshold' must be a number between 0 and 1 (got ${JSON.stringify(v)}) — using default`);
          delete m.tokenPressureThreshold;
        }
      }

      // turnInterval: number >= 0
      if (m.turnInterval !== undefined) {
        const v = m.turnInterval;
        if (typeof v !== "number" || v < 0 || !Number.isInteger(v)) {
          warnings.push(`'memory.turnInterval' must be a non-negative integer (got ${JSON.stringify(v)}) — using default`);
          delete m.turnInterval;
        }
      }

      // keepRecentTurns: number >= 1
      if (m.keepRecentTurns !== undefined) {
        const v = m.keepRecentTurns;
        if (typeof v !== "number" || v < 1 || !Number.isInteger(v)) {
          warnings.push(`'memory.keepRecentTurns' must be an integer >= 1 (got ${JSON.stringify(v)}) — using default`);
          delete m.keepRecentTurns;
        }
      }

      // summarizationModel: string
      if (m.summarizationModel !== undefined && typeof m.summarizationModel !== "string") {
        warnings.push(`'memory.summarizationModel' must be a string (got ${typeof m.summarizationModel}) — ignoring`);
        delete m.summarizationModel;
      }
    }
  }

  // ── bashPolicy ───────────────────────────────────────────────────────────
  if (settings.bashPolicy !== undefined) {
    if (typeof settings.bashPolicy !== "object" || settings.bashPolicy === null) {
      warnings.push(`'bashPolicy' must be an object — ignoring`);
      delete settings.bashPolicy;
    } else {
      for (const key of Object.keys(settings.bashPolicy as object)) {
        if (!KNOWN_BASH_POLICY_KEYS.has(key)) {
          warnings.push(`unknown key 'bashPolicy.${key}'`);
        }
      }
    }
  }

  // ── skillbank ────────────────────────────────────────────────────────────
  if (settings.skillbank !== undefined) {
    if (typeof settings.skillbank !== "object" || settings.skillbank === null) {
      warnings.push(`'skillbank' must be an object — ignoring`);
      delete settings.skillbank;
    } else {
      const sb = settings.skillbank as Record<string, unknown>;

      for (const key of Object.keys(sb)) {
        if (!KNOWN_SKILLBANK_KEYS.has(key)) {
          warnings.push(`unknown key 'skillbank.${key}'`);
        }
      }

      // similarityThreshold: 0–1
      if (sb.similarityThreshold !== undefined) {
        const v = sb.similarityThreshold;
        if (typeof v !== "number" || v < 0 || v > 1) {
          warnings.push(`'skillbank.similarityThreshold' must be between 0 and 1 (got ${JSON.stringify(v)}) — using default`);
          delete sb.similarityThreshold;
        }
      }

      // deduplicationThreshold: 0–1
      if (sb.deduplicationThreshold !== undefined) {
        const v = sb.deduplicationThreshold;
        if (typeof v !== "number" || v < 0 || v > 1) {
          warnings.push(`'skillbank.deduplicationThreshold' must be between 0 and 1 (got ${JSON.stringify(v)}) — using default`);
          delete sb.deduplicationThreshold;
        }
      }

      // topK: integer >= 1
      if (sb.topK !== undefined) {
        const v = sb.topK;
        if (typeof v !== "number" || v < 1 || !Number.isInteger(v)) {
          warnings.push(`'skillbank.topK' must be an integer >= 1 (got ${JSON.stringify(v)}) — using default`);
          delete sb.topK;
        }
      }

      // maxSkills: integer >= 1
      if (sb.maxSkills !== undefined) {
        const v = sb.maxSkills;
        if (typeof v !== "number" || v < 1 || !Number.isInteger(v)) {
          warnings.push(`'skillbank.maxSkills' must be an integer >= 1 (got ${JSON.stringify(v)}) — using default`);
          delete sb.maxSkills;
        }
      }
    }
  }

  // ── telemetry ────────────────────────────────────────────────────────────
  if (settings.telemetry !== undefined) {
    if (typeof settings.telemetry !== "object" || settings.telemetry === null) {
      warnings.push(`'telemetry' must be an object — ignoring`);
      delete settings.telemetry;
    } else {
      const t = settings.telemetry as Record<string, unknown>;

      for (const key of Object.keys(t)) {
        if (!KNOWN_TELEMETRY_KEYS.has(key)) {
          warnings.push(`unknown key 'telemetry.${key}'`);
        }
      }

      if (t.enabled !== undefined && typeof t.enabled !== "boolean") {
        warnings.push(`'telemetry.enabled' must be a boolean (got ${typeof t.enabled}) — ignoring`);
        delete t.enabled;
      }

      if (t.endpoint !== undefined) {
        if (typeof t.endpoint !== "string") {
          warnings.push(`'telemetry.endpoint' must be a string URL (got ${typeof t.endpoint}) — ignoring`);
          delete t.endpoint;
        } else if (!t.endpoint.startsWith("http://") && !t.endpoint.startsWith("https://")) {
          warnings.push(`'telemetry.endpoint' should be an HTTP/HTTPS URL (got '${t.endpoint}')`);
        }
      }
    }
  }

  return { settings, warnings, errors };
}

export async function loadSettings(settingsPath?: string): Promise<OragerSettings> {
  const filePath = settingsPath ?? path.join(os.homedir(), ".orager", "settings.json");
  try {
    const stat = await fs.stat(filePath);
    const mtime = stat.mtimeMs;
    const cached = _cache.get(filePath);
    if (cached && cached.mtime === mtime) return cached.settings;

    const raw = await fs.readFile(filePath, "utf8");

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      process.stderr.write(
        `[orager] ERROR: failed to parse ${filePath}: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}\n` +
        `[orager] Hint: validate your JSON at https://jsonlint.com — using empty settings\n`,
      );
      return {};
    }

    const { settings, warnings, errors } = validateSettings(parsed, filePath);

    for (const w of warnings) {
      process.stderr.write(`[orager] WARNING (${filePath}): ${w}\n`);
    }
    for (const e of errors) {
      process.stderr.write(`[orager] ERROR (${filePath}): ${e}\n`);
    }

    _cache.set(filePath, { mtime, settings });
    return settings;
  } catch {
    return {};
  }
}

/**
 * Read MCP server configs from ~/.claude/claude_desktop_config.json.
 * Returns an empty object if the file does not exist or cannot be parsed.
 * This mirrors Claude CLI behaviour: when no mcpServers are explicitly set,
 * use whatever the user has configured in their Claude Desktop installation.
 */
export async function loadClaudeDesktopMcpServers(
  configPath?: string,
): Promise<Record<string, McpServerConfig>> {
  const filePath = configPath ?? path.join(os.homedir(), ".claude", "claude_desktop_config.json");
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    if (!parsed.mcpServers || typeof parsed.mcpServers !== "object") return {};
    // Filter to entries that have at least a "command" string field
    const result: Record<string, McpServerConfig> = {};
    for (const [name, cfg] of Object.entries(parsed.mcpServers)) {
      if (cfg && typeof cfg === "object" && "command" in cfg && typeof (cfg as Record<string, unknown>).command === "string") {
        result[name] = cfg as McpServerConfig;
      }
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Merge file settings with runtime opts.
 * Runtime opts take precedence (override file config).
 */
export function mergeSettings<T extends {
  requireApproval?: string[] | "all";
  bashPolicy?: BashPolicy;
  hooks?: HookConfig;
}>(runtimeOpts: T, fileSettings: OragerSettings): T {
  const merged = { ...runtimeOpts };

  // requireApproval: runtime wins; file permissions fills in if runtime is unset
  if (merged.requireApproval === undefined && fileSettings.permissions) {
    const denyOrAsk = Object.entries(fileSettings.permissions)
      .filter(([, v]) => v === "deny" || v === "ask")
      .map(([k]) => k);
    if (denyOrAsk.length > 0) merged.requireApproval = denyOrAsk;
  }

  // bashPolicy: merge (runtime keys override file keys)
  if (fileSettings.bashPolicy) {
    merged.bashPolicy = { ...fileSettings.bashPolicy, ...merged.bashPolicy };
  }

  // hooks: merge (runtime keys override file keys)
  if (fileSettings.hooks && fileSettings.hooksEnabled !== false) {
    merged.hooks = { ...fileSettings.hooks, ...merged.hooks };
  }

  // skillbank: file settings fill in; runtime keys override
  if (fileSettings.skillbank && (merged as Record<string, unknown>).skillbank === undefined) {
    (merged as Record<string, unknown>).skillbank = fileSettings.skillbank;
  }

  // omls: file settings fill in; runtime keys override
  if (fileSettings.omls && (merged as Record<string, unknown>).omls === undefined) {
    (merged as Record<string, unknown>).omls = fileSettings.omls;
  }

  // memory: map MemoryConfig fields to their AgentLoopOptions equivalents.
  // File values only fill in when the runtime option is still at its default
  // (undefined), so explicit CLI flags always win.
  if (fileSettings.memory) {
    const m = fileSettings.memory;
    const r = merged as Record<string, unknown>;
    if (m.tokenPressureThreshold !== undefined && r["summarizeAt"] === undefined)
      r["summarizeAt"] = m.tokenPressureThreshold;
    if (m.turnInterval !== undefined && r["summarizeTurnInterval"] === undefined)
      r["summarizeTurnInterval"] = m.turnInterval;
    if (m.keepRecentTurns !== undefined && r["summarizeKeepRecentTurns"] === undefined)
      r["summarizeKeepRecentTurns"] = m.keepRecentTurns;
    if (m.summarizationModel !== undefined && r["summarizeModel"] === undefined)
      r["summarizeModel"] = m.summarizationModel;
  }

  return merged;
}
