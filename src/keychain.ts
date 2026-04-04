/**
 * OS Keychain integration for secure API key storage.
 *
 * Uses native OS CLI tools — no native bindings required, works in Bun binaries.
 *
 * Backends:
 *   macOS   — `security` (Keychain Services)
 *   Linux   — `secret-tool` (libsecret / GNOME Keyring)
 *   Windows — PowerShell PasswordVault
 *
 * Key naming convention:
 *   service: "orager"
 *   account: "<provider>-api-key"  e.g. "openai-api-key", "deepseek-api-key"
 *
 * Resolution order for any provider key:
 *   1. Explicit env var (OPENAI_API_KEY etc.) — always wins, never overwritten
 *   2. OS keychain
 *   3. settings.json providers block (already handled in settings.ts)
 *   4. ~/.orager/config.json agentApiKey (legacy, OpenRouter only)
 */

import { spawn } from "node:child_process";
import os from "node:os";

// ── Provider key names ────────────────────────────────────────────────────────

export type KeychainProvider =
  | "openrouter"
  | "anthropic"
  | "openai"
  | "deepseek"
  | "gemini";

const SERVICE_NAME = "orager";

function accountName(provider: KeychainProvider): string {
  return `${provider}-api-key`;
}

// ── Platform detection ────────────────────────────────────────────────────────

type Platform = "darwin" | "linux" | "win32" | "unsupported";

function getPlatform(): Platform {
  const p = os.platform();
  if (p === "darwin" || p === "linux" || p === "win32") return p;
  return "unsupported";
}

// ── Low-level subprocess helper ───────────────────────────────────────────────

function runCommand(
  cmd: string,
  args: string[],
  stdin?: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const proc = spawn(cmd, args, {
      stdio: stdin ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    });

    proc.stdout?.on("data", (d: Buffer) => stdout.push(d.toString()));
    proc.stderr?.on("data", (d: Buffer) => stderr.push(d.toString()));

    if (stdin && proc.stdin) {
      proc.stdin.write(stdin);
      proc.stdin.end();
    }

    proc.on("close", (code) => {
      resolve({ stdout: stdout.join(""), stderr: stderr.join(""), code: code ?? 1 });
    });

    proc.on("error", (err) => {
      resolve({ stdout: "", stderr: err.message, code: 1 });
    });
  });
}

// ── macOS Keychain ────────────────────────────────────────────────────────────

async function macosGet(provider: KeychainProvider): Promise<string | null> {
  const { stdout, code } = await runCommand("security", [
    "find-generic-password",
    "-s", SERVICE_NAME,
    "-a", accountName(provider),
    "-w", // print password only
  ]);
  if (code !== 0) return null;
  return stdout.trim() || null;
}

async function macosSet(provider: KeychainProvider, key: string): Promise<void> {
  // Delete existing entry first (update requires delete + add)
  await runCommand("security", [
    "delete-generic-password",
    "-s", SERVICE_NAME,
    "-a", accountName(provider),
  ]);

  const { code, stderr } = await runCommand("security", [
    "add-generic-password",
    "-s", SERVICE_NAME,
    "-a", accountName(provider),
    "-w", key,
    "-U", // update if exists
  ]);

  if (code !== 0) {
    throw new Error(`Failed to save key to macOS Keychain: ${stderr.trim()}`);
  }
}

async function macosDelete(provider: KeychainProvider): Promise<void> {
  await runCommand("security", [
    "delete-generic-password",
    "-s", SERVICE_NAME,
    "-a", accountName(provider),
  ]);
}

// ── Linux secret-tool (libsecret / GNOME Keyring) ────────────────────────────

async function linuxGet(provider: KeychainProvider): Promise<string | null> {
  const { stdout, code } = await runCommand("secret-tool", [
    "lookup",
    "service", SERVICE_NAME,
    "account", accountName(provider),
  ]);
  if (code !== 0) return null;
  return stdout.trim() || null;
}

async function linuxSet(provider: KeychainProvider, key: string): Promise<void> {
  const { code, stderr } = await runCommand(
    "secret-tool",
    [
      "store",
      "--label", `orager ${provider} API key`,
      "service", SERVICE_NAME,
      "account", accountName(provider),
    ],
    key, // secret-tool reads secret from stdin
  );

  if (code !== 0) {
    throw new Error(`Failed to save key to Linux Secret Service: ${stderr.trim()}`);
  }
}

async function linuxDelete(provider: KeychainProvider): Promise<void> {
  await runCommand("secret-tool", [
    "clear",
    "service", SERVICE_NAME,
    "account", accountName(provider),
  ]);
}

// ── Windows PasswordVault ────────────────────────────────────────────────────

async function windowsGet(provider: KeychainProvider): Promise<string | null> {
  const script = `
    $vault = New-Object Windows.Security.Credentials.PasswordVault
    try {
      $cred = $vault.Retrieve('${SERVICE_NAME}', '${accountName(provider)}')
      $cred.RetrievePassword()
      Write-Output $cred.Password
    } catch { exit 1 }
  `;
  const { stdout, code } = await runCommand("powershell", ["-Command", script]);
  if (code !== 0) return null;
  return stdout.trim() || null;
}

