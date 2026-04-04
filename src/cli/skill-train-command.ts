/**
 * skill-train-command.ts — CLI handler for `orager skill-train` (ADR-0007).
 *
 * Subcommands / flags:
 *   orager skill-train --rl                    full pipeline: PRM → VPS → upload
 *   orager skill-train --rl --dry-run          estimate cost, print plan, do nothing
 *   orager skill-train --rl --require-idle     only run if system is idle (for cron)
 *   orager skill-train --rl --backend <name>   override VPS backend
 *   orager skill-train --rl --local            force local training (MLX or peft)
 *   orager skill-train --rl --no-local         force cloud VPS training
 *   orager skill-train --rl --local-backend <n> override local backend (mlx|llamacpp-cuda|llamacpp-cpu)
 *   orager skill-train --status                show current RL model + buffer size
 *   orager skill-train --rollback              revert to previous adapter version
 *   orager skill-train --setup-cron            install OMLS cron job
 *   orager skill-train --remove-cron           remove OMLS cron job
 */

import type { OmlsConfig } from "../types.js";
import { loadSettings } from "../settings.js";

function printLine(msg: string): void {
  process.stdout.write(msg + "\n");
}

function printErr(msg: string): void {
  process.stderr.write(msg + "\n");
}

// ── --status ──────────────────────────────────────────────────────────────────

async function handleStatus(): Promise<void> {
  const [
    { getCurrentEndpoint, listAdapterVersions },
    { countDistillableBuffer, getCurrentSkillGeneration },
    { loadLocalAdapterMeta },
    { DEFAULT_BASE_MODEL_ID },
    settings,
  ] = await Promise.all([
    import("../omls/together-hosting.js"),
    import("../omls/trajectory-buffer.js"),
    import("../omls/local-adapter-server.js"),
    import("../omls/supported-models.js"),
    import("../settings.js").then((m) => m.loadSettings()),
  ]);

  const baseModel = settings.omls?.rl?.training?.baseModel ?? DEFAULT_BASE_MODEL_ID;
  const memoryKey = "default";

  const [endpoint, versions, localMeta, skillGen] = await Promise.all([
    getCurrentEndpoint().catch(() => null),
    listAdapterVersions().catch(() => []),
    loadLocalAdapterMeta(memoryKey, baseModel),
    getCurrentSkillGeneration(),
  ]);
  const bufferSize = await countDistillableBuffer(skillGen);

  printLine("\nOMLS / RL Training Status");
  printLine("─────────────────────────────────────────");

  if (localMeta) {
    printLine(`Local adapter:       v${localMeta.version} (${localMeta.backend}) trained ${localMeta.trainedAt.slice(0, 10)}`);
    printLine(`  Base model:        ${localMeta.baseModel}`);
    printLine(`  Trajectories:      ${localMeta.trajectoryCount}`);
  } else {
    printLine(`Local adapter:       (none)`);
  }

  printLine(`Cloud RL endpoint:   ${endpoint ?? "(none)"}`);
  if (versions.length > 0) {
    printLine(`Cloud versions:      ${versions.length} (latest: v${versions[0]?.version ?? "?"})`);
  }

  printLine(`Distillable buffer:  ${bufferSize} trajectory/trajectories`);
  printLine(`Current skill gen:   ${skillGen}`);
  printLine(`Base model:          ${baseModel}`);

  const mode = settings.omls?.mode ?? "auto";
  const modeDesc = mode === "prompt"
    ? "prompt (LoRA disabled — SkillBank only)"
    : mode === "lora"
    ? "lora (always trains when idle)"
    : `auto (prompt until ${settings.omls?.autoLoraThreshold ?? 150} active skills, then LoRA)`;
  printLine(`OMLS mode:           ${modeDesc}`);

  if (bufferSize === 0) {
    printLine("\nNo distillable trajectories yet. These are collected when:");
    printLine("  1. A run fails and the confidence router escalates to a teacher model");
    printLine("  2. orager is configured with omls.enabled: true");
  } else if (bufferSize < 32) {
    printLine(`\nBuffer needs ${32 - bufferSize} more trajectories before RL can fire (minimum: 32).`);
  } else {
    printLine(`\nBuffer ready — run 'orager skill-train --rl' to start training.`);
  }
  printLine("");
}

// ── --rollback ────────────────────────────────────────────────────────────────

