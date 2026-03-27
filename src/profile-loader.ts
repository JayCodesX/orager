/**
 * Loads custom agent profiles from ~/.orager/profiles/ (or ORAGER_PROFILES_DIR).
 *
 * File format: JSON (.json) or YAML (.yaml / .yml).
 * Each file defines one profile. The filename (without extension) is the profile name.
 *
 * Required fields: description, appendSystemPrompt
 * Optional fields: maxTurns, summarizeAt, tagToolOutputs, trackFileChanges,
 *                  maxIdenticalToolCallTurns, bashPolicy
 *
 * Built-in profiles take precedence over custom ones with the same name.
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export interface CustomProfileDefaults {
  description: string;
  appendSystemPrompt: string;
  /** Name of a built-in or custom profile to inherit defaults from. */
  extends?: string;
  maxTurns?: number;
  summarizeAt?: number;
  tagToolOutputs?: boolean;
  trackFileChanges?: boolean;
  maxIdenticalToolCallTurns?: number;
  bashPolicy?: {
    blockedCommands?: string[];
    stripEnvKeys?: string[];
    isolateEnv?: boolean;
    allowedEnvKeys?: string[];
  };
  planMode?: boolean;
  requireApproval?: string[] | "all";
  models?: string[];
  summarizeModel?: string;
  summarizePrompt?: string;
  webhookUrl?: string;
}

export type CustomProfiles = Record<string, CustomProfileDefaults>;

/** Directory where custom profile files are loaded from. */
export function getProfilesDir(): string {
  return process.env["ORAGER_PROFILES_DIR"] ?? path.join(os.homedir(), ".orager", "profiles");
}

/** Parse a YAML file using a minimal parser for simple flat + nested structures. */
function parseMinimalYaml(content: string): Record<string, unknown> {
  // Use the yaml package if available (it's a transitive dep of several tools)
  // Fall back to JSON parsing if the file is actually JSON
  try {
    // Try to dynamically import 'yaml' (available as transitive dep)
    // We parse synchronously using eval-free approach
    return parseYamlSync(content);
  } catch {
    return {};
  }
}

function parseYamlSync(content: string): Record<string, unknown> {
  // Minimal YAML parser for profile files:
  // Supports: string values, numbers, booleans, arrays, nested objects (2-level)
  const result: Record<string, unknown> = {};
  const lines = content.split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith("#")) { i++; continue; }

    const topMatch = line.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
    if (!topMatch) { i++; continue; }

    const key = topMatch[1];
    const rest = topMatch[2].trim();

    if (rest === "" || rest === "|" || rest === ">") {
      // Could be a block scalar or an object/array — look ahead
      const children: Record<string, unknown> = {};
      const arrayItems: unknown[] = [];
      const baseIndent = line.match(/^(\s*)/)?.[1].length ?? 0;
      i++;
      let isArray = false;

      while (i < lines.length) {
        const child = lines[i];
        if (!child.trim()) { i++; continue; }
        const childIndent = child.match(/^(\s*)/)?.[1].length ?? 0;
        if (childIndent <= baseIndent) break;

        if (child.trimStart().startsWith("- ")) {
          isArray = true;
          const itemVal = child.trimStart().slice(2).trim();
          arrayItems.push(parseScalar(itemVal));
          i++;
          continue;
        }

        const childMatch = child.match(/^\s+(\w[\w-]*)\s*:\s*(.*)$/);
        if (childMatch) {
          children[childMatch[1]] = parseScalar(childMatch[2].trim());
        }
        i++;
      }

      result[key] = isArray ? arrayItems : (Object.keys(children).length > 0 ? children : "");
    } else if (rest.startsWith("|")) {
      // Block scalar — collect indented lines
      const blockLines: string[] = [];
      const baseIndent2 = line.match(/^(\s*)/)?.[1].length ?? 0;
      i++;
      while (i < lines.length) {
        const bl = lines[i];
        const blIndent = bl.match(/^(\s*)/)?.[1].length ?? 0;
        if (bl.trim() && blIndent <= baseIndent2) break;
        blockLines.push(bl.trimStart());
        i++;
      }
      result[key] = blockLines.join("\n").trim();
    } else {
      result[key] = parseScalar(rest);
      i++;
    }
  }

  return result;
}

