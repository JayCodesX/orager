/**
 * Built-in agent profiles — opinionated presets for common task types.
 *
 * A profile bundles: system prompt addendum, recommended tools to enable/disable,
 * suggested model tier, maxTurns, bashPolicy, and other AgentLoopOptions defaults.
 *
 * Usage:
 *   import { applyProfile } from "./profiles.js";
 *   const opts = applyProfile("code-review", { apiKey, model, prompt, onEmit });
 */
import type { AgentLoopOptions, BashPolicy } from "./types.js";

export type ProfileName =
  | "code-review"
  | "bug-fix"
  | "research"
  | "refactor"
  | "test-writer"
  | "devops";

interface ProfileDefaults {
  appendSystemPrompt: string;
  description: string;
  maxTurns?: number;
  bashPolicy?: BashPolicy;
  tagToolOutputs?: boolean;
  trackFileChanges?: boolean;
  maxIdenticalToolCallTurns?: number;
  summarizeAt?: number;
  planMode?: boolean;
  requireApproval?: string[] | "all";
  models?: string[];
  summarizeModel?: string;
  summarizePrompt?: string;
  webhookUrl?: string;
}

const PROFILES: Record<ProfileName, ProfileDefaults> = {
  "code-review": {
    description: "Read-only analysis: review code for bugs, style, and improvements.",
    appendSystemPrompt:
      "You are performing a code review. Your task is to READ and ANALYZE only — do NOT modify any files. " +
      "Look for: bugs, security issues, performance problems, style violations, missing tests. " +
      "Provide a structured report with severity levels (critical/high/medium/low).",
    maxTurns: 20,
    bashPolicy: {
      blockedCommands: ["curl", "wget", "ssh", "nc", "socat", "git push", "rm", "mv"],
      stripEnvKeys: ["AWS_", "GITHUB_TOKEN", "SSH_AUTH_SOCK", "NPM_TOKEN"],
    },
    tagToolOutputs: true,
    maxIdenticalToolCallTurns: 3,
  },

  "bug-fix": {
    description: "Diagnose and fix a specific bug. Writes code, runs tests.",
    appendSystemPrompt:
      "You are fixing a bug. Follow this process: " +
      "1. Reproduce the bug (read relevant code, run failing tests). " +
      "2. Identify the root cause. " +
      "3. Implement a minimal, targeted fix. " +
      "4. Verify the fix (run tests). " +
      "5. Report what was changed and why. " +
      "Prefer surgical edits (edit_file) over full rewrites (write_file).",
    maxTurns: 30,
    bashPolicy: {
      blockedCommands: ["curl", "wget", "ssh"],
      stripEnvKeys: ["AWS_", "SSH_AUTH_SOCK"],
    },
    trackFileChanges: true,
    tagToolOutputs: true,
    maxIdenticalToolCallTurns: 4,
    summarizeAt: 0.7,
  },

  "research": {
    description: "Web research and information gathering. Summarizes findings.",
    appendSystemPrompt:
      "You are a research agent. Use web_search and web_fetch to gather information. " +
      "Cross-reference multiple sources. Be skeptical of single-source claims. " +
      "Provide a well-structured summary with citations (URLs) for all key claims. " +
      "Do NOT modify any local files unless explicitly asked.",
    maxTurns: 25,
    bashPolicy: {
      blockedCommands: ["rm", "mv", "cp", "git"],
      isolateEnv: true,
    },
    tagToolOutputs: true,
    maxIdenticalToolCallTurns: 3,
  },

  "refactor": {
    description: "Large-scale code refactoring across multiple files.",
    appendSystemPrompt:
      "You are refactoring code. Follow this process: " +
      "1. Understand the current structure (read all relevant files first). " +
      "2. Plan the changes before making any edits. " +
      "3. Use edit_files for multi-file atomic changes where possible. " +
      "4. Run tests after each logical batch of changes. " +
      "5. Keep commits small and focused. " +
      "Preserve all existing behavior unless explicitly asked to change it.",
    maxTurns: 50,
    bashPolicy: {
      blockedCommands: ["curl", "wget"],
      stripEnvKeys: ["AWS_", "SSH_AUTH_SOCK"],
    },
    trackFileChanges: true,
    tagToolOutputs: true,
    maxIdenticalToolCallTurns: 5,
    summarizeAt: 0.65,
  },

  "test-writer": {
    description: "Write tests for existing code. Coverage-focused.",
    appendSystemPrompt:
      "You are writing tests. Follow this process: " +
      "1. Read the source code to understand what needs testing. " +
      "2. Read existing tests to understand the testing patterns used. " +
      "3. Write comprehensive tests: happy path, edge cases, error cases. " +
      "4. Run the tests to verify they pass. " +
      "Prefer testing behavior over implementation details. " +
      "Do NOT modify source files — only create or edit test files.",
    maxTurns: 30,
    bashPolicy: {
      blockedCommands: ["curl", "wget", "ssh", "git push"],
      stripEnvKeys: ["AWS_", "SSH_AUTH_SOCK"],
    },
    trackFileChanges: true,
    maxIdenticalToolCallTurns: 4,
  },

  "devops": {
    description: "Infrastructure, deployment, and operational tasks.",
    appendSystemPrompt:
      "You are performing devops tasks. Be cautious with destructive operations. " +
      "Always confirm what a command does before running it in production. " +
      "Prefer dry-run flags (--dry-run, -n, --check) when available. " +
      "Log every significant action you take.",
    maxTurns: 40,
    trackFileChanges: true,
    tagToolOutputs: true,
    maxIdenticalToolCallTurns: 5,
    summarizeAt: 0.7,
  },
};