async function handleRollback(): Promise<void> {
  // Try local adapter rollback first
  const [
    { rollbackLocalAdapter, loadLocalAdapterMeta },
    { DEFAULT_BASE_MODEL_ID },
    settings,
  ] = await Promise.all([
    import("../omls/local-adapter-server.js"),
    import("../omls/supported-models.js"),
    import("../settings.js").then((m) => m.loadSettings()),
  ]);

  const baseModel = settings.omls?.rl?.training?.baseModel ?? DEFAULT_BASE_MODEL_ID;
  const memoryKey = "default";

  const localMeta = await loadLocalAdapterMeta(memoryKey, baseModel);
  if (localMeta) {
    const rolledBack = await rollbackLocalAdapter(memoryKey, baseModel);
    if (rolledBack) {
      printLine(`Rolled back local adapter to previous version (was v${localMeta.version})`);
      return;
    }
    printLine("Local adapter exists but no previous version to roll back to.");
  }

  // Fall back to cloud rollback
  const { rollbackEndpoint } = await import("../omls/together-hosting.js");
  const prev = await rollbackEndpoint();
  if (prev) {
    printLine(`Rolled back cloud endpoint to: ${prev}`);
  } else {
    printErr("No previous adapter version to roll back to (local or cloud).");
    process.exit(1);
  }
}

// ── --setup-cron / --remove-cron ──────────────────────────────────────────────

async function handleSetupCron(argv: string[]): Promise<void> {
  const { installCronJob } = await import("../omls/scheduler.js");
  const schedIdx = argv.indexOf("--schedule");
  const schedule = schedIdx !== -1 ? (argv[schedIdx + 1] ?? "*/15 * * * *") : "*/15 * * * *";
  await installCronJob(schedule);
}

async function handleRemoveCron(): Promise<void> {
  const { removeCronJob } = await import("../omls/scheduler.js");
  await removeCronJob();
}

// ── --rl (main training path) ─────────────────────────────────────────────────

