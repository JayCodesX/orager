/**
 * --config-file expansion: reads a JSON config file, deletes it, and spreads
 * all its fields into globalThis so they are available to the rest of main().
 *
 * Extracted from src/index.ts (Sprint 7 decomposition).
 *
 * The file is deleted before any further processing so secrets (API keys etc.)
 * are not left on disk after the CLI process exits.
 */

import { loadConfigFile } from "./config-loading.js";

/**
 * If `--config-file <path>` is present in argv, load the file, delete it, and
 * apply all its complex fields to globalThis. Returns the updated argv (with the
 * `--config-file <path>` pair removed and the config's extra args appended).
 *
 * If `--config-file` is not present, returns argv unchanged.
 */
export async function applyConfigFileExpansion(argv: string[]): Promise<string[]> {
  const cfIdx = argv.indexOf("--config-file");
  if (cfIdx === -1) return argv;

  const cfPath = argv[cfIdx + 1];
  if (!cfPath) {
    process.stderr.write("orager: --config-file requires a path argument\n");
    process.exit(1);
  }

  const remaining = [...argv.slice(0, cfIdx), ...argv.slice(cfIdx + 2)];
  const cfResult = await loadConfigFile(cfPath);
  const expanded = [...remaining, ...cfResult.args];

  const G = globalThis as Record<string, unknown>;

  if (cfResult.turnModelRules)             G.__oragerTurnModelRules               = cfResult.turnModelRules;
  if (cfResult.promptContent)              G.__oragerPromptContent                = cfResult.promptContent;
  if (cfResult.approvalAnswer !== undefined) G.__oragerApprovalAnswer             = cfResult.approvalAnswer;
  if (cfResult.approvalMode !== undefined) G.__oragerApprovalMode                 = cfResult.approvalMode;
  if (cfResult.mcpServers)                 G.__oragerMcpServers                   = cfResult.mcpServers;
  if (cfResult.requireMcpServers)          G.__oragerRequireMcpServers            = cfResult.requireMcpServers;
  if (cfResult.toolTimeouts)               G.__oragerToolTimeouts                 = cfResult.toolTimeouts;
  if (cfResult.maxSpawnDepth !== undefined) G.__oragerMaxSpawnDepth               = cfResult.maxSpawnDepth;
  if (cfResult.maxIdenticalToolCallTurns !== undefined) G.__oragerMaxIdenticalToolCallTurns = cfResult.maxIdenticalToolCallTurns;
  if (cfResult.toolErrorBudgetHardStop !== undefined) G.__oragerToolErrorBudgetHardStop = cfResult.toolErrorBudgetHardStop;
  if (cfResult.response_format)            G.__oragerResponseFormat               = cfResult.response_format;
  if (cfResult.hooks)                      G.__oragerHooks                        = cfResult.hooks;
  if (cfResult.planMode !== undefined)     G.__oragerPlanMode                     = cfResult.planMode;
  if (cfResult.injectContext !== undefined) G.__oragerInjectContext               = cfResult.injectContext;
  if (cfResult.tagToolOutputs !== undefined) G.__oragerTagToolOutputs             = cfResult.tagToolOutputs;
  if (cfResult.readProjectInstructions !== undefined) G.__oragerReadProjectInstructions = cfResult.readProjectInstructions;
  if (cfResult.summarizePrompt)            G.__oragerSummarizePrompt              = cfResult.summarizePrompt;
  if (cfResult.summarizeFallbackKeep !== undefined) G.__oragerSummarizeFallbackKeep = cfResult.summarizeFallbackKeep;
  if (cfResult.webhookUrl)                 G.__oragerWebhookUrl                   = cfResult.webhookUrl;
  if (cfResult.webhookFormat)              G.__oragerWebhookFormat                = cfResult.webhookFormat;
  if (cfResult.webhookSecret)              G.__oragerWebhookSecret                = cfResult.webhookSecret;
  if (cfResult.bashPolicy)                 G.__oragerBashPolicy                   = cfResult.bashPolicy;
  if (cfResult.trackFileChanges !== undefined) G.__oragerTrackFileChanges         = cfResult.trackFileChanges;
  if (cfResult.enableBrowserTools !== undefined) G.__oragerEnableBrowserTools     = cfResult.enableBrowserTools;
  if (cfResult.maxCostUsdSoft !== undefined) G.__oragerMaxCostUsdSoft             = cfResult.maxCostUsdSoft;
  if (cfResult.approvalTimeoutMs !== undefined) G.__oragerApprovalTimeoutMs       = cfResult.approvalTimeoutMs;
  if (cfResult.hookTimeoutMs !== undefined) G.__oragerHookTimeoutMs               = cfResult.hookTimeoutMs;
  if (cfResult.hookErrorMode !== undefined) G.__oragerHookErrorMode               = cfResult.hookErrorMode;
  if (cfResult.apiKeys && cfResult.apiKeys.length > 0) G.__oragerApiKeys          = cfResult.apiKeys;
  if (cfResult.memory !== undefined)       G.__oragerMemory                       = cfResult.memory;
  if (cfResult.memoryKey)                  G.__oragerMemoryKey                    = cfResult.memoryKey;
  if (cfResult.memoryMaxChars !== undefined) G.__oragerMemoryMaxChars             = cfResult.memoryMaxChars;
  if (cfResult.agentApiKey)                G.__oragerAgentApiKey                  = cfResult.agentApiKey;
  if (cfResult.memoryRetrieval !== undefined) G.__oragerMemoryRetrieval           = cfResult.memoryRetrieval;
  if (cfResult.memoryEmbeddingModel)       G.__oragerMemoryEmbeddingModel         = cfResult.memoryEmbeddingModel;

  return expanded;
}

/** True when the original (pre-expansion) argv contained --config-file. */
export function hadConfigFile(argv: string[]): boolean {
  return argv.includes("--config-file");
}
