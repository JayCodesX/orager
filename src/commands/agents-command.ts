/**
 * `orager agents` — agent catalog management CLI.
 *
 * Subcommands:
 *   orager agents list              List all agents (seed + user + project + db)
 *   orager agents show <id>         Full definition + stats for one agent
 *   orager agents add <id>          Add or update a DB-stored agent (interactive)
 *   orager agents remove <id>       Remove a DB-stored agent
 *   orager agents export <id>       Export a DB agent to ~/.orager/agents/<id>.json
 *   orager agents stats [id]        Show performance stats (all or one agent)
 */

import { loadAllAgents, upsertAgent, deleteAgent, exportAgentToUserDir, getAgentsDb } from "../agents/registry.js";
import { getAgentStats, getAllAgentStats } from "../agents/score.js";
import { generateAgentDefinition } from "../agents/generate.js";
import { SEED_AGENTS } from "../agents/seeds.js";
import type { AgentDefinition } from "../types.js";

// ── ANSI helpers ──────────────────────────────────────────────────────────────

const BOLD  = "\x1b[1m";
const DIM   = "\x1b[2m";
const CYAN  = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED   = "\x1b[31m";
const BLUE  = "\x1b[34m";
const RESET = "\x1b[0m";

function bold(s: string)   { return `${BOLD}${s}${RESET}`; }
function dim(s: string)    { return `${DIM}${s}${RESET}`; }
function cyan(s: string)   { return `${CYAN}${s}${RESET}`; }
function green(s: string)  { return `${GREEN}${s}${RESET}`; }
function yellow(s: string) { return `${YELLOW}${s}${RESET}`; }
function red(s: string)    { return `${RED}${s}${RESET}`; }
function blue(s: string)   { return `${BLUE}${s}${RESET}`; }

// ── Source badge ──────────────────────────────────────────────────────────────

