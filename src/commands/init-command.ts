/**
 * `orager init` — scaffold a project-local `.orager/` directory.
 *
 * Creates:
 *   .orager/ORAGER.md         — project context template
 *   .orager/settings.json     — minimal settings template
 *   .orager/skills/.gitkeep   — empty skills directory
 */
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";

// ── Templates ─────────────────────────────────────────────────────────────────

const ORAGER_MD_TEMPLATE = `# Project Instructions

<!-- Tell orager about your project. This is injected into every agent run. -->

## Stack
<!-- e.g. TypeScript, Bun, React -->

## Testing
<!-- e.g. bun test -->

## Key conventions
<!-- e.g. always run typecheck before committing -->
`;

const SETTINGS_JSON_TEMPLATE = `{
  "memory": {
    "tokenPressureThreshold": 0.70,
    "turnInterval": 6
  },
  "bashPolicy": {
    "blockedCommands": []
  }
}
`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function pc(code: number, text: string): string {
  return `\x1b[${code}m${text}\x1b[0m`;
}
const bold  = (t: string) => pc(1, t);
const green = (t: string) => pc(32, t);
const dim   = (t: string) => pc(2, t);
const cyan  = (t: string) => pc(36, t);

// ── Main handler ──────────────────────────────────────────────────────────────

export async function handleInitCommand(): Promise<void> {
  const cwd = process.cwd();
  const oragerDir = path.join(cwd, ".orager");
  const skillsDir = path.join(oragerDir, "skills");
  const oragerMd  = path.join(oragerDir, "ORAGER.md");
  const settingsJson = path.join(oragerDir, "settings.json");
  const gitkeep   = path.join(skillsDir, ".gitkeep");

  // ── Check for existing .orager/ ──────────────────────────────────────────────
  let exists = false;
  try {
    await fs.access(oragerDir);
    exists = true;
  } catch {
    // Does not exist — proceed
  }

  if (exists) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    let answer: string;
    try {
      answer = await rl.question(
        `${dim(".orager/ already exists in this directory.")} Overwrite? [y/N] `
      );
    } finally {
      rl.close();
    }
    if (answer.trim().toLowerCase() !== "y") {
      process.stdout.write(dim("Aborted. No files were changed.\n"));
      return;
    }
  }

  // ── Create directory structure ────────────────────────────────────────────────
  await fs.mkdir(skillsDir, { recursive: true });

  // ── Write files ───────────────────────────────────────────────────────────────
  await fs.writeFile(oragerMd, ORAGER_MD_TEMPLATE, "utf8");
  process.stdout.write(green("  created  ") + path.relative(cwd, oragerMd) + "\n");

  await fs.writeFile(settingsJson, SETTINGS_JSON_TEMPLATE, "utf8");
  process.stdout.write(green("  created  ") + path.relative(cwd, settingsJson) + "\n");

  await fs.writeFile(gitkeep, "", "utf8");
  process.stdout.write(green("  created  ") + path.relative(cwd, gitkeep) + "\n");

  // ── Success message ───────────────────────────────────────────────────────────
  process.stdout.write(
    "\n" +
    bold("orager project initialised!") +
    "\n\n" +
    "Next steps:\n" +
    "  " + cyan("1") + "  Edit " + bold(".orager/ORAGER.md") + " — describe your project, stack, and conventions.\n" +
    "  " + cyan("2") + "  Tweak " + bold(".orager/settings.json") + " if you need custom memory or bash-policy settings.\n" +
    "  " + cyan("3") + "  Add " + bold(".orager/") + " to your .gitignore if you prefer not to commit it, or commit it to share with your team.\n" +
    "  " + cyan("4") + "  Run " + bold("orager run \"your prompt\"") + " — orager will pick up the project context automatically.\n" +
    "\n" +
    dim("Tip: put .orager/skills/ in version control to preserve learned skills across checkouts.\n") +
    "\n"
  );
}
