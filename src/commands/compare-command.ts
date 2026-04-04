/**
 * `orager compare` — fan out a prompt to multiple models and display results side-by-side.
 *
 * Usage:
 *   orager compare "prompt" --models m1,m2,...
 *   orager compare "prompt" --models m1 --models m2
 *   orager compare "prompt" --models m1,m2 --system "You are a helpful assistant"
 *   orager compare "prompt" --models m1,m2 --temperature 0.7 --max-tokens 1024
 *
 * Examples:
 *   orager compare "What is 2+2?" --models anthropic/claude-3-haiku,openai/gpt-4o-mini
 *   orager compare "Write a haiku" --models deepseek/deepseek-chat --models gemini/gemini-flash-1.5
 */

import { runCompare } from "../compare.js";
import type { CompareChunk } from "../compare.js";

interface CompareCommandOptions {
  prompt: string;
  models: string[];
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
}

function parseArgs(argv: string[]): CompareCommandOptions | null {
  const args = [...argv];

  if (args[0] === "--help" || args[0] === "-h") {
    printHelp();
    process.exit(0);
  }

  // First positional argument is the prompt
  let prompt = "";
  const models: string[] = [];
  let systemPrompt: string | undefined;
  let temperature: number | undefined;
  let maxTokens: number | undefined;

  let i = 0;

  // Consume the prompt (first non-flag argument)
  while (i < args.length && args[i]!.startsWith("--")) i++;
  if (i < args.length) {
    prompt = args[i]!;
    args.splice(i, 1);
  }

  // Parse flags
  for (let j = 0; j < args.length; j++) {
    const arg = args[j]!;
    if (arg === "--models" || arg === "-m") {
      const val = args[++j];
      if (val) {
        // Support comma-separated or repeated --models flags
        models.push(...val.split(",").map((s) => s.trim()).filter(Boolean));
      }
    } else if (arg.startsWith("--models=")) {
      const val = arg.slice("--models=".length);
      models.push(...val.split(",").map((s) => s.trim()).filter(Boolean));
    } else if (arg === "--system" || arg === "--system-prompt") {
      systemPrompt = args[++j];
    } else if (arg.startsWith("--system=")) {
      systemPrompt = arg.slice("--system=".length);
    } else if (arg === "--temperature" || arg === "-t") {
      temperature = parseFloat(args[++j] ?? "");
    } else if (arg.startsWith("--temperature=")) {
      temperature = parseFloat(arg.slice("--temperature=".length));
    } else if (arg === "--max-tokens") {
      maxTokens = parseInt(args[++j] ?? "", 10);
    } else if (arg.startsWith("--max-tokens=")) {
      maxTokens = parseInt(arg.slice("--max-tokens=".length), 10);
    } else if (!arg.startsWith("-")) {
      // Treat extra positional as part of prompt (allows no-quote usage)
      if (prompt) {
        prompt += " " + arg;
      } else {
        prompt = arg;
      }
    }
  }

  if (!prompt) {
    process.stderr.write("Error: prompt is required.\n");
    process.stderr.write("Usage: orager compare <prompt> --models <model1,model2,...>\n");
    return null;
  }

  if (models.length === 0) {
    process.stderr.write("Error: at least one model is required (--models).\n");
    process.stderr.write("Usage: orager compare <prompt> --models <model1,model2,...>\n");
    return null;
  }

  return { prompt, models, systemPrompt, temperature, maxTokens };
}

function printHelp(): void {
  process.stdout.write(`
orager compare — compare a prompt across multiple models

Usage:
  orager compare <prompt> --models <m1,m2,...> [options]

Options:
  --models, -m <list>       Comma-separated model list (repeatable)
  --system <text>           System prompt to prepend
  --temperature, -t <n>     Sampling temperature (0-2)
  --max-tokens <n>          Max completion tokens
  --help, -h                Show this help

Examples:
  orager compare "What is 2+2?" --models anthropic/claude-3-haiku,openai/gpt-4o-mini
  orager compare "Write a haiku" \\
    --models deepseek/deepseek-chat \\
    --models gemini/gemini-flash-1.5 \\
    --temperature 0.9
`);
}

// ── Terminal output helpers ───────────────────────────────────────────────────

const HEADER_WIDTH = 60;

function modelHeader(model: string): string {
  const label = ` ${model} `;
  const pad = Math.max(0, HEADER_WIDTH - label.length);
  const left = Math.floor(pad / 2);
  const right = pad - left;
  return "─".repeat(left) + label + "─".repeat(right);
}

function formatTokens(t: { prompt: number; completion: number }): string {
  return `${t.prompt} prompt / ${t.completion} completion`;
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function handleCompareCommand(argv: string[]): Promise<void> {
  const opts = parseArgs(argv);
  if (!opts) {
    process.exit(1);
  }

  const { prompt, models, systemPrompt, temperature, maxTokens } = opts;

  // Buffer per-model content for final summary display
  const modelContent: Record<string, string> = {};
  for (const m of models) modelContent[m] = "";

  // Track which models have printed their header yet
  const headerPrinted = new Set<string>();

  const onChunk = (chunk: CompareChunk): void => {
    if (!headerPrinted.has(chunk.model)) {
      headerPrinted.add(chunk.model);
      process.stdout.write("\n" + modelHeader(chunk.model) + "\n");
    }

    if (!chunk.done) {
      process.stdout.write(chunk.chunk);
      modelContent[chunk.model] = (modelContent[chunk.model] ?? "") + chunk.chunk;
      return;
    }

    // done=true — print stats footer
    process.stdout.write("\n");
    if (chunk.error) {
      process.stdout.write(`  ⚠  Error: ${chunk.error}\n`);
    } else {
      const tokenStr = chunk.tokens ? `  tokens: ${formatTokens(chunk.tokens)}` : "";
      const latencyStr = chunk.latencyMs !== undefined ? `  latency: ${chunk.latencyMs}ms` : "";
      if (tokenStr || latencyStr) {
        process.stdout.write(`${tokenStr}${latencyStr}\n`);
      }
    }
  };

  process.stdout.write(`\nComparing ${models.length} model${models.length !== 1 ? "s" : ""}...\n`);
  process.stdout.write(`Prompt: ${prompt.slice(0, 80)}${prompt.length > 80 ? "…" : ""}\n`);

  try {
    const result = await runCompare(
      { prompt, models, systemPrompt, temperature, maxTokens },
      onChunk,
    );

    // Final summary table
    process.stdout.write("\n" + "═".repeat(HEADER_WIDTH) + "\n");
    process.stdout.write(" Summary\n");
    process.stdout.write("─".repeat(HEADER_WIDTH) + "\n");
    for (const r of result.results) {
      const status = r.error ? `✗ ${r.error.slice(0, 40)}` : "✓";
      const tokens = formatTokens(r.tokens);
      process.stdout.write(`  ${status}  ${r.model.padEnd(35)} ${r.latencyMs}ms  ${tokens}\n`);
    }
    process.stdout.write("═".repeat(HEADER_WIDTH) + "\n\n");
  } catch (err) {
    process.stderr.write(`\nError: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
