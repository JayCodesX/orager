/**
 * Shared CLI helpers used by run-command.ts and chat-command.ts (Sprint 7 decomposition).
 *
 * Extracted from src/index.ts. Pure utilities — no side effects, no shared state.
 */

import { emit } from "../emit.js";

// Flags that consume the next token — used when extracting positional args.
const _FLAGS_WITH_VALUE = new Set([
  "--model", "--resume", "--session-id", "--max-turns", "--max-cost-usd",
  "--memory-key", "--timeout-sec", "--max-retries", "--add-dir", "--temperature",
  "--reasoning-effort", "--reasoning-max-tokens", "--cwd", "--site-name",
  "--site-url", "--output-format", "--summarize-at", "--summarize-model",
  "--vision-model", "--profile", "--tools-file", "--system-prompt-file",
  "--sandbox-root", "--approval-mode", "--settings-file", "--hook-error-mode",
  "--max-spawn-depth", "--agent-id", "--repo-url", "--preset", "--transforms",
  "--model-fallback", "--summarize-keep-recent-turns", "--stop", "--file",
]);

export function collectPositionals(argv: string[]): string[] {
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      if (_FLAGS_WITH_VALUE.has(arg)) i++; // skip value token
    } else {
      positionals.push(arg);
    }
  }
  return positionals;
}

export function extractFlag(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  return idx !== -1 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
}

/** Wrap a base emit fn with turn-count and cost summary written to stderr. */
export function makeCliOnEmit(baseEmit: typeof emit): (event: Parameters<typeof emit>[0]) => void {
  const runStart = Date.now();
  let cliTurn = 0;
  let cliTurnStart = runStart;

  return (event) => {
    baseEmit(event);

    if (event.type === "assistant") {
      cliTurnStart = Date.now();
    }
    if (event.type === "tool") {
      const elapsed = ((Date.now() - cliTurnStart) / 1000).toFixed(1);
      process.stderr.write(`\r[turn ${cliTurn + 1} | ${elapsed}s]\x1b[K\n`);
      cliTurn++;
      cliTurnStart = Date.now();
    }
    if (event.type === "result") {
      const totalElapsedS = Math.round((Date.now() - runStart) / 1000);
      const { input_tokens, output_tokens, cache_read_input_tokens } = event.usage;
      const totalTokens = input_tokens + output_tokens;
      const cachedPct = totalTokens > 0
        ? Math.round((cache_read_input_tokens / totalTokens) * 100)
        : 0;
      process.stderr.write(
        `\r\x1b[K` +
        `─────────────────────────────────────\n` +
        `  Turns:    ${event.turnCount ?? cliTurn}\n` +
        `  Tokens:   ${input_tokens.toLocaleString()} prompt / ${output_tokens.toLocaleString()} completion\n` +
        `  Cached:   ${cache_read_input_tokens.toLocaleString()} (${cachedPct}%)\n` +
        `  Cost:     ~$${event.total_cost_usd.toFixed(4)}\n` +
        `  Duration: ${totalElapsedS}s\n` +
        `  Session:  ${event.session_id.slice(0, 8)}...\n` +
        `─────────────────────────────────────\n`,
      );
    }
  };
}
