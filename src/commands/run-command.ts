/**
 * CLI `orager run` subcommand handler (Sprint 7 decomposition).
 *
 * Extracted from src/index.ts.
 * Non-interactive: run the agent once with a given prompt and exit.
 */

import { runAgentLoop } from "../loop.js";
import { emit } from "../emit.js";
import { parseArgs, readStdin } from "../cli/parse-args.js";
import { makeCliOnEmit, collectPositionals, extractFlag } from "./cli-helpers.js";
import { createTrajectoryLogger, pruneOldTrajectories } from "../trajectory-logger.js";
import { extractSkillFromTrajectory, trajectoryPath, DEFAULT_SKILLBANK_CONFIG } from "../skillbank.js";

export async function handleRunCommand(
  runArgv: string[],
  deps: {
    releaseCliPidLock: () => Promise<void>;
    setInterruptSessionId: (id: string) => void;
  },
): Promise<void> {
  const apiKey = (process.env["PROTOCOL_API_KEY"] ?? "").trim();
  if (!apiKey) {
    process.stderr.write("orager: API key not set. Export PROTOCOL_API_KEY.\n");
    process.exit(1);
  }

  const opts = parseArgs(runArgv);
  const memoryKey = extractFlag(runArgv, "--memory-key");
  const subprocessEnabled = runArgv.includes("--subprocess");

  const positionals = collectPositionals(runArgv);
  let prompt = positionals.join(" ").trim();

  if (!prompt) {
    if (!process.stdin.isTTY) {
      prompt = await readStdin();
    } else {
      process.stderr.write(
        "orager run: provide a prompt argument or pipe it via stdin\n" +
        "  Example: orager run \"write a hello world script\"\n",
      );
      process.exit(1);
    }
  }

  prompt = prompt.trim();
  if (!prompt) {
    process.stderr.write("orager run: empty prompt\n");
    process.exit(1);
  }

  if (opts.sessionId) deps.setInterruptSessionId(opts.sessionId);

  const trajLogger = createTrajectoryLogger(prompt, opts.model, process.cwd());
  const baseOnEmit = makeCliOnEmit(emit);
  const wrappedOnEmit = (event: Parameters<typeof baseOnEmit>[0]) => {
    trajLogger.onEvent(event);
    baseOnEmit(event);
  };

  let _runSubtype = "unknown";
  let _runSessionId: string | null = opts.sessionId;
  const resultTrackingEmit = (event: Parameters<typeof baseOnEmit>[0]) => {
    if (event.type === "result") {
      _runSubtype = event.subtype;
      _runSessionId = event.session_id;
    } else if (event.type === "system" && event.subtype === "init") {
      _runSessionId = event.session_id;
    }
    wrappedOnEmit(event);
  };

  const retentionDays = DEFAULT_SKILLBANK_CONFIG.retentionDays;
  pruneOldTrajectories(retentionDays).catch(() => { /* non-fatal */ });

  try {
    await runAgentLoop({
      prompt,
      model: opts.model,
      apiKey,
      sessionId: opts.sessionId,
      addDirs: opts.addDirs,
      maxTurns: opts.maxTurns,
      maxRetries: opts.maxRetries,
      cwd: process.cwd(),
      dangerouslySkipPermissions: opts.dangerouslySkipPermissions,
      verbose: opts.verbose,
      maxCostUsd: opts.maxCostUsd,
      memoryKey,
      onEmit: resultTrackingEmit,
      subprocess: subprocessEnabled ? { enabled: true } : undefined,
      onOmlsEscalation: (teacherModel, signal) => {
        trajLogger.markDistillable(teacherModel, signal);
      },
    });
  } finally {
    await trajLogger.finalize().catch(() => { /* non-fatal */ });

    const skillbank = DEFAULT_SKILLBANK_CONFIG;
    const isFailed = _runSubtype !== "success" && _runSubtype !== "interrupted" && _runSubtype !== "unknown";
    const _embeddingModel = process.env["ORAGER_EMBEDDING_MODEL"] ?? "";
    if (skillbank.autoExtract && isFailed && _runSessionId && _embeddingModel) {
      const embeddingModel = _embeddingModel;
      const model = opts.model;
      const sid = _runSessionId;
      extractSkillFromTrajectory(
        trajectoryPath(sid),
        sid,
        model,
        apiKey,
        embeddingModel,
      ).catch(() => { /* non-fatal */ });
    }

    await deps.releaseCliPidLock();
  }
}
