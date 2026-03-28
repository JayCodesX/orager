/**
 * Tests for loadCustomProfiles and getProfilesDir — verifies that the function
 * re-reads ORAGER_PROFILES_DIR on each invocation (no module-level cache) so
 * changing the env var mid-process picks up the new directory immediately.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadCustomProfiles, getProfilesDir } from "../src/profile-loader.js";

// ── getProfilesDir dynamic resolution ────────────────────────────────────────

describe("getProfilesDir — re-reads env var on every call", () => {
  const _original = process.env["ORAGER_PROFILES_DIR"];

  afterEach(() => {
    if (_original === undefined) delete process.env["ORAGER_PROFILES_DIR"];
    else process.env["ORAGER_PROFILES_DIR"] = _original;
  });

  it("returns default ~/.orager/profiles when env var is not set", () => {
    delete process.env["ORAGER_PROFILES_DIR"];
    const dir = getProfilesDir();
    expect(dir).toBe(path.join(os.homedir(), ".orager", "profiles"));
  });

  it("returns the custom dir when ORAGER_PROFILES_DIR is set", () => {
    process.env["ORAGER_PROFILES_DIR"] = "/tmp/my-profiles";
    expect(getProfilesDir()).toBe("/tmp/my-profiles");
  });

  it("reflects a mid-test env change immediately (no module-level cache)", () => {
    process.env["ORAGER_PROFILES_DIR"] = "/tmp/dir-a";
    expect(getProfilesDir()).toBe("/tmp/dir-a");
    process.env["ORAGER_PROFILES_DIR"] = "/tmp/dir-b";
    expect(getProfilesDir()).toBe("/tmp/dir-b");
  });
});

// ── loadCustomProfiles cache-busting ─────────────────────────────────────────

describe("loadCustomProfiles — reads from ORAGER_PROFILES_DIR on each call (T-gap1)", () => {
  const _original = process.env["ORAGER_PROFILES_DIR"];
  const tmpDirs: string[] = [];

  afterEach(async () => {
    if (_original === undefined) delete process.env["ORAGER_PROFILES_DIR"];
    else process.env["ORAGER_PROFILES_DIR"] = _original;
    for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it("returns empty object for a non-existent directory", async () => {
    process.env["ORAGER_PROFILES_DIR"] = "/tmp/__orager_nonexistent_profiles_dir_xyz__";
    const profiles = await loadCustomProfiles();
    expect(Object.keys(profiles)).toHaveLength(0);
  });

  it("loads profiles from ORAGER_PROFILES_DIR when set", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orager-profiles-t1-"));
    tmpDirs.push(dir);
    await fs.writeFile(
      path.join(dir, "my-profile.json"),
      JSON.stringify({
        description: "My custom profile",
        appendSystemPrompt: "You are a custom assistant.",
        maxTurns: 15,
      }),
    );

    process.env["ORAGER_PROFILES_DIR"] = dir;
    const profiles = await loadCustomProfiles();
    expect(profiles["my-profile"]).toBeDefined();
    expect(profiles["my-profile"]!.description).toBe("My custom profile");
    expect(profiles["my-profile"]!.maxTurns).toBe(15);
  });

  it("changing ORAGER_PROFILES_DIR between calls reads from the new directory (no cache)", async () => {
    const dir1 = await fs.mkdtemp(path.join(os.tmpdir(), "orager-profiles-t2a-"));
    const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), "orager-profiles-t2b-"));
    tmpDirs.push(dir1, dir2);

    await fs.writeFile(
      path.join(dir1, "alpha.json"),
      JSON.stringify({ description: "Alpha", appendSystemPrompt: "Alpha system prompt" }),
    );
    await fs.writeFile(
      path.join(dir2, "beta.json"),
      JSON.stringify({ description: "Beta", appendSystemPrompt: "Beta system prompt" }),
    );

    // First call reads from dir1 — should find alpha, not beta
    process.env["ORAGER_PROFILES_DIR"] = dir1;
    const profiles1 = await loadCustomProfiles();
    expect(profiles1["alpha"]).toBeDefined();
    expect(profiles1["beta"]).toBeUndefined();

    // Change env var — second call reads from dir2 — should find beta, not alpha
    process.env["ORAGER_PROFILES_DIR"] = dir2;
    const profiles2 = await loadCustomProfiles();
    expect(profiles2["beta"]).toBeDefined();
    expect(profiles2["alpha"]).toBeUndefined();
  });

  it("ignores files that are not .json/.yaml/.yml", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orager-profiles-t3-"));
    tmpDirs.push(dir);
    await fs.writeFile(path.join(dir, "not-a-profile.txt"), "some text");
    await fs.writeFile(
      path.join(dir, "valid.json"),
      JSON.stringify({ description: "Valid", appendSystemPrompt: "Valid" }),
    );

    process.env["ORAGER_PROFILES_DIR"] = dir;
    const profiles = await loadCustomProfiles();
    expect(profiles["not-a-profile"]).toBeUndefined();
    expect(profiles["valid"]).toBeDefined();
  });

  it("skips profile files missing required fields (description, appendSystemPrompt)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orager-profiles-t4-"));
    tmpDirs.push(dir);
    // Missing appendSystemPrompt
    await fs.writeFile(
      path.join(dir, "incomplete.json"),
      JSON.stringify({ description: "Missing system prompt" }),
    );
    // Valid
    await fs.writeFile(
      path.join(dir, "complete.json"),
      JSON.stringify({ description: "Complete", appendSystemPrompt: "Complete system prompt" }),
    );

    process.env["ORAGER_PROFILES_DIR"] = dir;
    const profiles = await loadCustomProfiles();
    expect(profiles["incomplete"]).toBeUndefined();
    expect(profiles["complete"]).toBeDefined();
  });
});
