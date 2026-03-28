/**
 * orager setup — interactive configuration wizard for ~/.orager/config.json
 *
 * Usage:
 *   orager setup              — choose Quick or Custom interactively
 *   orager setup --quick      — Quick Setup (API key + 3 model slots)
 *   orager setup --custom     — Custom Setup (all fields)
 *   orager setup --show       — print current config
 *   orager setup --show-defaults — print built-in defaults
 *   orager setup --reset      — reset config to defaults (after confirmation)
 *   orager setup --edit       — open config in $EDITOR
 */
import readline from "node:readline/promises";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ── Paths ─────────────────────────────────────────────────────────────────────

const ORAGER_DIR = path.join(os.homedir(), ".orager");
const CONFIG_PATH = path.join(ORAGER_DIR, "config.json");

// ── Default config ────────────────────────────────────────────────────────────

export interface OragerUserConfig {
  // Core
  model?: string;
  models?: string[];           // fallback models (rotated on 429)
  visionModel?: string;        // alias for models[0] when vision is needed

  // Loop
  maxTurns?: number;
  maxRetries?: number;
  timeoutSec?: number;

  // Cost limits
  maxCostUsd?: number;
  maxCostUsdSoft?: number;

  // Sampling
  temperature?: number;
  top_p?: number;
  top_k?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  repetition_penalty?: number;
  min_p?: number;
  seed?: number;

  // Reasoning
  reasoningEffort?: "xhigh" | "high" | "medium" | "low" | "minimal" | "none";
  reasoningMaxTokens?: number;
  reasoningExclude?: boolean;

  // Provider routing
  providerOrder?: string[];
  providerOnly?: string[];
  providerIgnore?: string[];
  sort?: "price" | "throughput" | "latency";
  dataCollection?: "allow" | "deny";
  zdr?: boolean;

  // Context / summarization
  summarizeAt?: number;
  summarizeModel?: string;
  summarizeKeepRecentTurns?: number;

  // Memory
  memory?: boolean;
  memoryKey?: string;
  memoryMaxChars?: number;

  // Identity
  siteUrl?: string;
  siteName?: string;

  // Approval / security
  requireApproval?: "all" | string[];
  sandboxRoot?: string;

  // Agent behavior
  planMode?: boolean;
  injectContext?: boolean;
  tagToolOutputs?: boolean;
  useFinishTool?: boolean;
  enableBrowserTools?: boolean;
  trackFileChanges?: boolean;

  // Misc
  profile?: string;
  webhookUrl?: string;
  requiredEnvVars?: string[];
}

