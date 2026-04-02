/**
 * skills-command.ts — CLI handler for `orager skills` subcommand (ADR-0006).
 *
 * Subcommands:
 *   orager skills list [--all]          — list all live (or all incl. deleted) skills
 *   orager skills show <id>             — show a single skill by ID
 *   orager skills delete <id>           — soft-delete a skill by ID
 *   orager skills stats                 — show aggregate statistics
 *   orager skills extract <session-id>  — manually trigger skill extraction from a trajectory
 */

import {
  listSkills,
  getSkill,
  deleteSkill,
  getSkillStats,
  extractSkillFromTrajectory,
  trajectoryPath,
  DEFAULT_SKILLBANK_CONFIG,
} from "../skillbank.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function printLine(msg: string): void {
  process.stdout.write(msg + "\n");
}

function printErr(msg: string): void {
  process.stderr.write(msg + "\n");
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function fmtPct(rate: number): string {
  return (rate * 100).toFixed(1) + "%";
}

// ── Subcommand handlers ───────────────────────────────────────────────────────

async function handleList(argv: string[]): Promise<void> {
  const includeDeleted = argv.includes("--all");
  const skills = await listSkills(includeDeleted);
  if (skills.length === 0) {
    printLine("No skills found. Skills are extracted automatically after failed runs.");
    return;
  }
  printLine(`\n${skills.length} skill(s)${includeDeleted ? " (including deleted)" : ""}:\n`);
  for (const sk of skills) {
    const deleted = sk.deleted ? " [DELETED]" : "";
    const stats = sk.useCount > 0
      ? ` | used ${sk.useCount}x | success ${fmtPct(sk.successRate)}`
      : " | unused";
    printLine(`  ${sk.id}${deleted}`);
    printLine(`    ${sk.text.slice(0, 120)}${sk.text.length > 120 ? "…" : ""}`);
    printLine(`    created ${fmtDate(sk.createdAt)}${stats}`);
    printLine("");
  }
}

async function handleShow(argv: string[]): Promise<void> {
  const id = argv[0];
  if (!id) {
    printErr("Usage: orager skills show <skill-id>");
    process.exit(1);
  }
  const sk = await getSkill(id);
  if (!sk) {
    printErr(`Skill '${id}' not found.`);
    process.exit(1);
  }
  printLine(`\nSkill: ${sk.id}${sk.deleted ? " [DELETED]" : ""}`);
  printLine(`Version:          ${sk.version}`);
  printLine(`Source session:   ${sk.sourceSession}`);
  printLine(`Extraction model: ${sk.extractionModel}`);
  printLine(`Created:          ${fmtDate(sk.createdAt)}`);
  printLine(`Updated:          ${fmtDate(sk.updatedAt)}`);
  printLine(`Use count:        ${sk.useCount}`);
  printLine(`Success rate:     ${fmtPct(sk.successRate)}`);
  printLine(`\nText:\n  ${sk.text}`);
  printLine("");
}

async function handleDelete(argv: string[]): Promise<void> {
  const id = argv[0];
  if (!id) {
    printErr("Usage: orager skills delete <skill-id>");
    process.exit(1);
  }
  const existing = await getSkill(id);
  if (!existing) {
    printErr(`Skill '${id}' not found.`);
    process.exit(1);
  }
  if (existing.deleted) {
    printLine(`Skill '${id}' is already deleted.`);
    return;
  }
  await deleteSkill(id);
  printLine(`Skill '${id}' deleted.`);
}

async function handleStats(): Promise<void> {
  const stats = await getSkillStats();
  printLine(`\nSkillBank statistics`);
  printLine(`─────────────────────────────────`);
  printLine(`Total live skills:   ${stats.total}`);
  printLine(`Avg success rate:    ${fmtPct(stats.avgSuccessRate)}`);

  if (stats.topByUse.length > 0) {
    printLine(`\nTop skills by usage:`);
    for (const sk of stats.topByUse) {
      printLine(`  [${sk.id}] used ${sk.useCount}x (${fmtPct(sk.successRate)}) — ${sk.text.slice(0, 80)}…`);
    }
  }

  if (stats.weakSkills.length > 0) {
    printLine(`\nWeak skills (low success rate):`);
    for (const sk of stats.weakSkills) {
      printLine(`  [${sk.id}] ${fmtPct(sk.successRate)} success, ${sk.useCount} uses — ${sk.text.slice(0, 80)}…`);
    }
  }

  if (stats.total === 0) {
    printLine(`\nNo skills yet. Skills are extracted automatically after failed runs.`);
    printLine(`You can also run: orager skills extract <session-id>`);
  }
  printLine("");
}

async function handleExtract(argv: string[]): Promise<void> {
  const sessionId = argv[0];
  if (!sessionId) {
    printErr("Usage: orager skills extract <session-id>");
    process.exit(1);
  }

  const apiKey = (process.env["PROTOCOL_API_KEY"] ?? "").trim();
  if (!apiKey) {
    printErr("orager: API key not set. Export PROTOCOL_API_KEY.");
    process.exit(1);
  }

  const model = process.env["ORAGER_DEFAULT_MODEL"] ?? "deepseek/deepseek-r1";
  const embeddingModel = process.env["ORAGER_EMBEDDING_MODEL"] ?? "openai/text-embedding-3-small";
  const tPath = trajectoryPath(sessionId);

  printLine(`Extracting skill from trajectory: ${tPath}`);
  printLine(`Model: ${model}, embedding: ${embeddingModel}`);

  await extractSkillFromTrajectory(tPath, sessionId, model, apiKey, embeddingModel);
  printLine("Done. Run `orager skills list` to see the new skill.");
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Entry point for `orager skills [subcommand] [args...]`.
 * argv should be the args after "skills".
 */
export async function handleSkillsSubcommand(argv: string[]): Promise<void> {
  const sub = argv[0];
  const rest = argv.slice(1);

  switch (sub) {
    case "list":
    case "ls":
      await handleList(rest);
      break;
    case "show":
    case "get":
      await handleShow(rest);
      break;
    case "delete":
    case "rm":
      await handleDelete(rest);
      break;
    case "stats":
      await handleStats();
      break;
    case "extract":
      await handleExtract(rest);
      break;
    default:
      printLine("Usage: orager skills <subcommand> [args]");
      printLine("");
      printLine("Subcommands:");
      printLine("  list [--all]           List all skills (--all includes deleted)");
      printLine("  show <id>              Show a single skill");
      printLine("  delete <id>            Soft-delete a skill");
      printLine("  stats                  Show aggregate statistics");
      printLine("  extract <session-id>   Manually extract a skill from a trajectory");
      printLine("");
      if (sub && sub !== "--help" && sub !== "help") {
        printErr(`Unknown subcommand: '${sub}'`);
        process.exit(1);
      }
      break;
  }
}
