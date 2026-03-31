import process from "node:process";
import type { CliOptions } from "../types.js";

// ── Stdin reading ─────────────────────────────────────────────────────────────

export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    process.stderr.write(
      "orager: no input provided. Usage: echo '<prompt>' | orager --print -\n"
    );
    process.exit(1);
  }

  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

// ── Arg parsing ───────────────────────────────────────────────────────────────

export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    model: "deepseek/deepseek-chat-v3-2",
    models: [],
    sessionId: null,
    addDirs: [],
    maxTurns: 20,
    maxRetries: 3,
    forceResume: false,
    dangerouslySkipPermissions: false,
    verbose: false,
    outputFormat: "stream-json",
    toolsFiles: [],
    useFinishTool: false,
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    switch (arg) {
      case "--print": {
        // consume the next token (expected to be "-")
        i++;
        break;
      }
      case "--output-format": {
        const val = argv[++i];
        if (val === "stream-json" || val === "text") {
          opts.outputFormat = val;
        }
        break;
      }
      case "--model": {
        opts.model = argv[++i];
        break;
      }
      case "--resume": {
        opts.sessionId = argv[++i] ?? null;
        break;
      }
      case "--force-resume": {
        opts.forceResume = true;
        break;
      }
      case "--max-retries": {
        const n = parseInt(argv[++i], 10);
        if (!isNaN(n) && n >= 0) opts.maxRetries = n;
        break;
      }
      case "--timeout-sec": {
        const n = parseFloat(argv[++i]);
        if (!isNaN(n) && n >= 0) opts.timeoutSec = n;
        break;
      }
      case "--require-env": {
        const s = argv[++i];
        if (s) opts.requiredEnvVars = s.split(",").map((v) => v.trim()).filter(Boolean);
        break;
      }
      case "--add-dir": {
        const dir = argv[++i];
        if (dir) opts.addDirs.push(dir);
        break;
      }
      case "--max-turns": {
        const n = parseInt(argv[++i], 10);
        if (!isNaN(n)) opts.maxTurns = n;
        break;
      }
      case "--dangerously-skip-permissions": {
        opts.dangerouslySkipPermissions = true;
        break;
      }
      case "--verbose": {
        opts.verbose = true;
        break;
      }
      case "--sandbox-root": {
        opts.sandboxRoot = argv[++i];
        break;
      }
      case "--tools-file": {
        const f = argv[++i];
        if (f) opts.toolsFiles.push(f);
        break;
      }
      case "--require-approval": {
        opts.requireApproval = "all";
        break;
      }
      case "--require-approval-for": {
        const s = argv[++i];
        if (s) opts.requireApproval = s.split(",").map((t) => t.trim()).filter(Boolean);
        break;
      }
      case "--use-finish-tool": {
        opts.useFinishTool = true;
        break;
      }
      case "--max-cost-usd": {
        const n = parseFloat(argv[++i]);
        if (!isNaN(n) && n > 0) opts.maxCostUsd = n;
        break;
      }
      case "--cost-per-input-token": {
        const n = parseFloat(argv[++i]);
        if (!isNaN(n) && n >= 0) opts.costPerInputToken = n;
        break;
      }
      case "--cost-per-output-token": {
        const n = parseFloat(argv[++i]);
        if (!isNaN(n) && n >= 0) opts.costPerOutputToken = n;
        break;
      }
      case "--site-url": {
        opts.siteUrl = argv[++i];
        break;
      }
      case "--site-name": {
        opts.siteName = argv[++i];
        break;
      }
      case "--temperature": {
        const n = parseFloat(argv[++i]);
        if (!isNaN(n)) opts.temperature = n;
        break;
      }
      case "--top-p": {
        const n = parseFloat(argv[++i]);
        if (!isNaN(n)) opts.top_p = n;
        break;
      }
      case "--top-k": {
        const n = parseInt(argv[++i], 10);
        if (!isNaN(n)) opts.top_k = n;
        break;
      }
      case "--frequency-penalty": {
        const n = parseFloat(argv[++i]);
        if (!isNaN(n)) opts.frequency_penalty = n;
        break;
      }
      case "--presence-penalty": {
        const n = parseFloat(argv[++i]);
        if (!isNaN(n)) opts.presence_penalty = n;
        break;
      }
      case "--repetition-penalty": {
        const n = parseFloat(argv[++i]);
        if (!isNaN(n)) opts.repetition_penalty = n;
        break;
      }
      case "--min-p": {
        const n = parseFloat(argv[++i]);
        if (!isNaN(n)) opts.min_p = n;
        break;
      }
      case "--seed": {
        const n = parseInt(argv[++i], 10);
        if (!isNaN(n)) opts.seed = n;
        break;
      }
      case "--stop": {
        const s = argv[++i];
        if (s) {
          if (!opts.stop) opts.stop = [];
          opts.stop.push(s);
        }
        break;
      }
      case "--tool-choice": {
        opts.tool_choice = argv[++i] as "none" | "auto" | "required";
        break;
      }
      case "--parallel-tool-calls": {
        opts.parallel_tool_calls = true;
        break;
      }
      case "--no-parallel-tool-calls": {
        opts.parallel_tool_calls = false;
        break;
      }
      case "--reasoning-effort": {
        opts.reasoningEffort = argv[++i] as "xhigh" | "high" | "medium" | "low" | "minimal" | "none";
        break;
      }
      case "--reasoning-max-tokens": {
        const n = parseInt(argv[++i], 10);
        if (!isNaN(n)) opts.reasoningMaxTokens = n;
        break;
      }
      case "--reasoning-exclude": {
        opts.reasoningExclude = true;
        break;
      }
      case "--provider-order": {
        const s = argv[++i];
        if (s) opts.providerOrder = s.split(",").map((p) => p.trim()).filter(Boolean);
        break;
      }
      case "--provider-only": {
        const s = argv[++i];
        if (s) opts.providerOnly = s.split(",").map((p) => p.trim()).filter(Boolean);
        break;
      }
      case "--provider-ignore": {
        const s = argv[++i];
        if (s) opts.providerIgnore = s.split(",").map((p) => p.trim()).filter(Boolean);
        break;
      }
      case "--data-collection": {
        opts.dataCollection = argv[++i] as "allow" | "deny";
        break;
      }
      case "--zdr": {
        opts.zdr = true;
        break;
      }
      case "--sort": {
        opts.sort = argv[++i] as "price" | "throughput" | "latency";
        break;
      }
      case "--quantizations": {
        const s = argv[++i];
        if (s) opts.quantizations = s.split(",").map((q) => q.trim()).filter(Boolean);
        break;
      }
      case "--require-parameters": {
        opts.require_parameters = true;
        break;
      }
      case "--preset": {
        opts.preset = argv[++i];
        break;
      }
      case "--transforms": {
        const s = argv[++i];
        if (s) opts.transforms = s.split(",").map((t) => t.trim()).filter(Boolean);
        break;
      }
      case "--model-fallback": {
        const s = argv[++i];
        if (s) opts.models.push(s);
        break;
      }
      case "--system-prompt-file": {
        opts.systemPromptFile = argv[++i];
        break;
      }
      case "--summarize-at": {
        const n = parseFloat(argv[++i]);
        if (!isNaN(n) && n > 0 && n <= 1) opts.summarizeAt = n;
        break;
      }
      case "--summarize-model": {
        opts.summarizeModel = argv[++i];
        break;
      }
      case "--vision-model": {
        opts.visionModel = argv[++i];
        break;
      }
      case "--summarize-keep-recent-turns": {
        const n = parseInt(argv[++i], 10);
        if (!isNaN(n) && n >= 0) opts.summarizeKeepRecentTurns = n;
        break;
      }
      case "--approval-mode": {
        const v = argv[++i];
        if (v === "tty" || v === "question") opts.approvalMode = v;
        break;
      }
      case "--profile": {
        opts.profile = argv[++i];
        break;
      }
      case "--settings-file": {
        opts.settingsFile = argv[++i];
        break;
      }
      case "--plan-mode": {
        opts.planMode = true;
        break;
      }
      case "--max-spawn-depth": {
        const n = parseInt(argv[++i], 10);
        if (!isNaN(n) && n >= 0) opts.maxSpawnDepth = n;
        break;
      }
      case "--online-search": {
        opts.onlineSearch = true;
        break;
      }
      case "--agent-id": {
        opts.agentId = argv[++i];
        break;
      }
      case "--inject-context": {
        opts.injectContext = true;
        break;
      }
      case "--enable-browser-tools": {
        opts.enableBrowserTools = true;
        break;
      }
      case "--auto-memory": {
        opts.autoMemory = true;
        break;
      }
      case "--track-file-changes": {
        opts.trackFileChanges = true;
        break;
      }
      case "--tag-tool-outputs": {
        opts.tagToolOutputs = true;
        break;
      }
      case "--no-tag-tool-outputs": {
        opts.tagToolOutputs = false;
        break;
      }
      case "--hook-error-mode": {
        const v = argv[++i];
        if (v === "ignore" || v === "warn" || v === "fail") opts.hookErrorMode = v;
        break;
      }
      case "--tool-error-budget-hard-stop": {
        opts.toolErrorBudgetHardStop = true;
        break;
      }
      case "--prune-sessions": {
        // handled in main before loop
        break;
      }
      case "--older-than": {
        // handled in main before loop (paired with --prune-sessions)
        i++;
        break;
      }
      default:
        // Unknown flags or positional args — skip
        break;
    }

    i++;
  }

  return opts;
}
