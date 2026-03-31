import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadSkillsFromDirs, buildSkillsSystemPrompt, buildSkillTools } from "../src/skills.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orager-skills-test-"));

  // Create skills structure:
  // tmp/
  //   .claude/
  //     skills/
  //       my-skill/
  //         SKILL.md
  //       other-skill/
  //         SKILL.md

  const skillsRoot = path.join(tmpDir, ".orager", "skills");
  await fs.mkdir(path.join(skillsRoot, "my-skill"), { recursive: true });
  await fs.mkdir(path.join(skillsRoot, "other-skill"), { recursive: true });

  await fs.writeFile(
    path.join(skillsRoot, "my-skill", "SKILL.md"),
    `---
description: Does something cool
---

# My Skill

This skill does something cool.
`,
    "utf-8"
  );

  await fs.writeFile(
    path.join(skillsRoot, "other-skill", "SKILL.md"),
    `---
description: Another thing
---

# Other Skill

This is another skill.
`,
    "utf-8"
  );

  await fs.mkdir(path.join(skillsRoot, "exec-skill"), { recursive: true });
  await fs.writeFile(
    path.join(skillsRoot, "exec-skill", "SKILL.md"),
    `---
description: Runs tests
exec: npm test -- {{args}}
parameters: {"type":"object","properties":{"args":{"type":"string","description":"Extra args"}},"required":[]}
---

# Exec Skill

This skill runs tests.
`,
    "utf-8"
  );
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("skills loading", () => {
  it("loadSkillsFromDirs returns 3 skills (2 prompt-only + 1 exec)", async () => {
    const skills = await loadSkillsFromDirs([tmpDir]);
    expect(skills).toHaveLength(3);
  });

  it("skill names match directory names", async () => {
    const skills = await loadSkillsFromDirs([tmpDir]);
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(["exec-skill", "my-skill", "other-skill"]);
  });

  it("descriptions are extracted from frontmatter", async () => {
    const skills = await loadSkillsFromDirs([tmpDir]);
    const mySkill = skills.find((s) => s.name === "my-skill");
    const otherSkill = skills.find((s) => s.name === "other-skill");
    expect(mySkill?.description).toBe("Does something cool");
    expect(otherSkill?.description).toBe("Another thing");
  });

  it("buildSkillsSystemPrompt returns empty string for no skills", () => {
    const result = buildSkillsSystemPrompt([]);
    expect(result).toBe("");
  });

  it("buildSkillsSystemPrompt returns non-empty markdown containing prompt-only skill names", async () => {
    const skills = await loadSkillsFromDirs([tmpDir]);
    const prompt = buildSkillsSystemPrompt(skills);
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain("my-skill");
    expect(prompt).toContain("other-skill");
  });

  it("buildSkillsSystemPrompt excludes exec-capable skills from the prompt", async () => {
    const skills = await loadSkillsFromDirs([tmpDir]);
    const prompt = buildSkillsSystemPrompt(skills);
    expect(prompt).not.toContain("exec-skill");
  });

  it("exec skill has exec and parameters fields populated", async () => {
    const skills = await loadSkillsFromDirs([tmpDir]);
    const execSkill = skills.find((s) => s.name === "exec-skill");
    expect(execSkill?.exec).toBe("npm test -- {{args}}");
    expect(execSkill?.parameters?.type).toBe("object");
  });
});

describe("buildSkillTools", () => {
  it("returns empty array when no skills have exec", async () => {
    const skills = await loadSkillsFromDirs([tmpDir]);
    const promptOnly = skills.filter((s) => !s.exec);
    expect(buildSkillTools(promptOnly)).toHaveLength(0);
  });

  it("returns one executor for the exec-capable skill", async () => {
    const skills = await loadSkillsFromDirs([tmpDir]);
    const tools = buildSkillTools(skills);
    expect(tools).toHaveLength(1);
  });

  it("normalises dashes to underscores in the tool name", async () => {
    const skills = await loadSkillsFromDirs([tmpDir]);
    const tools = buildSkillTools(skills);
    expect(tools[0].definition.function.name).toBe("exec_skill");
  });

  it("uses skill description as the tool description", async () => {
    const skills = await loadSkillsFromDirs([tmpDir]);
    const tools = buildSkillTools(skills);
    expect(tools[0].definition.function.description).toBe("Runs tests");
  });

  it("executor runs command and returns stdout", async () => {
    const skills = [
      {
        name: "hello-skill",
        description: "Says hello",
        content: "",
        exec: "echo 'hi from skill'",
      },
    ];
    const tools = buildSkillTools(skills);
    const result = await tools[0].execute({}, "/tmp");
    expect(result.isError).toBe(false);
    expect(result.content).toContain("hi from skill");
  });

  // ── H-04: Skill exec blocklist enforcement ──────────────────────────────

  it("H-04: buildSkillTools filters out skills with blocked commands in exec template", () => {
    const skills = [
      {
        name: "dangerous-skill",
        description: "Does rm",
        content: "",
        exec: "rm -rf /tmp/target",
      },
      {
        name: "safe-skill",
        description: "Echoes",
        content: "",
        exec: "echo hello",
      },
    ];
    const blocked = new Set(["rm"]);
    const tools = buildSkillTools(skills, blocked);
    // Only the safe skill should survive
    expect(tools).toHaveLength(1);
    expect(tools[0].definition.function.name).toBe("safe_skill");
  });

  it("H-04: buildSkillTools blocks skill with bash -c wrapping a blocked command", () => {
    const skills = [
      {
        name: "sneaky-skill",
        description: "Wraps rm in bash -c",
        content: "",
        exec: "bash -c 'rm -rf /tmp'",
      },
    ];
    const blocked = new Set(["rm"]);
    const tools = buildSkillTools(skills, blocked);
    expect(tools).toHaveLength(0);
  });

  it("H-04: runtime check blocks interpolated command containing blocked command", async () => {
    const skills = [
      {
        name: "template-skill",
        description: "Runs a user command",
        content: "",
        exec: "{{cmd}}",
        parameters: {
          type: "object" as const,
          properties: { cmd: { type: "string", description: "Command to run" } },
        },
      },
    ];
    const blocked = new Set(["rm"]);
    // Template itself is clean — just {{cmd}} — so it passes build-time check
    const tools = buildSkillTools(skills, blocked);
    expect(tools).toHaveLength(1);
    // But at runtime, the interpolated command contains "rm"
    const result = await tools[0].execute({ cmd: "rm -rf /" }, "/tmp");
    expect(result.isError).toBe(true);
    expect(result.content).toContain("blocked command");
    expect(result.content).toContain("rm");
  });

  it("H-04: buildSkillTools with no blockedCommands does not filter anything", () => {
    const skills = [
      {
        name: "rm-skill",
        description: "Does rm",
        content: "",
        exec: "rm -rf /tmp/target",
      },
    ];
    // No blocklist passed
    const tools = buildSkillTools(skills);
    expect(tools).toHaveLength(1);
  });

  it("executor interpolates {{param}} placeholders", async () => {
    const skills = [
      {
        name: "greet-skill",
        description: "Greets",
        content: "",
        exec: "echo 'Hello {{who}}'",
        parameters: {
          type: "object" as const,
          properties: { who: { type: "string", description: "Name" } },
        },
      },
    ];
    const tools = buildSkillTools(skills);
    const result = await tools[0].execute({ who: "World" }, "/tmp");
    expect(result.content).toContain("Hello World");
  });
});
