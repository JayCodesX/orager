/**
 * Typed fetch helpers for the orager UI server API.
 * All paths are relative — the Vite dev proxy forwards /api/* to 127.0.0.1:3457.
 */

export interface OragerUserConfig {
  model?: string;
  models?: string[];
  visionModel?: string;
  maxTurns?: number;
  maxRetries?: number;
  timeoutSec?: number;
  maxCostUsd?: number;
  maxCostUsdSoft?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  repetition_penalty?: number;
  min_p?: number;
  seed?: number;
  reasoningEffort?: "xhigh" | "high" | "medium" | "low" | "minimal" | "none";
  reasoningMaxTokens?: number;
  reasoningExclude?: boolean;
  providerOrder?: string[];
  providerOnly?: string[];
  providerIgnore?: string[];
  sort?: "price" | "throughput" | "latency";
  dataCollection?: "allow" | "deny";
  zdr?: boolean;
  summarizeAt?: number;
  summarizeModel?: string;
  summarizeKeepRecentTurns?: number;
  memory?: boolean;
  memoryKey?: string;
  memoryMaxChars?: number;
  memoryRetrieval?: "local" | "embedding";
  memoryEmbeddingModel?: string;
  siteUrl?: string;
  siteName?: string;
  requireApproval?: "all" | string[];
  sandboxRoot?: string;
  planMode?: boolean;
  injectContext?: boolean;
  tagToolOutputs?: boolean;
  useFinishTool?: boolean;
  enableBrowserTools?: boolean;
  trackFileChanges?: boolean;
  /** Ollama local inference configuration. */
  ollama?: {
    enabled?: boolean;
    model?: string;
    baseUrl?: string;
  };
  /** OMLS opportunistic RL training configuration. */
  omls?: {
    enabled?: boolean;
    localTraining?: {
      enabled?: boolean;
      backend?: "auto" | "mlx" | "llamacpp-cuda" | "llamacpp-cpu";
    };
    rl?: {
      training?: {
        baseModel?: string;
      };
    };
  };
  profile?: string;
  webhookUrl?: string;
  webhookFormat?: "discord";
  requiredEnvVars?: string[];
}

export interface OragerSettings {
  permissions?: Record<string, "allow" | "deny" | "ask">;
  bashPolicy?: {
    blockedCommands?: string[];
    isolateEnv?: boolean;
    allowedEnvVars?: string[];
    denyEnvVars?: string[];
  };
  hooks?: {
    PreToolCall?: string;
    PostToolCall?: string;
    PreTurn?: string;
    PostTurn?: string;
  };
  hooksEnabled?: boolean;
}

function getToken(): string {
  return (window as unknown as { __ORAGER_TOKEN__?: string }).__ORAGER_TOKEN__ ?? "";
}

/** Auth headers for direct fetch calls that bypass apiFetch. */
export function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  getConfig: () => apiFetch<OragerUserConfig>("/api/config"),
  saveConfig: (cfg: Partial<OragerUserConfig>) =>
    apiFetch<OragerUserConfig>("/api/config", {
      method: "POST",
      body: JSON.stringify(cfg),
    }),
  getConfigDefaults: () => apiFetch<OragerUserConfig>("/api/config/defaults"),

  getSettings: () => apiFetch<OragerSettings>("/api/settings"),
  saveSettings: (s: OragerSettings) =>
    apiFetch<OragerSettings>("/api/settings", {
      method: "POST",
      body: JSON.stringify(s),
    }),

  testWebhook: (url: string, format?: "discord") =>
    apiFetch<{ ok: boolean; status?: number; error?: string }>("/api/webhook/test", {
      method: "POST",
      body: JSON.stringify({ url, format }),
    }),

  getOmlsStatus: () => apiFetch<{
    localAdapter: { version: number; backend: string; baseModel: string; trainedAt: string; trajectoryCount: number } | null;
    cloudEndpoint: string | null;
    bufferSize: number;
    skillGen: number;
  } | null>("/api/omls/status").catch(() => null),
};