export const DEFAULT_CONFIG: OragerUserConfig = {
  model: "deepseek/deepseek-chat-v3-0324",
  maxTurns: 20,
  maxRetries: 3,
  memory: true,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function readConfig(): Promise<OragerUserConfig> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf8");
    return JSON.parse(raw) as OragerUserConfig;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

async function writeConfig(cfg: OragerUserConfig): Promise<void> {
  await fs.mkdir(ORAGER_DIR, { recursive: true });
  const tmp = CONFIG_PATH + ".tmp." + process.pid;
  await fs.writeFile(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  await fs.rename(tmp, CONFIG_PATH);
  if (process.platform !== "win32") {
    await fs.chmod(CONFIG_PATH, 0o600);
  }
}

function pc(code: number, text: string): string {
  return `\x1b[${code}m${text}\x1b[0m`;
}
const bold = (t: string) => pc(1, t);
const dim  = (t: string) => pc(2, t);
const cyan = (t: string) => pc(36, t);
const green = (t: string) => pc(32, t);
const yellow = (t: string) => pc(33, t);

function ask(rl: readline.Interface, prompt: string): Promise<string> {
  return rl.question(prompt);
}

function parseOptionalNumber(s: string): number | undefined {
  if (!s.trim()) return undefined;
  const n = Number(s.trim());
  return isNaN(n) ? undefined : n;
}

function parseOptionalBool(s: string): boolean | undefined {
  const t = s.trim().toLowerCase();
  if (t === "yes" || t === "y" || t === "true") return true;
  if (t === "no"  || t === "n" || t === "false") return false;
  return undefined;
}

function parseCsvList(s: string): string[] | undefined {
  const parts = s.split(",").map((p) => p.trim()).filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

function displayValue(v: unknown): string {
  if (v === undefined || v === null) return dim("(not set)");
  if (Array.isArray(v)) return v.length > 0 ? v.join(", ") : dim("(empty)");
  return String(v);
}

// ── Quick Setup ───────────────────────────────────────────────────────────────

async function quickSetup(rl: readline.Interface): Promise<void> {
  const current = await readConfig();

  process.stdout.write("\n" + bold("── Quick Setup ──") + "\n");
  process.stdout.write(dim("Sets the three most important model slots. Press Enter to keep the current value.\n\n"));

  const apiKeyEnv = process.env["OPENROUTER_API_KEY"] ?? process.env["ORAGER_API_KEY"] ?? "";

  process.stdout.write(cyan("API Key") + "\n");
  process.stdout.write(dim("  Set OPENROUTER_API_KEY in your shell profile (e.g. ~/.zshrc or ~/.bashrc).\n"));
  if (apiKeyEnv) {
    process.stdout.write(dim(`  Current: set via env (${apiKeyEnv.slice(0, 8)}...)\n`));
  } else {
    process.stdout.write(yellow("  Warning: OPENROUTER_API_KEY is not set in the current environment.\n"));
    process.stdout.write(dim("  Add: export OPENROUTER_API_KEY=sk-or-... to your shell profile.\n"));
  }

  process.stdout.write("\n");
  process.stdout.write(cyan("Primary model") + dim(` (current: ${displayValue(current.model)})`) + "\n");
  process.stdout.write(dim("  The default model used for all runs.\n"));
  process.stdout.write(dim("  Example: deepseek/deepseek-chat-v3-0324, anthropic/claude-opus-4, openai/gpt-4o\n"));
  const modelInput = await ask(rl, "  > ");
  if (modelInput.trim()) current.model = modelInput.trim();

  process.stdout.write("\n");
  const currentFallback = current.models?.[0] ?? "";
  process.stdout.write(cyan("Backup / fallback model") + dim(` (current: ${displayValue(currentFallback)})`) + "\n");
  process.stdout.write(dim("  Used when the primary model returns 429 or is unavailable.\n"));
  process.stdout.write(dim("  Example: openai/gpt-4o-mini, google/gemini-2.0-flash-001\n"));
  const fallbackInput = await ask(rl, "  > ");
  if (fallbackInput.trim()) {
    current.models = [fallbackInput.trim()];
    // Keep vision model if it was set (index 1+)
    if (current.visionModel && !current.models.includes(current.visionModel)) {
      current.models.push(current.visionModel);
    }
  }

  process.stdout.write("\n");
  process.stdout.write(cyan("Vision model") + dim(` (current: ${displayValue(current.visionModel)})`) + "\n");
  process.stdout.write(dim("  Model used when the task includes image inputs. Leave blank to skip.\n"));
  process.stdout.write(dim("  Example: google/gemini-2.0-flash-001, openai/gpt-4o\n"));
  const visionInput = await ask(rl, "  > ");
  if (visionInput.trim()) {
    current.visionModel = visionInput.trim();
    if (!current.models) current.models = [];
    if (!current.models.includes(current.visionModel)) {
      current.models.push(current.visionModel);
    }
  }

  await writeConfig(current);
  process.stdout.write("\n" + green("✓ Config saved to " + CONFIG_PATH) + "\n");
  process.stdout.write(dim("Run `orager setup --show` to review your full config.\n\n"));
}

// ── Custom Setup ──────────────────────────────────────────────────────────────

async function customSetup(rl: readline.Interface): Promise<void> {
  const cfg = await readConfig();

  process.stdout.write("\n" + bold("── Custom Setup ──") + "\n");
  process.stdout.write(dim("Step through every configurable field. Press Enter to keep the current value.\n\n"));

  // ── Section 1: Core ───────────────────────────────────────────────────────
  process.stdout.write(bold("1. Core\n"));

  process.stdout.write(cyan("Primary model") + dim(` [${displayValue(cfg.model)}]`) + "\n");
  const m = await ask(rl, "  > ");
  if (m.trim()) cfg.model = m.trim();

  process.stdout.write(cyan("Fallback models") + dim(` [${displayValue(cfg.models)}]`) + "\n");
  process.stdout.write(dim("  Comma-separated list. Tried in order when primary returns 429.\n"));
  const fl = await ask(rl, "  > ");
  if (fl.trim()) cfg.models = parseCsvList(fl);

  process.stdout.write(cyan("Vision model") + dim(` [${displayValue(cfg.visionModel)}]`) + "\n");
  process.stdout.write(dim("  Model used when image inputs are present.\n"));
  const vm = await ask(rl, "  > ");
  if (vm.trim()) {
    cfg.visionModel = vm.trim();
    if (!cfg.models) cfg.models = [];
    if (!cfg.models.includes(cfg.visionModel)) cfg.models.push(cfg.visionModel);
  }

  // ── Section 2: Agent loop ─────────────────────────────────────────────────
  process.stdout.write("\n" + bold("2. Agent loop\n"));

  process.stdout.write(cyan("maxTurns") + dim(` [${displayValue(cfg.maxTurns)}]`) + " — max tool-call turns per run\n");
  const mt = await ask(rl, "  > ");
  const mtn = parseOptionalNumber(mt);
  if (mtn !== undefined) cfg.maxTurns = mtn;

  process.stdout.write(cyan("maxRetries") + dim(` [${displayValue(cfg.maxRetries)}]`) + " — 429/5xx retry attempts\n");
  const mr = await ask(rl, "  > ");
  const mrn = parseOptionalNumber(mr);
  if (mrn !== undefined) cfg.maxRetries = mrn;

  process.stdout.write(cyan("timeoutSec") + dim(` [${displayValue(cfg.timeoutSec ?? "(none)")}]`) + " — hard timeout in seconds (0 = unlimited)\n");
  const ts = await ask(rl, "  > ");
  const tsn = parseOptionalNumber(ts);
  if (tsn !== undefined) cfg.timeoutSec = tsn === 0 ? undefined : tsn;

  // ── Section 3: Cost limits ────────────────────────────────────────────────
  process.stdout.write("\n" + bold("3. Cost limits\n"));

  process.stdout.write(cyan("maxCostUsd") + dim(` [${displayValue(cfg.maxCostUsd ?? "(none)")}]`) + " — hard stop at this USD cost\n");
  const mc = await ask(rl, "  > ");
  const mcn = parseOptionalNumber(mc);
  if (mcn !== undefined) cfg.maxCostUsd = mcn > 0 ? mcn : undefined;

  process.stdout.write(cyan("maxCostUsdSoft") + dim(` [${displayValue(cfg.maxCostUsdSoft ?? "(none)")}]`) + " — log warning at this USD cost\n");
  const mcs = await ask(rl, "  > ");
  const mcsn = parseOptionalNumber(mcs);
  if (mcsn !== undefined) cfg.maxCostUsdSoft = mcsn > 0 ? mcsn : undefined;

  // ── Section 4: Sampling ───────────────────────────────────────────────────
  process.stdout.write("\n" + bold("4. Sampling (leave blank to use model defaults)\n"));

  for (const [key, label] of [
    ["temperature", "temperature (0–2)"],
    ["top_p", "top_p (0–1)"],
    ["top_k", "top_k (integer)"],
    ["frequency_penalty", "frequency_penalty"],
    ["presence_penalty", "presence_penalty"],
    ["repetition_penalty", "repetition_penalty"],
    ["min_p", "min_p"],
    ["seed", "seed (integer)"],
  ] as [keyof OragerUserConfig, string][]) {
    process.stdout.write(cyan(label) + dim(` [${displayValue(cfg[key])}]`) + "\n");
    const v = await ask(rl, "  > ");
    const n = parseOptionalNumber(v);
    if (n !== undefined) (cfg as Record<string, unknown>)[key] = n;
  }

  // ── Section 5: Reasoning ──────────────────────────────────────────────────
  process.stdout.write("\n" + bold("5. Reasoning (for models that support extended thinking)\n"));

  process.stdout.write(cyan("reasoningEffort") + dim(` [${displayValue(cfg.reasoningEffort ?? "(none)")}]`) + "\n");
  process.stdout.write(dim("  Options: xhigh, high, medium, low, minimal, none\n"));
  const re = await ask(rl, "  > ");
  if (re.trim()) cfg.reasoningEffort = re.trim() as OragerUserConfig["reasoningEffort"];

  process.stdout.write(cyan("reasoningMaxTokens") + dim(` [${displayValue(cfg.reasoningMaxTokens ?? "(none)")}]`) + "\n");
  const rmt = await ask(rl, "  > ");
  const rmtn = parseOptionalNumber(rmt);
  if (rmtn !== undefined) cfg.reasoningMaxTokens = rmtn > 0 ? rmtn : undefined;

  process.stdout.write(cyan("reasoningExclude") + dim(` [${displayValue(cfg.reasoningExclude ?? false)}]`) + " — strip <think> from response (yes/no)\n");
  const rex = await ask(rl, "  > ");
  const rexb = parseOptionalBool(rex);
  if (rexb !== undefined) cfg.reasoningExclude = rexb || undefined;

  // ── Section 6: Provider routing ───────────────────────────────────────────
  process.stdout.write("\n" + bold("6. Provider routing\n"));

  process.stdout.write(cyan("providerOrder") + dim(` [${displayValue(cfg.providerOrder)}]`) + " — preferred providers, comma-separated\n");
  const po = await ask(rl, "  > ");
  if (po.trim()) cfg.providerOrder = parseCsvList(po);

  process.stdout.write(cyan("providerOnly") + dim(` [${displayValue(cfg.providerOnly)}]`) + " — whitelist providers, comma-separated\n");
  const pol = await ask(rl, "  > ");
  if (pol.trim()) cfg.providerOnly = parseCsvList(pol);

  process.stdout.write(cyan("providerIgnore") + dim(` [${displayValue(cfg.providerIgnore)}]`) + " — blacklist providers, comma-separated\n");
  const pig = await ask(rl, "  > ");
  if (pig.trim()) cfg.providerIgnore = parseCsvList(pig);

  process.stdout.write(cyan("sort") + dim(` [${displayValue(cfg.sort ?? "(none)")}]`) + " — optimize for: price, throughput, latency\n");
  const so = await ask(rl, "  > ");
  if (so.trim()) cfg.sort = so.trim() as OragerUserConfig["sort"];

  process.stdout.write(cyan("dataCollection") + dim(` [${displayValue(cfg.dataCollection ?? "(none)")}]`) + " — allow | deny training on your prompts\n");
  const dc = await ask(rl, "  > ");
  if (dc.trim()) cfg.dataCollection = dc.trim() as "allow" | "deny";

  process.stdout.write(cyan("zdr (zero data retention)") + dim(` [${displayValue(cfg.zdr ?? false)}]`) + " — yes/no\n");
  const zdr = await ask(rl, "  > ");
  const zdrb = parseOptionalBool(zdr);
  if (zdrb !== undefined) cfg.zdr = zdrb || undefined;

  // ── Section 7: Context / summarization ────────────────────────────────────
  process.stdout.write("\n" + bold("7. Context & summarization\n"));

  process.stdout.write(cyan("summarizeAt") + dim(` [${displayValue(cfg.summarizeAt ?? "(none)")}]`) + " — fraction 0–1 at which to compress history (e.g. 0.75)\n");
  const sa = await ask(rl, "  > ");
  const san = parseOptionalNumber(sa);
  if (san !== undefined && san > 0 && san <= 1) cfg.summarizeAt = san;

  process.stdout.write(cyan("summarizeModel") + dim(` [${displayValue(cfg.summarizeModel ?? "(same as primary)")}]`) + " — model to use for summarization\n");
  const sm = await ask(rl, "  > ");
  if (sm.trim()) cfg.summarizeModel = sm.trim();

  process.stdout.write(cyan("summarizeKeepRecentTurns") + dim(` [${displayValue(cfg.summarizeKeepRecentTurns ?? 0)}]`) + " — keep last N turns verbatim (0 = summarize all)\n");
  const skr = await ask(rl, "  > ");
  const skrn = parseOptionalNumber(skr);
  if (skrn !== undefined && skrn >= 0) cfg.summarizeKeepRecentTurns = skrn;

  // ── Section 8: Memory ─────────────────────────────────────────────────────
  process.stdout.write("\n" + bold("8. Cross-session memory\n"));

  process.stdout.write(cyan("memory enabled") + dim(` [${displayValue(cfg.memory ?? true)}]`) + " — persist facts across sessions (yes/no)\n");
  const mem = await ask(rl, "  > ");
  const memb = parseOptionalBool(mem);
  if (memb !== undefined) cfg.memory = memb;

  process.stdout.write(cyan("memoryKey") + dim(` [${displayValue(cfg.memoryKey ?? "(auto)")}]`) + " — stable key for your memory store\n");
  const mk = await ask(rl, "  > ");
  if (mk.trim()) cfg.memoryKey = mk.trim();

  process.stdout.write(cyan("memoryMaxChars") + dim(` [${displayValue(cfg.memoryMaxChars ?? 6000)}]`) + " — max chars injected from memory per run\n");
  const mmc = await ask(rl, "  > ");
  const mmcn = parseOptionalNumber(mmc);
  if (mmcn !== undefined && mmcn > 0) cfg.memoryMaxChars = mmcn;

  // ── Section 9: Identity ───────────────────────────────────────────────────
  process.stdout.write("\n" + bold("9. Identity (OpenRouter dashboards)\n"));

  process.stdout.write(cyan("siteUrl") + dim(` [${displayValue(cfg.siteUrl ?? "(none)")}]`) + " — shown as HTTP-Referer\n");
  const su = await ask(rl, "  > ");
  if (su.trim()) cfg.siteUrl = su.trim();

  process.stdout.write(cyan("siteName") + dim(` [${displayValue(cfg.siteName ?? "(none)")}]`) + " — shown in OpenRouter activity logs\n");
  const sn = await ask(rl, "  > ");
  if (sn.trim()) cfg.siteName = sn.trim();

  // ── Section 10: Approval / security ──────────────────────────────────────
  process.stdout.write("\n" + bold("10. Approval & security\n"));

  process.stdout.write(cyan("requireApproval") + dim(` [${displayValue(cfg.requireApproval ?? "(none)")}]`) + "\n");
  process.stdout.write(dim("  Type 'all' to approve all tool calls, or comma-separated tool names (e.g. bash,write_file).\n"));
  const ra = await ask(rl, "  > ");
  if (ra.trim() === "all") {
    cfg.requireApproval = "all";
  } else if (ra.trim()) {
    cfg.requireApproval = parseCsvList(ra);
  }

  process.stdout.write(cyan("sandboxRoot") + dim(` [${displayValue(cfg.sandboxRoot ?? "(none)")}]`) + " — restrict file operations to this directory\n");
  const sr = await ask(rl, "  > ");
  if (sr.trim()) cfg.sandboxRoot = sr.trim();

  // ── Section 11: Agent behavior ────────────────────────────────────────────
  process.stdout.write("\n" + bold("11. Agent behavior\n"));

  for (const [key, label] of [
    ["planMode", "planMode — think before acting (yes/no)"],
    ["injectContext", "injectContext — inject workspace context into prompt (yes/no)"],
    ["tagToolOutputs", "tagToolOutputs — wrap tool results in XML tags (yes/no)"],
    ["useFinishTool", "useFinishTool — require explicit finish signal (yes/no)"],
    ["enableBrowserTools", "enableBrowserTools — allow web browsing tools (yes/no)"],
    ["trackFileChanges", "trackFileChanges — report filesChanged in results (yes/no)"],
  ] as [keyof OragerUserConfig, string][]) {
    process.stdout.write(cyan(label) + dim(` [${displayValue(cfg[key])}]`) + "\n");
    const v = await ask(rl, "  > ");
    const b = parseOptionalBool(v);
    if (b !== undefined) (cfg as Record<string, unknown>)[key] = b;
  }

  // ── Section 12: Profile & misc ────────────────────────────────────────────
  process.stdout.write("\n" + bold("12. Profile & misc\n"));

  process.stdout.write(cyan("profile") + dim(` [${displayValue(cfg.profile ?? "(none)")}]`) + " — named profile: code-review, bug-fix, research, refactor, test-writer, devops\n");
  const pr = await ask(rl, "  > ");
  if (pr.trim()) cfg.profile = pr.trim();

  process.stdout.write(cyan("webhookUrl") + dim(` [${displayValue(cfg.webhookUrl ?? "(none)")}]`) + " — POST results to this URL\n");
  const wu = await ask(rl, "  > ");
  if (wu.trim()) cfg.webhookUrl = wu.trim();

  process.stdout.write(cyan("requiredEnvVars") + dim(` [${displayValue(cfg.requiredEnvVars)}]`) + " — env vars that must be set, comma-separated\n");
  const rev = await ask(rl, "  > ");
  if (rev.trim()) cfg.requiredEnvVars = parseCsvList(rev);

  // ── Save ──────────────────────────────────────────────────────────────────
  await writeConfig(cfg);
  process.stdout.write("\n" + green("✓ Config saved to " + CONFIG_PATH) + "\n");
  process.stdout.write(dim("Run `orager setup --show` to review your full config.\n\n"));
}

// ── Show / show-defaults / reset / edit ──────────────────────────────────────

function printConfig(cfg: OragerUserConfig, title: string): void {
  process.stdout.write("\n" + bold(title) + "\n");
  process.stdout.write(JSON.stringify(cfg, null, 2) + "\n\n");
}

async function showConfig(): Promise<void> {
  const cfg = await readConfig();
  printConfig(cfg, "Current config (" + CONFIG_PATH + ")");
}

async function showDefaults(): Promise<void> {
  printConfig(DEFAULT_CONFIG, "Default config (read-only reference)");
}

async function resetConfig(rl: readline.Interface): Promise<void> {
  const ans = await ask(rl, yellow("Reset all settings to defaults? This cannot be undone. (yes/no) > "));
  if (parseOptionalBool(ans) === true) {
    await writeConfig({ ...DEFAULT_CONFIG });
    process.stdout.write(green("✓ Config reset to defaults.\n\n"));
  } else {
    process.stdout.write(dim("Reset cancelled.\n\n"));
  }
}

async function editConfig(): Promise<void> {
  await fs.mkdir(ORAGER_DIR, { recursive: true });
  // Ensure file exists with defaults if missing
  try {
    await fs.access(CONFIG_PATH);
  } catch {
    await writeConfig({ ...DEFAULT_CONFIG });
  }
  const editor = process.env["VISUAL"] ?? process.env["EDITOR"] ?? "vi";
  process.stdout.write(dim(`Opening ${CONFIG_PATH} in ${editor}...\n`));
  try {
    await execFileAsync(editor, [CONFIG_PATH], { stdio: "inherit" } as Parameters<typeof execFileAsync>[2]);
  } catch {
    process.stdout.write(`orager setup: failed to open editor "${editor}". Set $EDITOR to your preferred editor.\n`);
    process.exit(1);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function runSetupWizard(args: string[]): Promise<void> {
  if (args.includes("--show")) {
    await showConfig();
    return;
  }
  if (args.includes("--show-defaults")) {
    await showDefaults();
    return;
  }
  if (args.includes("--edit")) {
    await editConfig();
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    if (args.includes("--reset")) {
      await resetConfig(rl);
      return;
    }
    if (args.includes("--quick")) {
      await quickSetup(rl);
      return;
    }
    if (args.includes("--custom")) {
      await customSetup(rl);
      return;
    }

    // Interactive mode — ask Quick or Custom
    process.stdout.write("\n" + bold("orager setup") + "\n");
    process.stdout.write(dim("Configure ~/.orager/config.json — your personal defaults for every run.\n\n"));
    process.stdout.write("  " + cyan("q") + " — Quick Setup  (API key + 3 model slots)\n");
    process.stdout.write("  " + cyan("c") + " — Custom Setup (all fields)\n");
    process.stdout.write("  " + cyan("s") + " — Show current config\n");
    process.stdout.write("  " + cyan("d") + " — Show defaults\n");
    process.stdout.write("  " + cyan("r") + " — Reset to defaults\n");
    process.stdout.write("  " + cyan("e") + " — Edit in $EDITOR\n\n");

    const choice = await ask(rl, "Choice [q/c/s/d/r/e]: ");
    switch (choice.trim().toLowerCase()) {
      case "q": case "quick":   await quickSetup(rl);   break;
      case "c": case "custom":  await customSetup(rl);  break;
      case "s": case "show":    await showConfig();      break;
      case "d": case "defaults": await showDefaults();   break;
      case "r": case "reset":   await resetConfig(rl);  break;
      case "e": case "edit":    await editConfig();      break;
      default:
        process.stdout.write(dim("No action taken.\n\n"));
    }
  } finally {
    rl.close();
  }
}