function parseScalar(s: string): unknown {
  if (!s) return "";
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  // Quoted string
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Load all custom profiles from the profiles directory.
 * Returns an empty object if the directory doesn't exist or on errors.
 */
export async function loadCustomProfiles(): Promise<CustomProfiles> {
  const dir = getProfilesDir();
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return {};
  }

  const profiles: CustomProfiles = {};

  for (const entry of entries) {
    if (!entry.match(/\.(json|ya?ml)$/i)) continue;
    const name = entry.replace(/\.(json|ya?ml)$/i, "");
    const filePath = path.join(dir, entry);

    try {
      const content = await fs.readFile(filePath, "utf8");
      let parsed: Record<string, unknown>;

      if (entry.toLowerCase().endsWith(".json")) {
        parsed = JSON.parse(content) as Record<string, unknown>;
      } else {
        // Try to use the yaml package (transitive dep)
        try {
          const yamlMod = await import("yaml");
          parsed = (yamlMod.parse(content) ?? {}) as Record<string, unknown>;
        } catch {
          parsed = parseMinimalYaml(content);
        }
      }

      if (typeof parsed["description"] !== "string") continue;
      if (typeof parsed["appendSystemPrompt"] !== "string") continue;

      // Warn about type mismatches in optional fields
      if (parsed["maxTurns"] !== undefined && typeof parsed["maxTurns"] !== "number") {
        process.stderr.write(`[orager] WARNING: profile '${name}' field 'maxTurns' must be a number, got ${typeof parsed["maxTurns"]} — ignoring\n`);
      }
      if (parsed["summarizeAt"] !== undefined && typeof parsed["summarizeAt"] !== "number") {
        process.stderr.write(`[orager] WARNING: profile '${name}' field 'summarizeAt' must be a number, got ${typeof parsed["summarizeAt"]} — ignoring\n`);
      }
      if (parsed["maxIdenticalToolCallTurns"] !== undefined && typeof parsed["maxIdenticalToolCallTurns"] !== "number") {
        process.stderr.write(`[orager] WARNING: profile '${name}' field 'maxIdenticalToolCallTurns' must be a number, got ${typeof parsed["maxIdenticalToolCallTurns"]} — ignoring\n`);
      }

      const profile: CustomProfileDefaults = {
        description: parsed["description"] as string,
        appendSystemPrompt: parsed["appendSystemPrompt"] as string,
      };

      if (typeof parsed["maxTurns"] === "number") profile.maxTurns = parsed["maxTurns"] as number;
      if (typeof parsed["summarizeAt"] === "number") profile.summarizeAt = parsed["summarizeAt"] as number;
      if (parsed["tagToolOutputs"] === true) profile.tagToolOutputs = true;
      if (parsed["trackFileChanges"] === true) profile.trackFileChanges = true;
      if (typeof parsed["maxIdenticalToolCallTurns"] === "number") {
        profile.maxIdenticalToolCallTurns = parsed["maxIdenticalToolCallTurns"] as number;
      }
      if (parsed["bashPolicy"] && typeof parsed["bashPolicy"] === "object") {
        profile.bashPolicy = parsed["bashPolicy"] as CustomProfileDefaults["bashPolicy"];
      }
      if (parsed["planMode"] === true) profile.planMode = true;
      if (parsed["requireApproval"] === "all") {
        profile.requireApproval = "all";
      } else if (Array.isArray(parsed["requireApproval"])) {
        profile.requireApproval = (parsed["requireApproval"] as unknown[]).filter((s): s is string => typeof s === "string");
      }
      if (Array.isArray(parsed["models"])) {
        profile.models = (parsed["models"] as unknown[]).filter((s): s is string => typeof s === "string");
      }
      if (typeof parsed["summarizeModel"] === "string") profile.summarizeModel = parsed["summarizeModel"] as string;
      if (typeof parsed["summarizePrompt"] === "string") profile.summarizePrompt = parsed["summarizePrompt"] as string;
      if (typeof parsed["webhookUrl"] === "string") profile.webhookUrl = parsed["webhookUrl"] as string;
      if (typeof parsed["extends"] === "string" && parsed["extends"]) profile.extends = parsed["extends"] as string;

      profiles[name] = profile;
    } catch {
      // Skip malformed profile files
    }
  }

  // ── Resolve extends ──────────────────────────────────────────────────────
  // After all profiles are loaded, merge parent defaults into children.
  // Built-in profiles take precedence as parents only (they can't extend themselves).
  return resolveProfileExtends(profiles);
}

