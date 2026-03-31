import { describe, it, expect } from "vitest";
import { repoSlug, buildMemoryKeyFromRepo } from "../src/memory.js";

describe("repoSlug", () => {
  it("strips https scheme and converts special chars to underscores", () => {
    expect(repoSlug("https://github.com/JayCodesX/orager")).toBe(
      "github_com_JayCodesX_orager",
    );
  });

  it("strips http scheme", () => {
    expect(repoSlug("http://gitlab.internal/team/repo.git")).toBe(
      "gitlab_internal_team_repo_git",
    );
  });

  it("collapses repeated underscores", () => {
    expect(repoSlug("https://example.com///multi///slash")).toBe(
      "example_com_multi_slash",
    );
  });

  it("trims leading and trailing underscores", () => {
    expect(repoSlug("https:///leading")).toBe("leading");
  });

  it("truncates to 64 characters", () => {
    const longUrl = "https://github.com/" + "a".repeat(200);
    expect(repoSlug(longUrl).length).toBeLessThanOrEqual(64);
  });

  it("returns empty string for scheme-only URL", () => {
    expect(repoSlug("https://")).toBe("");
  });
});

describe("buildMemoryKeyFromRepo", () => {
  it("returns agentId when repoUrl is null", () => {
    expect(buildMemoryKeyFromRepo("agent-1", null)).toBe("agent-1");
  });

  it("returns agentId when repoUrl is empty string", () => {
    expect(buildMemoryKeyFromRepo("agent-1", "")).toBe("agent-1");
  });

  it("appends repo slug for a full GitHub URL", () => {
    expect(
      buildMemoryKeyFromRepo("agent-1", "https://github.com/JayCodesX/orager"),
    ).toBe("agent-1_github_com_JayCodesX_orager");
  });

  it("truncates total key to 128 chars", () => {
    const longAgent = "a".repeat(100);
    const longUrl = "https://github.com/" + "x".repeat(200);
    const key = buildMemoryKeyFromRepo(longAgent, longUrl);
    expect(key.length).toBeLessThanOrEqual(128);
  });

  it("falls back to agentId when slug is empty after sanitisation", () => {
    expect(buildMemoryKeyFromRepo("agent-1", "https://")).toBe("agent-1");
  });

  it("handles URLs with multiple special characters", () => {
    const key = buildMemoryKeyFromRepo(
      "bot",
      "ssh://git@github.com:8080/org/repo.git",
    );
    expect(key).toMatch(/^bot_/);
    expect(key).not.toMatch(/[^a-zA-Z0-9_-]/);
  });
});
