/**
 * CLI `orager chat` subcommand handler (Sprint 7 decomposition).
 *
 * Extracted from src/index.ts.
 * Interactive multi-turn conversation. Reads user messages from stdin and
 * runs the agent loop for each, preserving session context between turns.
 */

import readline from "node:readline";
import { runAgentLoop } from "../loop.js";
import { emit } from "../emit.js";
import { parseArgs } from "../cli/parse-args.js";
import { extractFlag } from "./cli-helpers.js";

export async function handleChatCommand(
  chatArgv: string[],
  deps: {
    setInterruptSessionId: (id: string) => void;
  },
): Promise<void> {
  const apiKey = (process.env["PROTOCOL_API_KEY"] ?? "").trim();
  if (!apiKey) {
    process.stderr.write("orager: API key not set. Export PROTOCOL_API_KEY.\n");
    process.exit(1);
  }

  const opts = parseArgs(chatArgv);
  const memoryKey = extractFlag(chatArgv, "--memory-key");

  let sessionId: string | null = opts.sessionId;
  let forceResume = !!sessionId;

  const isInteractive = process.stdin.isTTY;

  if (isInteractive) {
    process.stderr.write(`orager chat — model: ${opts.model}\n`);
    if (sessionId) process.stderr.write(`Resuming session: ${sessionId}\n`);
    process.stderr.write(`Type your message and press Enter. Ctrl+D or "exit" to quit.\n\n`);
  }

  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  const showPrompt = () => {
    if (isInteractive) process.stderr.write("you> ");
  };

  showPrompt();

  for await (const line of rl) {
    const userPrompt = line.trim();
    if (!userPrompt) { showPrompt(); continue; }
    if (userPrompt === "exit" || userPrompt === "quit") break;

    if (sessionId) deps.setInterruptSessionId(sessionId);

    let capturedSessionId: string | null = null;

    const chatOnEmit = (event: Parameters<typeof emit>[0]) => {
      if (event.type === "assistant") {
        for (const block of event.message.content) {
          if (block.type === "text") process.stdout.write(block.text);
        }
      } else if (event.type === "result") {
        capturedSessionId = event.session_id;
        process.stdout.write("\n");
      } else {
        emit(event);
      }
    };

    try {
      await runAgentLoop({
        prompt: userPrompt,
        model: opts.model,
        apiKey,
        sessionId,
        forceResume,
        addDirs: opts.addDirs,
        maxTurns: opts.maxTurns,
        maxRetries: opts.maxRetries,
        cwd: process.cwd(),
        dangerouslySkipPermissions: opts.dangerouslySkipPermissions,
        verbose: opts.verbose,
        maxCostUsd: opts.maxCostUsd,
        memoryKey,
        onEmit: chatOnEmit,
      });
    } catch (err) {
      process.stderr.write(`\norager: error: ${err instanceof Error ? err.message : String(err)}\n`);
    }

    if (capturedSessionId) {
      sessionId = capturedSessionId;
      forceResume = true;
    }

    showPrompt();
  }

  if (isInteractive) process.stderr.write("\nGoodbye!\n");
}