/**
 * Return the defaults for a named profile.
 */
export function getProfile(name: ProfileName): ProfileDefaults {
  return PROFILES[name];
}

/**
 * Apply a profile's defaults to an AgentLoopOptions object.
 * Explicit values in `opts` take precedence over profile defaults.
 */
export function applyProfile(
  profileName: ProfileName | string,
  opts: AgentLoopOptions,
): AgentLoopOptions {
  const profile = PROFILES[profileName as ProfileName];
  if (!profile) {
    // Unknown built-in profile — return opts unchanged (caller may have custom profile)
    return opts;
  }
  const mergedAppendSystemPrompt = [profile.appendSystemPrompt, opts.appendSystemPrompt]
    .filter(Boolean)
    .join("\n\n");

  // Build profile defaults object first, then spread caller opts on top.
  // Caller opts win for all fields except appendSystemPrompt which is always merged.
  const profileDefaults: Partial<AgentLoopOptions> = {
    maxTurns:                  profile.maxTurns,
    bashPolicy:                profile.bashPolicy ? JSON.parse(JSON.stringify(profile.bashPolicy)) as BashPolicy : undefined,
    tagToolOutputs:            profile.tagToolOutputs,
    trackFileChanges:          profile.trackFileChanges,
    maxIdenticalToolCallTurns: profile.maxIdenticalToolCallTurns,
    summarizeAt:               profile.summarizeAt,
    planMode:                  profile.planMode,
    requireApproval:           Array.isArray(profile.requireApproval) ? [...profile.requireApproval] : profile.requireApproval,
    models:                    profile.models ? [...profile.models] : undefined,
    summarizeModel:            profile.summarizeModel,
    summarizePrompt:           profile.summarizePrompt,
    webhookUrl:                profile.webhookUrl,
    appendSystemPrompt:        mergedAppendSystemPrompt,
  };
  // Spread: profile defaults first, then caller opts override, then fix appendSystemPrompt
  const result: AgentLoopOptions = Object.assign({}, profileDefaults, opts, {
    appendSystemPrompt: mergedAppendSystemPrompt,
  }) as AgentLoopOptions;
  return result;
}

/**
 * Async variant of applyProfile that also searches custom profiles from
 * ~/.orager/profiles/ (or ORAGER_PROFILES_DIR).
 * Built-in profiles take precedence over custom ones with the same name.
 */
export async function applyProfileAsync(
  profileName: string,
  opts: AgentLoopOptions,
): Promise<AgentLoopOptions> {
  // Check built-in first
  if (profileName in PROFILES) {
    return applyProfile(profileName as ProfileName, opts);
  }
  // Check custom profiles
  const { loadCustomProfiles } = await import("./profile-loader.js");
  const customs = await loadCustomProfiles();
  const custom = customs[profileName];
  if (!custom) {
    // Log to stderr so operators can catch typos in profile names
    process.stderr.write(`[orager] WARNING: unknown profile '${profileName}' — no built-in or custom profile found. Running without profile.\n`);
    return opts;
  }
  const mergedAppendSystemPrompt = [custom.appendSystemPrompt, opts.appendSystemPrompt]
    .filter(Boolean)
    .join("\n\n");

  const profileDefaults: Partial<AgentLoopOptions> = {
    maxTurns:                  custom.maxTurns,
    bashPolicy:                custom.bashPolicy,
    tagToolOutputs:            custom.tagToolOutputs,
    trackFileChanges:          custom.trackFileChanges,
    maxIdenticalToolCallTurns: custom.maxIdenticalToolCallTurns,
    summarizeAt:               custom.summarizeAt,
    planMode:                  custom.planMode,
    requireApproval:           custom.requireApproval,
    models:                    custom.models,
    summarizeModel:            custom.summarizeModel,
    summarizePrompt:           custom.summarizePrompt,
    webhookUrl:                custom.webhookUrl,
    appendSystemPrompt:        mergedAppendSystemPrompt,
  };
  return Object.assign({}, profileDefaults, opts, {
    appendSystemPrompt: mergedAppendSystemPrompt,
  }) as AgentLoopOptions;
}

/** List all available profiles with their descriptions. */
export function listProfiles(): Array<{ name: ProfileName; description: string }> {
  return (Object.entries(PROFILES) as Array<[ProfileName, ProfileDefaults]>).map(
    ([name, p]) => ({ name, description: p.description }),
  );
}

/** List all profiles (built-in and custom) with their descriptions. */
export async function listAllProfiles(): Promise<Array<{ name: string; description: string; builtin: boolean }>> {
  const { loadCustomProfiles } = await import("./profile-loader.js");
  const customs = await loadCustomProfiles();
  const builtins = listProfiles().map((p) => ({ ...p, builtin: true }));
  const customList = Object.entries(customs)
    .filter(([name]) => !(name in PROFILES)) // don't duplicate built-ins
    .map(([name, p]) => ({ name, description: p.description, builtin: false }));
  return [...builtins, ...customList];
}
