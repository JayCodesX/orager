import { describe, it, expect } from "vitest";
import { formatContext } from "../src/context-injector.js";
import type { InjectedContext } from "../src/context-injector.js";

describe("formatContext", () => {
  it("includes all fields when all are present", () => {
    const ctx: InjectedContext = {
      gitBranch: "main",
      gitStatus: "M src/foo.ts",
      recentCommits: "abc123 fix: something",
      packageName: "my-app",
      packageVersion: "1.2.3",
      dirListing: "src  tests  package.json",
    };
    const result = formatContext(ctx);
    expect(result).toContain("[Auto-injected context]");
    expect(result).toContain("Project: my-app v1.2.3");
    expect(result).toContain("Branch: main");
    expect(result).toContain("Git status:");
    expect(result).toContain("M src/foo.ts");
    expect(result).toContain("Recent commits:");
    expect(result).toContain("abc123 fix: something");
    expect(result).toContain("Directory: src  tests  package.json");
  });

  it("omits missing/undefined fields gracefully", () => {
    const ctx: InjectedContext = {
      gitBranch: "feature/x",
      // no gitStatus, recentCommits, packageName, packageVersion, dirListing
    };
    const result = formatContext(ctx);
    expect(result).toContain("[Auto-injected context]");
    expect(result).toContain("Branch: feature/x");
    expect(result).not.toContain("Git status:");
    expect(result).not.toContain("Recent commits:");
    expect(result).not.toContain("Project:");
    expect(result).not.toContain("Directory:");
  });

  it("returns at least the header line for an empty context", () => {
    const ctx: InjectedContext = {};
    const result = formatContext(ctx);
    expect(result).toBe("[Auto-injected context]");
  });

  it("omits version when packageVersion is not set", () => {
    const ctx: InjectedContext = { packageName: "my-lib" };
    const result = formatContext(ctx);
    expect(result).toContain("Project: my-lib");
    expect(result).not.toContain("v");
  });

  it("includes version when both packageName and packageVersion are set", () => {
    const ctx: InjectedContext = { packageName: "my-lib", packageVersion: "0.5.0" };
    const result = formatContext(ctx);
    expect(result).toContain("Project: my-lib v0.5.0");
  });
});