async function windowsSet(provider: KeychainProvider, key: string): Promise<void> {
  // Escape single quotes in key for PowerShell
  const escaped = key.replaceAll("'", "''");
  const script = `
    $vault = New-Object Windows.Security.Credentials.PasswordVault
    try { $vault.Remove($vault.Retrieve('${SERVICE_NAME}', '${accountName(provider)}')) } catch {}
    $cred = New-Object Windows.Security.Credentials.PasswordCredential('${SERVICE_NAME}', '${accountName(provider)}', '${escaped}')
    $vault.Add($cred)
  `;
  const { code, stderr } = await runCommand("powershell", ["-Command", script]);
  if (code !== 0) {
    throw new Error(`Failed to save key to Windows Credential Manager: ${stderr.trim()}`);
  }
}

async function windowsDelete(provider: KeychainProvider): Promise<void> {
  const script = `
    $vault = New-Object Windows.Security.Credentials.PasswordVault
    try { $vault.Remove($vault.Retrieve('${SERVICE_NAME}', '${accountName(provider)}')) } catch {}
  `;
  await runCommand("powershell", ["-Command", script]);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Check if the current platform supports OS keychain operations.
 */
export function isKeychainSupported(): boolean {
  return getPlatform() !== "unsupported";
}

/**
 * Retrieve an API key from the OS keychain.
 * Returns null if the key is not stored or if keychain is unavailable.
 */
export async function getKeychainKey(provider: KeychainProvider): Promise<string | null> {
  try {
    const platform = getPlatform();
    if (platform === "darwin") return macosGet(provider);
    if (platform === "linux") return linuxGet(provider);
    if (platform === "win32") return windowsGet(provider);
    return null;
  } catch {
    return null;
  }
}

/**
 * Store an API key in the OS keychain.
 * Throws if the operation fails (e.g., user denies access, service unavailable).
 */
export async function setKeychainKey(provider: KeychainProvider, key: string): Promise<void> {
  const platform = getPlatform();
  if (platform === "darwin") return macosSet(provider, key);
  if (platform === "linux") return linuxSet(provider, key);
  if (platform === "win32") return windowsSet(provider, key);
  throw new Error(`OS keychain not supported on platform: ${os.platform()}`);
}

/**
 * Delete an API key from the OS keychain.
 * Silently succeeds if the key doesn't exist.
 */
export async function deleteKeychainKey(provider: KeychainProvider): Promise<void> {
  try {
    const platform = getPlatform();
    if (platform === "darwin") return macosDelete(provider);
    if (platform === "linux") return linuxDelete(provider);
    if (platform === "win32") return windowsDelete(provider);
  } catch {
    // Silently ignore deletion errors
  }
}

/**
 * Resolve an API key for a provider using the full priority chain:
 *   1. Explicit env var override
 *   2. OS keychain
 *   3. Returns null (caller falls back to settings/config)
 *
 * Does NOT throw — returns null on any failure.
 */
export async function resolveProviderKey(provider: KeychainProvider): Promise<string | null> {
  // Priority 1: env vars always win
  const envKey = getEnvKey(provider);
  if (envKey) return envKey;

  // Priority 2: OS keychain
  const keychainKey = await getKeychainKey(provider);
  if (keychainKey) {
    // Inject into env so downstream code (providers) picks it up automatically
    injectEnvKey(provider, keychainKey);
    return keychainKey;
  }

  return null;
}

/**
 * Resolve all configured provider keys from keychain and inject into env vars.
 * Call once at startup before any providers are used.
 * Skips providers where the env var is already set.
 */
export async function bootstrapKeychainKeys(): Promise<void> {
  const providers: KeychainProvider[] = ["openrouter", "anthropic", "openai", "deepseek", "gemini"];
  await Promise.all(providers.map((p) => resolveProviderKey(p)));
}

/**
 * Get the current key for a provider (from env, for display purposes).
 * Returns null if not set.
 */
export function getEnvKey(provider: KeychainProvider): string | null {
  const envVars: Record<KeychainProvider, string[]> = {
    openrouter: ["OPENROUTER_API_KEY"],
    anthropic: ["ANTHROPIC_API_KEY"],
    openai: ["OPENAI_API_KEY"],
    deepseek: ["DEEPSEEK_API_KEY"],
    gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  };

  for (const envVar of envVars[provider]) {
    const val = process.env[envVar];
    if (val) return val;
  }
  return null;
}

function injectEnvKey(provider: KeychainProvider, key: string): void {
  const primaryEnvVar: Record<KeychainProvider, string> = {
    openrouter: "OPENROUTER_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
    gemini: "GEMINI_API_KEY",
  };
  process.env[primaryEnvVar[provider]] = key;
}

/**
 * List the auth status of all providers.
 * Returns an object describing where each key came from.
 */
export async function getAuthStatus(): Promise<
  Record<KeychainProvider, { configured: boolean; source: "env" | "keychain" | "none" }>
> {
  const providers: KeychainProvider[] = ["openrouter", "anthropic", "openai", "deepseek", "gemini"];
  const result = {} as Record<KeychainProvider, { configured: boolean; source: "env" | "keychain" | "none" }>;

  for (const provider of providers) {
    const envKey = getEnvKey(provider);
    if (envKey) {
      result[provider] = { configured: true, source: "env" };
      continue;
    }
    const keychainKey = await getKeychainKey(provider);
    if (keychainKey) {
      result[provider] = { configured: true, source: "keychain" };
    } else {
      result[provider] = { configured: false, source: "none" };
    }
  }

  return result;
}
