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
import { execFile, spawn } from "node:child_process";
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
  memoryRetrieval?: "local" | "embedding";
  memoryEmbeddingModel?: string;

  // Per-agent API key isolation
  agentApiKey?: string;

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

  // Ollama (local inference — no API key required)
  ollama?: {
    enabled?: boolean;
    model?: string;    // Ollama tag override, e.g. "llama3.1:8b"
    baseUrl?: string;  // default: http://localhost:11434
  };

  // Misc
  profile?: string;
  webhookUrl?: string;
  webhookFormat?: "discord";
  requiredEnvVars?: string[];
}

export const DEFAULT_CONFIG: OragerUserConfig = {
  // Core
  model: "deepseek/deepseek-chat-v3-0324",
  models: [],
  visionModel: "",

  // Loop
  maxTurns: 20,
  maxRetries: 3,
  timeoutSec: 300,

  // Cost limits
  maxCostUsd: 5.0,
  maxCostUsdSoft: 2.0,

  // Sampling
  temperature: 0.7,
  top_p: 1.0,
  top_k: 0,
  frequency_penalty: 0,
  presence_penalty: 0,
  repetition_penalty: 1.0,
  min_p: 0,
  seed: undefined,

  // Reasoning
  reasoningEffort: "medium",
  reasoningMaxTokens: 4096,
  reasoningExclude: false,

  // Provider routing
  providerOrder: [],
  providerOnly: [],
  providerIgnore: [],
  sort: "price",
  dataCollection: "allow",
  zdr: false,

  // Context / summarization
  summarizeAt: 80000,
  summarizeModel: "",
  summarizeKeepRecentTurns: 4,

  // Memory
  memory: true,
  memoryKey: "",
  memoryMaxChars: 10000,
  memoryRetrieval: "local",
  memoryEmbeddingModel: "",

  // Identity
  siteUrl: "",
  siteName: "",

  // Approval / security
  sandboxRoot: "",

  // Agent behavior
  planMode: false,
  injectContext: true,
  tagToolOutputs: true,
  useFinishTool: true,
  enableBrowserTools: false,
  trackFileChanges: true,

  // Misc
  profile: "",
  webhookUrl: "",
  webhookFormat: undefined,
  requiredEnvVars: [],
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

  const apiKeyEnv = process.env["PROTOCOL_API_KEY"] ?? "";

  process.stdout.write(cyan("API Key") + "\n");
  process.stdout.write(dim("  Set PROTOCOL_API_KEY in your shell profile (e.g. ~/.zshrc or ~/.bashrc).\n"));
  if (apiKeyEnv) {
    process.stdout.write(dim(`  Current: set via env (${apiKeyEnv.slice(0, 8)}...)\n`));
  } else {
    process.stdout.write(yellow("  Warning: PROTOCOL_API_KEY is not set in the current environment.\n"));
    process.stdout.write(dim("  Add: export PROTOCOL_API_KEY=sk-or-... to your shell profile.\n"));
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

  {
    const REASONING_EFFORT_VALUES = ["xhigh", "high", "medium", "low", "minimal", "none"] as const;
    process.stdout.write(cyan("reasoningEffort") + dim(` [${displayValue(cfg.reasoningEffort ?? "(none)")}]`) + "\n");
    process.stdout.write(dim("  Options: xhigh, high, medium, low, minimal, none  (blank = unset)\n"));
    for (;;) {
      const re = await ask(rl, "  > ");
      if (!re.trim()) break;
      if ((REASONING_EFFORT_VALUES as readonly string[]).includes(re.trim())) {
        cfg.reasoningEffort = re.trim() as OragerUserConfig["reasoningEffort"];
        break;
      }
      process.stdout.write(yellow(`  Invalid value "${re.trim()}". Choose from: ${REASONING_EFFORT_VALUES.join(", ")}\n`));
    }
  }

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

  {
    const SORT_VALUES = ["price", "throughput", "latency"] as const;
    process.stdout.write(cyan("sort") + dim(` [${displayValue(cfg.sort ?? "(none)")}]`) + " — optimize for: price, throughput, latency  (blank = unset)\n");
    for (;;) {
      const so = await ask(rl, "  > ");
      if (!so.trim()) break;
      if ((SORT_VALUES as readonly string[]).includes(so.trim())) {
        cfg.sort = so.trim() as OragerUserConfig["sort"];
        break;
      }
      process.stdout.write(yellow(`  Invalid value "${so.trim()}". Choose from: ${SORT_VALUES.join(", ")}\n`));
    }
  }

  {
    const DC_VALUES = ["allow", "deny"] as const;
    process.stdout.write(cyan("dataCollection") + dim(` [${displayValue(cfg.dataCollection ?? "(none)")}]`) + " — allow | deny training on your prompts  (blank = unset)\n");
    for (;;) {
      const dc = await ask(rl, "  > ");
      if (!dc.trim()) break;
      if ((DC_VALUES as readonly string[]).includes(dc.trim())) {
        cfg.dataCollection = dc.trim() as "allow" | "deny";
        break;
      }
      process.stdout.write(yellow(`  Invalid value "${dc.trim()}". Choose from: ${DC_VALUES.join(", ")}\n`));
    }
  }

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

  {
    const MR_VALUES = ["local", "embedding"] as const;
    process.stdout.write(cyan("memoryRetrieval") + dim(` [${displayValue(cfg.memoryRetrieval ?? "local")}]`) + " — local (FTS) or embedding (cosine similarity)  (blank = default)\n");
    for (;;) {
      const mr = await ask(rl, "  > ");
      if (!mr.trim()) break;
      if ((MR_VALUES as readonly string[]).includes(mr.trim())) {
        cfg.memoryRetrieval = mr.trim() as "local" | "embedding";
        break;
      }
      process.stdout.write(yellow(`  Invalid value "${mr.trim()}". Choose from: ${MR_VALUES.join(", ")}\n`));
    }
  }

  process.stdout.write(cyan("memoryEmbeddingModel") + dim(` [${displayValue(cfg.memoryEmbeddingModel ?? "(none)")}]`) + " — OpenRouter model for embedding retrieval (e.g. openai/text-embedding-3-small)\n");
  const mem2 = await ask(rl, "  > ");
  if (mem2.trim()) cfg.memoryEmbeddingModel = mem2.trim();

  process.stdout.write(cyan("agentApiKey") + dim(` [${displayValue(cfg.agentApiKey ? cfg.agentApiKey.slice(0, 8) + "..." : "(none)")}]`) + " — per-agent OpenRouter key (isolates rate limits; leave blank to use global key)\n");
  const aak = await ask(rl, "  > ");
  if (aak.trim()) cfg.agentApiKey = aak.trim();

  // ── Section 9: Identity ───────────────────────────────────────────────────
  process.stdout.write("\n" + bold("9. Identity (OpenRouter dashboards)\n"));

  process.stdout.write(cyan("siteUrl") + dim(` [${displayValue(cfg.siteUrl ?? "(none)")}]`) + " — shown as HTTP-Referer (must be http:// or https://)\n");
  for (;;) {
    const su = await ask(rl, "  > ");
    if (!su.trim()) break;
    try {
      const parsed = new URL(su.trim());
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("not http/https");
      cfg.siteUrl = su.trim();
      break;
    } catch {
      process.stdout.write(yellow("  Invalid URL — must start with http:// or https://\n"));
    }
  }

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

  // ── Section 12: Ollama (local inference) ──────────────────────────────────
  process.stdout.write("\n" + bold("12. Ollama (local inference)") + "\n");
  process.stdout.write(dim("  Route all LLM calls to a local Ollama server instead of OpenRouter.\n"));
  process.stdout.write(dim("  Install: https://ollama.com — then `ollama pull <model>`\n\n"));

  process.stdout.write(cyan("ollama enabled") + dim(` [${displayValue(cfg.ollama?.enabled ?? false)}]`) + " — use local Ollama instead of OpenRouter (yes/no)\n");
  const olEn = await ask(rl, "  > ");
  const olEnb = parseOptionalBool(olEn);
  if (olEnb !== undefined) {
    if (!cfg.ollama) cfg.ollama = {};
    cfg.ollama.enabled = olEnb || undefined;
  }

  process.stdout.write(cyan("ollama url") + dim(` [${displayValue(cfg.ollama?.baseUrl ?? "http://localhost:11434")}]`) + " — Ollama server URL (leave blank for default)\n");
  const olUrl = await ask(rl, "  > ");
  if (olUrl.trim()) {
    try {
      new URL(olUrl.trim());
      if (!cfg.ollama) cfg.ollama = {};
      cfg.ollama.baseUrl = olUrl.trim();
    } catch {
      process.stdout.write(yellow("  Invalid URL — keeping current value.\n"));
    }
  }

  process.stdout.write(cyan("ollama model") + dim(` [${displayValue(cfg.ollama?.model ?? "(auto-mapped from primary model)")}]`) + " — Ollama tag override, e.g. llama3.1:8b (leave blank for auto)\n");
  const olMod = await ask(rl, "  > ");
  if (olMod.trim()) {
    if (!cfg.ollama) cfg.ollama = {};
    cfg.ollama.model = olMod.trim();
  }

  // ── Section 13: Profile & misc ────────────────────────────────────────────
  process.stdout.write("\n" + bold("13. Profile & misc\n"));

  process.stdout.write(cyan("profile") + dim(` [${displayValue(cfg.profile ?? "(none)")}]`) + " — named profile: code-review, bug-fix, research, refactor, test-writer, devops\n");
  const pr = await ask(rl, "  > ");
  if (pr.trim()) cfg.profile = pr.trim();

  process.stdout.write(cyan("webhookUrl") + dim(` [${displayValue(cfg.webhookUrl ?? "(none)")}]`) + " — POST results to this URL\n");
  const wu = await ask(rl, "  > ");
  if (wu.trim()) cfg.webhookUrl = wu.trim();

  process.stdout.write(cyan("webhookFormat") + dim(` [${displayValue(cfg.webhookFormat ?? "raw")}]`) + " — payload format: leave blank for raw JSON, or type 'discord' for Discord embeds\n");
  const wf = await ask(rl, "  > ");
  if (wf.trim() === "discord") cfg.webhookFormat = "discord";
  else if (wf.trim() === "" || wf.trim() === "raw") { /* keep existing */ }
  else if (wf.trim()) process.stdout.write(dim("  (unrecognised format — leaving unchanged)\n"));

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

async function checkConfig(): Promise<void> {
  process.stdout.write("\n" + bold("── Config check ──") + "\n");

  // ── 1. File existence & parse ──────────────────────────────────────────────
  let cfg: OragerUserConfig;
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf8");
    cfg = JSON.parse(raw) as OragerUserConfig;
    process.stdout.write(green("✓ Config file found: ") + dim(CONFIG_PATH) + "\n");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      process.stdout.write(yellow("⚠ Config file not found — using built-in defaults.\n"));
      process.stdout.write(dim("  Run `orager setup` to create one.\n\n"));
    } else {
      process.stdout.write(`✗ Config file unreadable: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    return;
  }

  // ── 2. Field validation ────────────────────────────────────────────────────
  const issues: string[] = [];

  if (cfg.reasoningEffort !== undefined) {
    const valid = ["xhigh", "high", "medium", "low", "minimal", "none"];
    if (!valid.includes(cfg.reasoningEffort)) {
      issues.push(`reasoningEffort "${cfg.reasoningEffort}" is not valid (expected: ${valid.join(", ")})`);
    }
  }
  if (cfg.sort !== undefined) {
    const valid = ["price", "throughput", "latency"];
    if (!valid.includes(cfg.sort)) {
      issues.push(`sort "${cfg.sort}" is not valid (expected: ${valid.join(", ")})`);
    }
  }
  if (cfg.dataCollection !== undefined) {
    const valid = ["allow", "deny"];
    if (!valid.includes(cfg.dataCollection)) {
      issues.push(`dataCollection "${cfg.dataCollection}" is not valid (expected: ${valid.join(", ")})`);
    }
  }
  if (cfg.siteUrl !== undefined) {
    try {
      const u = new URL(cfg.siteUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("not http/https");
    } catch {
      issues.push(`siteUrl "${cfg.siteUrl}" is not a valid http/https URL`);
    }
  }
  if (cfg.webhookUrl !== undefined) {
    try {
      const u = new URL(cfg.webhookUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("not http/https");
    } catch {
      issues.push(`webhookUrl "${cfg.webhookUrl}" is not a valid http/https URL`);
    }
  }
  if (cfg.webhookFormat !== undefined && cfg.webhookFormat !== "discord") {
    issues.push(`webhookFormat "${cfg.webhookFormat}" is not valid — only "discord" is supported`);
  }
  if (cfg.memoryRetrieval !== undefined && cfg.memoryRetrieval !== "local" && cfg.memoryRetrieval !== "embedding") {
    issues.push(`memoryRetrieval "${cfg.memoryRetrieval}" is not valid (expected: local, embedding)`);
  }
  if (cfg.memoryRetrieval === "embedding" && !cfg.memoryEmbeddingModel) {
    issues.push("memoryRetrieval is \"embedding\" but memoryEmbeddingModel is not set");
  }

  if (issues.length > 0) {
    process.stdout.write(yellow(`⚠ ${issues.length} validation issue${issues.length > 1 ? "s" : ""} found:\n`));
    for (const issue of issues) {
      process.stdout.write(`  • ${issue}\n`);
    }
  } else {
    process.stdout.write(green("✓ All config fields are valid\n"));
  }

  // ── 3. API key check ───────────────────────────────────────────────────────
  const apiKey = process.env["PROTOCOL_API_KEY"] ?? cfg.agentApiKey ?? "";
  if (!apiKey) {
    process.stdout.write(yellow("⚠ No API key found — set PROTOCOL_API_KEY in your environment.\n"));
  } else {
    process.stdout.write(dim(`\nChecking API key (${apiKey.slice(0, 8)}...) against OpenRouter...\n`));
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch("https://openrouter.ai/api/v1/auth/key", {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.ok) {
        const data = await res.json() as { data?: { label?: string; usage?: number; limit?: number | null } };
        const label = data?.data?.label ?? "(unnamed)";
        const usage = data?.data?.usage ?? 0;
        const limit = data?.data?.limit;
        const limitStr = limit != null ? `$${limit.toFixed(2)} limit` : "no limit";
        process.stdout.write(green(`✓ API key valid — "${label}" | $${usage.toFixed(4)} used | ${limitStr}\n`));
      } else if (res.status === 401) {
        process.stdout.write(`✗ API key is invalid or revoked (HTTP 401)\n`);
      } else {
        process.stdout.write(yellow(`⚠ OpenRouter returned HTTP ${res.status} — key may still be valid\n`));
      }
    } catch (err) {
      process.stdout.write(yellow(`⚠ Could not reach OpenRouter: ${err instanceof Error ? err.message : String(err)}\n`));
    }
  }

  // ── 4. Summary ─────────────────────────────────────────────────────────────
  process.stdout.write("\n" + dim("Run `orager setup --show` to see full config.\n\n"));
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

// ── Browser UI setup path ─────────────────────────────────────────────────────

const UI_PORT_FILE = path.join(ORAGER_DIR, "ui.port");
const UI_PID_FILE  = path.join(ORAGER_DIR, "ui.pid");
const UI_DEFAULT_PORT = 3457;

async function probeUiServer(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/config`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function findRunningUiPort(): Promise<number | null> {
  try {
    const raw = await fs.readFile(UI_PORT_FILE, "utf8");
    const port = parseInt(raw.trim(), 10);
    if (!isNaN(port) && await probeUiServer(port)) return port;
  } catch { /* not running */ }
  return null;
}

function tryOpenBrowser(url: string): void {
  try {
    const cmd  = process.platform === "darwin" ? "open"
      : process.platform === "win32"  ? "cmd"
      : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", url] : [url];
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  } catch { /* ignore — browser open is best-effort */ }
}

async function setupViaUiServer(rl: readline.Interface): Promise<void> {
  // 1. Check if already running
  let port = await findRunningUiPort();
  let spawned: ReturnType<typeof spawn> | null = null;

  if (port !== null) {
    process.stdout.write("\n" + green("✓ orager UI server is already running") + "\n");
  } else {
    port = UI_DEFAULT_PORT;

    // Check if another process owns the PID file but isn't responding — warn rather than fail
    try {
      const pidRaw = await fs.readFile(UI_PID_FILE, "utf8");
      const pidData = JSON.parse(pidRaw) as { pid?: number; port?: number };
      if (pidData.pid) {
        try { process.kill(pidData.pid, 0); } catch { /* stale */ }
        // Process alive but not responding on expected port — use its port
        if (pidData.port) port = pidData.port;
      }
    } catch { /* no PID file */ }

    process.stdout.write("\n" + dim("Starting orager UI server on port " + port + "...") + "\n");

    // Spawn a detached UI server as a child of the current process.
    // stdio is piped to /dev/null so it does not pollute the terminal.
    spawned = spawn(
      process.execPath,
      [process.argv[1]!, "ui", "--port", String(port)],
      { detached: false, stdio: "ignore" },
    );

    spawned.on("error", (err) => {
      process.stdout.write(yellow(`  Warning: could not start UI server: ${err.message}\n`));
    });

    // Give the server a moment to bind
    await new Promise<void>((resolve) => setTimeout(resolve, 900));

    // Verify it came up
    if (!await probeUiServer(port)) {
      process.stdout.write(yellow("  Warning: UI server did not respond in time.\n"));
      process.stdout.write(dim("  Try running `orager ui` manually in a separate terminal.\n\n"));
      if (spawned) spawned.kill();
      return;
    }
  }

  const url = `http://127.0.0.1:${port}`;
  process.stdout.write(
    "\n" +
    bold("  orager configuration UI: ") + cyan(url) + "\n\n" +
    dim("  Opening in your browser…\n") +
    dim("  Configure your settings there, then press Enter here when finished.\n\n"),
  );

  tryOpenBrowser(url);

  await ask(rl, "  Press Enter when done > ");

  // Shut down the server if we started it
  if (spawned) {
    spawned.kill("SIGTERM");
    process.stdout.write(dim("\n  UI server stopped.\n"));
  }

  process.stdout.write(green("✓ Done.\n\n"));
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
  if (args.includes("--check")) {
    await checkConfig();
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

    // Interactive mode — choose configuration method
    process.stdout.write("\n" + bold("orager setup") + "\n");
    process.stdout.write(dim("Configure ~/.orager/config.json — your personal defaults for every run.\n\n"));
    process.stdout.write("How would you like to configure orager?\n\n");
    process.stdout.write("  " + cyan("1") + " — " + bold("Browser UI") +
      dim("  (recommended — starts http://127.0.0.1:" + UI_DEFAULT_PORT + ")") + "\n");
    process.stdout.write("  " + cyan("2") + " — " + "Command line" +
      dim("  (quick / custom / show / reset / edit)") + "\n\n");

    const methodChoice = await ask(rl, "Choice [1]: ");
    const method = methodChoice.trim() || "1";

    if (method === "1" || method.toLowerCase() === "browser" || method.toLowerCase() === "ui") {
      await setupViaUiServer(rl);
      return;
    }

    // Command-line menu
    process.stdout.write("\n" + dim("Command-line options:\n\n"));
    process.stdout.write("  " + cyan("q") + " — Quick Setup  (API key + 3 model slots)\n");
    process.stdout.write("  " + cyan("c") + " — Custom Setup (all fields)\n");
    process.stdout.write("  " + cyan("s") + " — Show current config\n");
    process.stdout.write("  " + cyan("d") + " — Show defaults\n");
    process.stdout.write("  " + cyan("r") + " — Reset to defaults\n");
    process.stdout.write("  " + cyan("e") + " — Edit in $EDITOR\n\n");

    const choice = await ask(rl, "Choice [q/c/s/d/r/e]: ");
    switch (choice.trim().toLowerCase()) {
      case "q": case "quick":    await quickSetup(rl);  break;
      case "c": case "custom":   await customSetup(rl); break;
      case "s": case "show":     await showConfig();     break;
      case "d": case "defaults": await showDefaults();   break;
      case "r": case "reset":    await resetConfig(rl); break;
      case "e": case "edit":     await editConfig();     break;
      default:
        process.stdout.write(dim("No action taken.\n\n"));
    }
  } finally {
    rl.close();
  }
}
