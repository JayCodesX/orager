/**
 * Loads ~/.orager/settings.json and merges it with runtime AgentLoopOptions.
 * Runtime options always take precedence over file config.
 *
 * Schema:
 * {
 *   "permissions": { "bash": "allow" | "deny" | "ask", ... },
 *   "bashPolicy": { "blockedCommands": [...], "isolateEnv": false, ... },
 *   "hooks": { "PreToolCall": "...", "PostToolCall": "...", ... },
 *   "hooksEnabled": true
 * }
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { BashPolicy } from "./types.js";
import type { HookConfig } from "./hooks.js";
import type { McpServerConfig } from "./mcp-client.js";

export interface OragerSettings {
  permissions?: Record<string, "allow" | "deny" | "ask">;
  bashPolicy?: BashPolicy;
  hooks?: HookConfig;
  hooksEnabled?: boolean;
}

interface CachedSettings {
  mtime: number;
  settings: OragerSettings;
}

const _cache = new Map<string, CachedSettings>();

const KNOWN_SETTINGS_KEYS = new Set(["permissions", "bashPolicy", "hooks", "hooksEnabled"]);

export async function loadSettings(settingsPath?: string): Promise<OragerSettings> {
  const filePath = settingsPath ?? path.join(os.homedir(), ".orager", "settings.json");
  try {
    const stat = await fs.stat(filePath);
    const mtime = stat.mtimeMs;
    const cached = _cache.get(filePath);
    if (cached && cached.mtime === mtime) return cached.settings;
    const raw = await fs.readFile(filePath, "utf8");
    const settings = JSON.parse(raw) as OragerSettings;
    // Warn on unknown keys so operators catch typos early
    for (const key of Object.keys(settings)) {
      if (!KNOWN_SETTINGS_KEYS.has(key)) {
        process.stderr.write(`[orager] WARNING: unknown key '${key}' in settings file ${filePath} — did you mean one of: ${[...KNOWN_SETTINGS_KEYS].join(", ")}?\n`);
      }
    }
    // Validate permissions values — only "allow", "deny", "ask" are accepted.
    // Unknown values are dropped with a warning to prevent privilege escalation
    // from a hand-edited or malicious settings file.
    if (settings.permissions) {
      const VALID_PERMS = new Set<string>(["allow", "deny", "ask"]);
      for (const [tool, val] of Object.entries(settings.permissions)) {
        if (!VALID_PERMS.has(val)) {
          process.stderr.write(
            `[orager] WARNING: invalid permission value '${String(val)}' for tool '${tool}' in settings — ignoring (use "allow", "deny", or "ask")\n`,
          );
          delete (settings.permissions as Record<string, string>)[tool];
        }
      }
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

  return merged;
}