/**
 * Resolve `extends` chains for custom profiles.
 * Child fields override parent fields; appendSystemPrompt is concatenated parent + child.
 * Cycle detection prevents infinite loops.
 */
function resolveProfileExtends(profiles: CustomProfiles): CustomProfiles {
  // Lazy import to avoid circular module dependency at top level
  // We access built-in profiles by name via a local import
  const resolved: CustomProfiles = {};

  function getBuiltinDefaults(name: string): Partial<CustomProfileDefaults> | null {
    // Inline the built-in profile fields we care about for inheritance
    // (we can't import profiles.ts here without a circular dep, so we use a local map)
    const BUILTIN_INHERITABLE: Record<string, Partial<CustomProfileDefaults>> = {
      "code-review": { maxTurns: 20, tagToolOutputs: true, maxIdenticalToolCallTurns: 3 },
      "bug-fix":     { maxTurns: 30, trackFileChanges: true, tagToolOutputs: true, maxIdenticalToolCallTurns: 4, summarizeAt: 0.7 },
      "research":    { maxTurns: 25, tagToolOutputs: true, maxIdenticalToolCallTurns: 3 },
      "refactor":    { maxTurns: 50, trackFileChanges: true, tagToolOutputs: true, maxIdenticalToolCallTurns: 5, summarizeAt: 0.65 },
      "test-writer": { maxTurns: 30, trackFileChanges: true, maxIdenticalToolCallTurns: 4 },
      "devops":      { maxTurns: 40, trackFileChanges: true, tagToolOutputs: true, maxIdenticalToolCallTurns: 5, summarizeAt: 0.7 },
    };
    return BUILTIN_INHERITABLE[name] ?? null;
  }

  function resolveOne(name: string, visited: Set<string>): CustomProfileDefaults {
    if (resolved[name]) return resolved[name]!;

    const profile = profiles[name];
    if (!profile) throw new Error(`Profile '${name}' not found`);

    const parentName = profile.extends;
    if (!parentName) {
      resolved[name] = profile;
      return profile;
    }

    if (visited.has(name)) {
      // Cycle detected — skip extends for this profile
      process.stderr.write(`[orager] WARNING: profile '${name}' has a circular extends chain — ignoring 'extends'\n`);
      const { extends: _ext, ...rest } = profile;
      void _ext;
      resolved[name] = rest;
      return rest;
    }

    visited.add(name);

    // Get parent: custom profile first, then built-in
    let parentDefaults: Partial<CustomProfileDefaults>;
    if (profiles[parentName]) {
      const parent = resolveOne(parentName, visited);
      parentDefaults = parent;
    } else {
      const builtin = getBuiltinDefaults(parentName);
      if (!builtin) {
        process.stderr.write(`[orager] WARNING: profile '${name}' extends unknown profile '${parentName}' — ignoring 'extends'\n`);
        const { extends: _ext, ...rest } = profile;
        void _ext;
        resolved[name] = rest;
        return rest;
      }
      parentDefaults = builtin;
    }

    // Merge: parent defaults first, child overrides, appendSystemPrompt concatenated
    const mergedAppendSystemPrompt = [parentDefaults.appendSystemPrompt, profile.appendSystemPrompt]
      .filter(Boolean)
      .join("\n\n");

    const merged: CustomProfileDefaults = {
      ...parentDefaults,
      ...profile,
      appendSystemPrompt: mergedAppendSystemPrompt,
    };
    // Remove extends from the resolved profile — it's already been applied
    delete (merged as Partial<CustomProfileDefaults>).extends;

    resolved[name] = merged;
    return merged;
  }

  for (const name of Object.keys(profiles)) {
    try {
      resolveOne(name, new Set());
    } catch {
      resolved[name] = profiles[name]!;
    }
  }

  return resolved;
}