function sourceBadge(source?: string): string {
  switch (source) {
    case "seed":    return dim("[seed]");
    case "user":    return blue("[user]");
    case "project": return green("[project]");
    case "db":      return cyan("[db]");
    default:        return dim("[?]");
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function runAgentsCommand(args: string[]): Promise<void> {
  const sub = args[0] ?? "list";

  switch (sub) {
    case "list":
      return cmdList(args.slice(1));
    case "show":
      return cmdShow(args.slice(1));
    case "add":
      return cmdAdd(args.slice(1));
    case "generate":
    case "gen":
      return cmdGenerate(args.slice(1));
    case "remove":
    case "rm":
    case "delete":
      return cmdRemove(args.slice(1));
    case "export":
      return cmdExport(args.slice(1));
    case "stats":
      return cmdStats(args.slice(1));
    default:
      console.error(`Unknown agents subcommand: ${sub}`);
      printUsage();
      process.exit(1);
  }
}

function printUsage(): void {
  console.log(`
${bold("orager agents")} — agent catalog management

${bold("Usage:")}
  orager agents list                     List all available agents
  orager agents show <id>                Show full definition and stats for an agent
  orager agents generate <task> [flags]  Synthesize a new agent definition with AI
  orager agents add <id>                 Add or update an agent in the DB catalog
  orager agents remove <id>              Remove a DB-stored agent
  orager agents export <id>              Export an agent definition to ~/.orager/agents/<id>.json
  orager agents stats [id]               Performance stats (all or one agent)

${bold("generate flags:")}
  --id <key>       Registry key for the new agent (auto-derived if omitted)
  --model <model>  Model for generation (default: openai/gpt-4o-mini)
  --no-save        Preview only — do not save to catalog
  --json           Output raw JSON definition

${bold("Examples:")}
  orager agents list
  orager agents show reviewer
  orager agents generate "analyze Rust compiler errors and suggest fixes"
  orager agents generate "benchmark API endpoints" --id api-benchmarker --no-save
  orager agents stats
  orager agents remove my-old-agent
`);
}

// ── generate ─────────────────────────────────────────────────────────────────

async function cmdGenerate(args: string[]): Promise<void> {
  // Parse positional task and flags
  const positional: string[] = [];
  let suggestedId: string | undefined;
  let model: string | undefined;
  let persist = true;
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--id" && args[i + 1]) { suggestedId = args[++i]; }
    else if (arg === "--model" && args[i + 1]) { model = args[++i]; }
    else if (arg === "--no-save") { persist = false; }
    else if (arg === "--json") { jsonOutput = true; }
    else if (!arg.startsWith("--")) { positional.push(arg); }
  }

  const task = positional.join(" ").trim();
  if (!task) {
    console.error('Usage: orager agents generate "<task description>" [--id <key>] [--model <model>] [--no-save] [--json]');
    process.exit(1);
  }

  if (!jsonOutput) {
    console.log(dim(`Generating agent definition for: "${task}"...`));
    if (!persist) console.log(dim("(preview mode — will not save to catalog)"));
  }

  let result: Awaited<ReturnType<typeof generateAgentDefinition>>;
  try {
    result = await generateAgentDefinition({ task, suggestedId, model, persist });
  } catch (err) {
    console.error(red(`Generation failed: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }

  if (jsonOutput) {
    // Machine-readable output: just the definition JSON
    console.log(JSON.stringify({ id: result.id, ...result.definition }, null, 2));
    return;
  }

  // Human-readable output
  console.log();
  console.log(bold(`Generated: ${result.id}`) + (result.persisted ? green("  ✓ saved to catalog") : yellow("  (not saved)")));
  if (result.definition.name) console.log(`  Name:   ${result.definition.name}`);
  console.log(`  Desc:   ${result.definition.description}`);
  if (result.definition.model) console.log(`  Model:  ${result.definition.model}`);
  if (result.definition.effort) console.log(`  Effort: ${result.definition.effort}`);
  if (result.definition.tools) console.log(`  Tools:  ${result.definition.tools.join(", ")}`);
  if (result.definition.tags?.length) console.log(`  Tags:   ${result.definition.tags.join(", ")}`);
  console.log();
  console.log(bold("System prompt:"));
  console.log(result.definition.prompt.split("\n").map((l) => `  ${l}`).join("\n"));
  console.log();

  if (result.persisted) {
    console.log(dim(`Run \`orager agents show ${result.id}\` to inspect.`));
    console.log(dim(`Use Agent tool with subagent_type: "${result.id}" to spawn it.`));
  } else {
    console.log(dim(`To save: orager agents generate "${task}" --id ${result.id}`));
  }
}

// ── list ──────────────────────────────────────────────────────────────────────

async function cmdList(_args: string[]): Promise<void> {
  const agents = await loadAllAgents();
  const ids = Object.keys(agents).sort();

  if (ids.length === 0) {
    console.log("No agents configured.");
    return;
  }

  // Load stats to show run counts
  let statsMap: Record<string, { totalRuns: number; successRate: number }> = {};
  try {
    const db = await getAgentsDb();
    const all = getAllAgentStats(db);
    statsMap = all;
  } catch { /* non-fatal */ }

  console.log(bold(`\n${ids.length} agent(s) in catalog:\n`));

  const maxIdLen = Math.max(...ids.map((id) => id.length));

  for (const id of ids) {
    const defn = agents[id]!;
    const stats = statsMap[id];
    const runsStr = stats
      ? dim(` (${stats.totalRuns} runs, ${Math.round(stats.successRate * 100)}% success)`)
      : "";
    const tagsStr = defn.tags && defn.tags.length > 0
      ? dim(` [${defn.tags.join(", ")}]`)
      : "";
    const modelStr = defn.model ? dim(` ${defn.model}`) : "";
    const effortStr = defn.effort && defn.effort !== "medium"
      ? dim(` effort:${defn.effort}`)
      : "";

    console.log(
      `  ${cyan(id.padEnd(maxIdLen))}  ${sourceBadge(defn.source)}${modelStr}${effortStr}${tagsStr}${runsStr}`,
    );
    console.log(`    ${dim(defn.description)}`);
  }
  console.log();
}

// ── show ──────────────────────────────────────────────────────────────────────

async function cmdShow(args: string[]): Promise<void> {
  const id = args[0];
  if (!id) {
    console.error("Usage: orager agents show <id>");
    process.exit(1);
  }

  const agents = await loadAllAgents();
  const defn = agents[id];
  if (!defn) {
    console.error(`Agent "${id}" not found. Run \`orager agents list\` to see available agents.`);
    process.exit(1);
  }

  console.log(bold(`\nAgent: ${id}`) + "  " + sourceBadge(defn.source));
  if (defn.name && defn.name !== id) console.log(`  Display name: ${defn.name}`);
  console.log(`  ${defn.description}`);
  console.log();

  if (defn.model) console.log(`  Model:      ${defn.model}`);
  if (defn.effort) console.log(`  Effort:     ${defn.effort}`);
  if (defn.maxTurns) console.log(`  Max turns:  ${defn.maxTurns}`);
  if (defn.maxCostUsd) console.log(`  Max cost:   $${defn.maxCostUsd}`);
  if (defn.tools) console.log(`  Tools:      ${defn.tools.join(", ")}`);
  if (defn.disallowedTools) console.log(`  Blocked:    ${defn.disallowedTools.join(", ")}`);
  if (defn.memoryKey) console.log(`  Memory key: ${defn.memoryKey}`);
  if (defn.tags) console.log(`  Tags:       ${defn.tags.join(", ")}`);
  if (defn.memoryWrite) console.log(`  Memory write: enabled`);
  if (defn.readProjectInstructions) console.log(`  Reads project instructions: yes`);
  if (defn.skills === false) console.log(`  Skills: disabled`);

  console.log();
  console.log(bold("System prompt:"));
  console.log(defn.prompt.split("\n").map((l) => `  ${l}`).join("\n"));
  console.log();

  // Stats
  try {
    const db = await getAgentsDb();
    const stats = getAgentStats(db, id);
    if (stats) {
      console.log(bold("Performance stats:"));
      console.log(`  Total runs:   ${stats.totalRuns}`);
      console.log(`  Success rate: ${Math.round(stats.successRate * 100)}%`);
      console.log(`  Avg turns:    ${stats.avgTurns}`);
      console.log(`  Avg cost:     $${stats.avgCostUsd.toFixed(4)}`);
      console.log(`  Total cost:   $${stats.totalCostUsd.toFixed(4)}`);
      console.log(`  Avg duration: ${(stats.avgDurationMs / 1000).toFixed(1)}s`);
      if (stats.lastUsedAt) console.log(`  Last used:    ${stats.lastUsedAt}`);
    } else {
      console.log(dim("  No runs recorded yet."));
    }
  } catch { /* non-fatal */ }
  console.log();
}

// ── add ───────────────────────────────────────────────────────────────────────

async function cmdAdd(args: string[]): Promise<void> {
  const id = args[0];
  if (!id) {
    console.error("Usage: orager agents add <id>");
    console.error();
    console.error("Pass the agent definition as JSON via --json flag or stdin:");
    console.error('  orager agents add my-agent --json \'{"description":"...","prompt":"...",...}\'');
    console.error("  cat my-agent.json | orager agents add my-agent");
    process.exit(1);
  }

  // Read definition from --json flag or stdin
  let jsonStr: string | undefined;
  const jsonFlagIdx = args.indexOf("--json");
  if (jsonFlagIdx !== -1 && args[jsonFlagIdx + 1]) {
    jsonStr = args[jsonFlagIdx + 1];
  } else if (!process.stdin.isTTY) {
    // Read from stdin
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    jsonStr = Buffer.concat(chunks).toString("utf-8").trim();
  }

  if (!jsonStr) {
    console.error("No agent definition provided. Pass --json or pipe JSON via stdin.");
    console.error();
    console.error("Example JSON:");
    console.error(JSON.stringify({
      description: "A specialist for X tasks. Use when Y.",
      prompt: "You are an expert at...",
      model: "openai/gpt-4o-mini",
      tools: ["Read", "Bash"],
      tags: ["code"],
    }, null, 2));
    process.exit(1);
  }

  let defn: Omit<AgentDefinition, "source">;
  try {
    defn = JSON.parse(jsonStr) as Omit<AgentDefinition, "source">;
  } catch (err) {
    console.error(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (!defn.description || !defn.prompt) {
    console.error("Agent definition must have at least: description, prompt");
    process.exit(1);
  }

  // Check if it's a seed agent (warn but allow override)
  if (id in SEED_AGENTS) {
    console.log(yellow(`Warning: "${id}" is a built-in seed agent. Your DB definition will override it.`));
  }

  await upsertAgent(id, defn);
  console.log(green(`✓ Agent "${id}" saved to catalog.`));
  console.log(dim(`  Run \`orager agents show ${id}\` to verify.`));
}

// ── remove ────────────────────────────────────────────────────────────────────

async function cmdRemove(args: string[]): Promise<void> {
  const id = args[0];
  if (!id) {
    console.error("Usage: orager agents remove <id>");
    process.exit(1);
  }

  if (id in SEED_AGENTS) {
    console.error(red(`"${id}" is a built-in seed agent and cannot be removed.`));
    console.error("To override it, use: orager agents add " + id);
    process.exit(1);
  }

  const removed = await deleteAgent(id);
  if (removed) {
    console.log(green(`✓ Agent "${id}" removed from DB catalog.`));
    console.log(dim("  Note: if a ~/.orager/agents/" + id + ".json file exists, it will still load."));
  } else {
    console.log(yellow(`Agent "${id}" was not found in the DB catalog.`));
    console.log(dim("  Seed and file-based agents cannot be removed via this command."));
  }
}

// ── export ────────────────────────────────────────────────────────────────────

async function cmdExport(args: string[]): Promise<void> {
  const id = args[0];
  if (!id) {
    console.error("Usage: orager agents export <id>");
    process.exit(1);
  }

  const agents = await loadAllAgents();
  const defn = agents[id];
  if (!defn) {
    console.error(`Agent "${id}" not found.`);
    process.exit(1);
  }

  // Strip internal fields before export
  const { source: _source, ...exportDefn } = defn;
  const filePath = exportAgentToUserDir(id, exportDefn);
  console.log(green(`✓ Exported "${id}" to ${filePath}`));
}

// ── stats ─────────────────────────────────────────────────────────────────────

async function cmdStats(args: string[]): Promise<void> {
  const id = args[0];

  try {
    const db = await getAgentsDb();

    if (id) {
      // Single agent
      const stats = getAgentStats(db, id);
      if (!stats) {
        console.log(`No runs recorded for agent "${id}".`);
        return;
      }
      console.log(bold(`\nStats for: ${id}\n`));
      console.log(`  Total runs:   ${stats.totalRuns}`);
      console.log(`  Success rate: ${Math.round(stats.successRate * 100)}%`);
      console.log(`  Avg turns:    ${stats.avgTurns}`);
      console.log(`  Avg cost:     $${stats.avgCostUsd.toFixed(4)}`);
      console.log(`  Total cost:   $${stats.totalCostUsd.toFixed(4)}`);
      console.log(`  Avg duration: ${(stats.avgDurationMs / 1000).toFixed(1)}s`);
      if (stats.lastUsedAt) console.log(`  Last used:    ${stats.lastUsedAt}`);
      console.log();
    } else {
      // All agents
      const allStats = getAllAgentStats(db);
      const entries = Object.values(allStats);
      if (entries.length === 0) {
        console.log("No agent runs recorded yet.");
        return;
      }

      console.log(bold(`\nAgent performance stats (${entries.length} agent(s)):\n`));
      const maxIdLen = Math.max(...entries.map((s) => s.agentId.length));

      // Header
      console.log(
        dim(
          `  ${"ID".padEnd(maxIdLen)}  ${"Runs".padStart(5)}  ${"Success".padStart(7)}  ${"AvgTurns".padStart(8)}  ${"AvgCost".padStart(8)}  ${"TotalCost".padStart(10)}  ${"AvgDuration".padStart(11)}`
        )
      );
      console.log(dim("  " + "─".repeat(maxIdLen + 62)));

      for (const s of entries.sort((a, b) => b.totalRuns - a.totalRuns)) {
        const successPct = Math.round(s.successRate * 100);
        const successStr = successPct >= 80 ? green(`${successPct}%`) :
          successPct >= 50 ? yellow(`${successPct}%`) : red(`${successPct}%`);
        console.log(
          `  ${cyan(s.agentId.padEnd(maxIdLen))}  ${String(s.totalRuns).padStart(5)}  ${successStr.padStart(7 + (successStr.length - `${successPct}%`.length))}  ${String(s.avgTurns).padStart(8)}  ${("$" + s.avgCostUsd.toFixed(4)).padStart(8)}  ${("$" + s.totalCostUsd.toFixed(4)).padStart(10)}  ${((s.avgDurationMs / 1000).toFixed(1) + "s").padStart(11)}`
        );
      }
      console.log();
    }
  } catch (err) {
    console.error(`Failed to load stats: ${err instanceof Error ? err.message : String(err)}`);
  }
}
