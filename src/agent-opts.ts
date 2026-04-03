/**
 * Allowlist-based sanitizer for agent run options received from untrusted callers.
 *
 * The ALLOWED_AGENT_OPTS set is typed as Set<keyof AgentLoopOptions> so
 * TypeScript emits a compile error when a key is misspelled or removed from
 * AgentLoopOptions without updating this list.
 *
 * Security-sensitive fields (sandboxRoot, requireApproval, bashPolicy,
 * dangerouslySkipPermissions) are always stripped regardless of the allowlist
 * because they control the security boundary of every run and must be
 * configured at startup, not per-request.
 */
import type { AgentLoopOptions } from "./types.js";

const ALLOWED_AGENT_OPTS = new Set<keyof AgentLoopOptions>([
  // Identity / session
  "model", "models", "sessionId", "cwd", "addDirs",
  // Run control
  "maxTurns", "maxRetries", "verbose", "forceResume", "timeoutSec",
  // Prompt
  "prompt", "appendSystemPrompt", "promptContent",
  // Summarization
  "summarizeAt", "summarizeModel", "summarizeKeepRecentTurns",
  "summarizePrompt", "summarizeFallbackKeep",
  // Sampling
  "temperature", "top_p", "top_k", "seed", "stop",
  "frequency_penalty", "presence_penalty", "repetition_penalty", "min_p",
  // Model control
  "reasoning", "provider", "transforms", "preset", "profile",
  "parallel_tool_calls", "tool_choice", "response_format",
  // Cost limits
  "maxCostUsd", "maxCostUsdSoft", "costPerInputToken", "costPerOutputToken",
  // Site identity (informational HTTP headers, not outbound connections)
  "siteUrl", "siteName",
  // Tool settings
  "useFinishTool", "enableBrowserTools", "tagToolOutputs",
  "trackFileChanges", "toolTimeouts", "maxSpawnDepth",
  "toolErrorBudgetHardStop", "maxIdenticalToolCallTurns",
  "requiredCapabilities", "requiredEnvVars",
  // Approval (approvalMode/approvalAnswer stripped below — security-sensitive)
  "approvalTimeoutMs",
  // Turn routing
  "turnModelRules",
  // Plan mode
  "planMode",
  // Context injection
  "injectContext", "readProjectInstructions",
  // Per-run feature flags
  "onlineSearch", "autoMemory",
  // Webhook format only (webhookUrl/webhookSecret stripped below — SSRF/exfil risk)
  "webhookFormat",
  // Memory
  "memory", "memoryKey", "memoryMaxChars",
  "memoryRetrieval", "memoryEmbeddingModel", "memoryRetrievalThreshold",
  // Session lock
  "sessionLockTimeoutMs",
  // Per-run env injection
  "env",
]);

export function sanitizeDaemonRunOpts(
  raw: Record<string, unknown>,
): { safe: Record<string, unknown>; rejected: string[] } {
  const safe: Record<string, unknown> = {};
  const rejected: string[] = [];
  for (const [k, v] of Object.entries(raw)) {
    if (ALLOWED_AGENT_OPTS.has(k as keyof AgentLoopOptions)) {
      safe[k] = v;
    } else {
      rejected.push(k);
    }
  }
  // Security-sensitive: always stripped, even if somehow in the allowlist above.
  // hooks/mcpServers enable arbitrary code execution; apiKeys/webhookUrl enable
  // exfiltration; approvalMode can bypass the approval mechanism. (audit B-01)
  delete safe["sandboxRoot"];
  delete safe["requireApproval"];
  delete safe["bashPolicy"];
  delete safe["dangerouslySkipPermissions"];
  delete safe["hooks"];
  delete safe["hookTimeoutMs"];
  delete safe["hookErrorMode"];
  delete safe["mcpServers"];
  delete safe["requireMcpServers"];
  delete safe["webhookUrl"];
  delete safe["webhookSecret"];
  delete safe["apiKeys"];
  delete safe["agentApiKey"];
  delete safe["approvalMode"];
  delete safe["approvalAnswer"];
  return { safe, rejected };
}
