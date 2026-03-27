import { describe, it, expect } from "vitest";
import { applyProfile, listProfiles, getProfile } from "../src/profiles.js";
import type { AgentLoopOptions } from "../src/types.js";

// Minimal valid AgentLoopOptions for testing purposes
function baseOpts(overrides: Partial<AgentLoopOptions> = {}): AgentLoopOptions {
  return {
    prompt: "do something",
    model: "openai/gpt-4o",
    apiKey: "test-key",
    sessionId: null,
    addDirs: [],
    maxTurns: 10,
    cwd: "/tmp",
    dangerouslySkipPermissions: false,
    verbose: false,
    onEmit: () => {},
    ...overrides,
  };
}

describe("listProfiles", () => {
  it("returns all 6 built-in profiles", () => {
    const profiles = listProfiles();
    expect(profiles).toHaveLength(6);
    const names = profiles.map((p) => p.name);
    expect(names).toContain("code-review");
    expect(names).toContain("bug-fix");
    expect(names).toContain("research");
    expect(names).toContain("refactor");
    expect(names).toContain("test-writer");
    expect(names).toContain("devops");
  });

  it("each profile has a non-empty description", () => {
    for (const p of listProfiles()) {
      expect(p.description.length).toBeGreaterThan(0);
    }
  });
});

describe("applyProfile", () => {
  it("sets profile-only fields that caller did not supply", () => {
    const opts = applyProfile("code-review", baseOpts());
    // tagToolOutputs and maxIdenticalToolCallTurns are NOT in baseOpts, so profile wins
    expect(opts.tagToolOutputs).toBe(true);
    expect(opts.maxIdenticalToolCallTurns).toBe(3);
    expect(opts.appendSystemPrompt).toContain("code review");
  });

  it("caller opts override profile defaults", () => {
    // baseOpts() has maxTurns: 10; profile default is 20 — caller wins
    const opts = applyProfile("code-review", baseOpts());
    expect(opts.maxTurns).toBe(10);

    // Explicit override also wins
    const opts2 = applyProfile("bug-fix", baseOpts({ maxTurns: 99 }));
    expect(opts2.maxTurns).toBe(99);
  });

  it("merges appendSystemPrompt — does not drop profile text when caller adds more", () => {
    const opts = applyProfile("bug-fix", baseOpts({ appendSystemPrompt: "extra instructions" }));
    expect(opts.appendSystemPrompt).toContain("fixing a bug");
    expect(opts.appendSystemPrompt).toContain("extra instructions");
  });

  it("does not produce duplicate keys in the returned object", () => {
    const opts = applyProfile("refactor", baseOpts());
    // Object.keys gives enumerable own keys — there should be no duplicates
    const keys = Object.keys(opts);
    const uniqueKeys = new Set(keys);
    expect(keys.length).toBe(uniqueKeys.size);
  });

  it("profile appendSystemPrompt appears only once when caller has no extra prompt", () => {
    const opts = applyProfile("research", baseOpts());
    const profileText = getProfile("research").appendSystemPrompt;
    // The profile text should appear exactly once
    const occurrences = (opts.appendSystemPrompt ?? "").split(profileText).length - 1;
    expect(occurrences).toBe(1);
  });
});