async function handleRlTrain(argv: string[], cfg: OmlsConfig): Promise<void> {
  const dryRun = argv.includes("--dry-run");
  const requireIdle = argv.includes("--require-idle");
  const forceLocal = argv.includes("--local");
  const forceCloud = argv.includes("--no-local");
  const backendIdx = argv.indexOf("--backend");
  const backendOverride = backendIdx !== -1 ? argv[backendIdx + 1] : undefined;
  const localBackendIdx = argv.indexOf("--local-backend");
  const localBackendOverride = localBackendIdx !== -1 ? argv[localBackendIdx + 1] : undefined;

  const apiKey = (process.env["PROTOCOL_API_KEY"] ?? "").trim();

  // ── Idle check (for cron) ────────────────────────────────────────────────
  if (requireIdle) {
    const { checkIdle } = await import("../omls/idle-detector.js");
    const idle = await checkIdle(cfg);
    if (!idle.isIdle) {
      // Exit 2 = not idle, not an error — cron ignores this
      process.stderr.write(`[omls] Not idle: ${idle.reason}\n`);
      process.exit(2);
    }
    process.stderr.write(`[omls] Idle check passed: ${idle.reason}\n`);
  }

  // ── Scheduler pre-check ───────────────────────────────────────────────────
  let schedulerPreferredBackend: "local" | "cloud" = "local";
  let schedulerLocalBackend: import("../omls/hardware-detector.js").LocalBackend | undefined;

  if (!dryRun && !argv.includes("--force")) {
    const { checkSchedulerConditions } = await import("../omls/scheduler.js");
    const check = await checkSchedulerConditions(cfg);
    if (!check.shouldTrain) {
      process.stderr.write(`[omls] Conditions not met: ${check.reason}\n`);
      if (requireIdle) process.exit(2);
      else {
        printErr(`Training conditions not met: ${check.reason}`);
        printErr("Use --force to override, or --dry-run to see what would happen.");
        process.exit(1);
      }
    }
    schedulerPreferredBackend = check.preferredBackend;
    schedulerLocalBackend = check.localBackend;
  }

  // ── Determine whether to run local or cloud ───────────────────────────────
  // Precedence: --local / --no-local flags > scheduler detection > config default
  const useLocal = forceCloud ? false
    : forceLocal ? true
    : schedulerPreferredBackend === "local";

  if (useLocal) {
    // ── Local training path ─────────────────────────────────────────────────
    printLine(dryRun ? "Dry run — estimating local training plan..." : "Starting local OMLS training pipeline...");

    const { runLocalTrainingPipeline } = await import("../omls/local-training-pipeline.js");
    const effectiveLocalBackend =
      (localBackendOverride as import("../omls/hardware-detector.js").LocalBackend | undefined)
      ?? schedulerLocalBackend;

    const result = await runLocalTrainingPipeline({
      dryRun,
      cfg,
      apiKey,
      memoryKey: "default",
      backendOverride: effectiveLocalBackend,
      onProgress: (msg) => process.stderr.write(msg),
    });

    printLine("");
    if (result.success) {
      if (dryRun) {
        printLine("Dry run complete. No changes made.");
      } else {
        printLine(`✅ Local RL training complete!`);
        printLine(`   Adapter:  ${result.adapterPath}`);
        printLine(`   Version:  v${result.version}`);
        printLine(`   Backend:  ${result.backend}`);
        printLine(`   Duration: ${Math.round((result.durationMs ?? 0) / 1000)}s`);
      }
    } else {
      printErr(`❌ Local training failed: ${result.error}`);
      for (const s of result.steps) {
        if (s.status === "error") printErr(`   [${s.step}] ${s.detail}`);
      }
      process.exit(1);
    }
    return;
  }

  // ── Cloud training path ───────────────────────────────────────────────────
  if (!apiKey) {
    printErr("orager: API key not set. Export PROTOCOL_API_KEY (required for cloud training).");
    process.exit(1);
  }

  const effectiveCfg: OmlsConfig = backendOverride
    ? { ...cfg, rl: { ...cfg.rl, backend: backendOverride as import("../types.js").VpsBackend } }
    : cfg;

  printLine(dryRun ? "Dry run — estimating training plan..." : "Starting OMLS training pipeline...");

  const { runTrainingPipeline } = await import("../omls/training-pipeline.js");
  const result = await runTrainingPipeline({
    dryRun,
    cfg: effectiveCfg,
    apiKey,
    onProgress: (msg) => printLine(`  ${msg}`),
  });

  printLine("");
  if (result.success) {
    if (dryRun) {
      printLine("Dry run complete. No changes made.");
    } else {
      printLine(`✅ RL training complete!`);
      printLine(`   Endpoint: ${result.endpoint}`);
      printLine(`   Version:  v${result.version}`);
      printLine(`   Duration: ${Math.round((result.durationMs ?? 0) / 1000)}s`);
    }
  } else {
    printErr(`❌ Training failed: ${result.error}`);
    process.exit(1);
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function handleSkillTrainSubcommand(argv: string[]): Promise<void> {
  // Load OMLS config from settings
  const settings = await loadSettings();
  const cfg: OmlsConfig = settings.omls ?? {};

  if (argv.includes("--status")) {
    await handleStatus();
    return;
  }

  if (argv.includes("--rollback")) {
    await handleRollback();
    return;
  }

  if (argv.includes("--setup-cron")) {
    await handleSetupCron(argv);
    return;
  }

  if (argv.includes("--remove-cron")) {
    await handleRemoveCron();
    return;
  }

  if (argv.includes("--rl")) {
    await handleRlTrain(argv, cfg);
    return;
  }

  // Help
  printLine("Usage: orager skill-train <flags>");
  printLine("");
  printLine("Flags:");
  printLine("  --rl                        Run the OMLS training pipeline (local by default)");
  printLine("  --rl --dry-run              Estimate plan without running");
  printLine("  --rl --require-idle         Only run if system is idle (for cron use)");
  printLine("  --rl --local                Force local training (MLX or peft)");
  printLine("  --rl --no-local             Force cloud VPS training");
  printLine("  --rl --local-backend <n>    Override local backend (mlx|llamacpp-cuda|llamacpp-cpu)");
  printLine("  --rl --backend <n>          Override cloud VPS backend (vastai|runpod)");
  printLine("  --rl --force                Skip condition checks and force training");
  printLine("  --status                    Show current RL model + buffer status");
  printLine("  --rollback                  Revert to previous adapter version");
  printLine("  --setup-cron                Install OMLS cron job (~/.orager/cron)");
  printLine("  --remove-cron               Remove OMLS cron job");
  printLine("");
  printLine("Local training (default when hardware is available):");
  printLine("  Apple Silicon:  pip install mlx-lm");
  printLine("  NVIDIA GPU:     pip install peft transformers bitsandbytes accelerate datasets");
  printLine("  CPU fallback:   pip install peft transformers accelerate datasets");
  printLine("");
  printLine("To enable OMLS, add to ~/.orager/settings.json:");
  printLine('  { "omls": { "enabled": true } }');
  printLine("");
}
