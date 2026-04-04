/**
 * `orager keys` — manage API keys in the OS keychain.
 *
 * Usage:
 *   orager keys status                     — show auth status for all providers
 *   orager keys set <provider> <key>       — store a key in the OS keychain
 *   orager keys set <provider>             — prompt for key interactively
 *   orager keys delete <provider>          — remove a key from the OS keychain
 *   orager keys get <provider>             — print the stored key (masked)
 *
 * Providers: openrouter, anthropic, openai, deepseek, gemini
 */

import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  getAuthStatus,
  setKeychainKey,
  deleteKeychainKey,
  getKeychainKey,
  isKeychainSupported,
  type KeychainProvider,
} from "../keychain.js";

const VALID_PROVIDERS: KeychainProvider[] = ["openrouter", "anthropic", "openai", "deepseek", "gemini"];

const PROVIDER_ENV_VARS: Record<KeychainProvider, string> = {
  openrouter: "OPENROUTER_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  gemini: "GEMINI_API_KEY",
};

const PROVIDER_URLS: Record<KeychainProvider, string> = {
  openrouter: "https://openrouter.ai/keys",
  anthropic: "https://console.anthropic.com/account/keys",
  openai: "https://platform.openai.com/api-keys",
  deepseek: "https://platform.deepseek.com/api_keys",
  gemini: "https://aistudio.google.com/app/apikey",
};

function mask(key: string): string {
  if (key.length <= 8) return "****";
  return key.slice(0, 6) + "..." + key.slice(-4);
}

async function handleStatus(): Promise<void> {
  if (!isKeychainSupported()) {
    process.stdout.write("⚠  OS keychain not supported on this platform.\n");
    process.stdout.write("   Set API keys via environment variables instead.\n\n");
  }

  const status = await getAuthStatus();

  process.stdout.write("\nAPI Key Status\n");
  process.stdout.write("─".repeat(50) + "\n");

  for (const provider of VALID_PROVIDERS) {
    const { configured, source } = status[provider];
    const envVar = PROVIDER_ENV_VARS[provider];

    if (configured) {
      const icon = source === "keychain" ? "🔐" : "🔑";
      const sourceLabel = source === "keychain" ? "keychain" : `env (${envVar})`;
      process.stdout.write(`  ${icon} ${provider.padEnd(12)} ✓ configured  [${sourceLabel}]\n`);
    } else {
      process.stdout.write(`  ○  ${provider.padEnd(12)} not configured\n`);
      process.stdout.write(`     Get a key: ${PROVIDER_URLS[provider]}\n`);
    }
  }

  process.stdout.write("\n");
  process.stdout.write("  To add a key:    orager keys set <provider>\n");
  process.stdout.write("  To remove a key: orager keys delete <provider>\n\n");
}

async function handleSet(args: string[]): Promise<void> {
  const provider = args[0] as KeychainProvider | undefined;

  if (!provider || !VALID_PROVIDERS.includes(provider)) {
    process.stderr.write(`Usage: orager keys set <provider> [key]\n`);
    process.stderr.write(`Providers: ${VALID_PROVIDERS.join(", ")}\n`);
    process.exit(1);
  }

  let key = args[1];

  if (!key) {
    // Interactive prompt
    const rl = readline.createInterface({ input, output });
    try {
      key = await rl.question(`Enter ${provider} API key (input hidden): `);
    } finally {
      rl.close();
    }
    process.stdout.write("\n");
  }

  key = key.trim();
  if (!key) {
    process.stderr.write("Error: key cannot be empty.\n");
    process.exit(1);
  }

  if (!isKeychainSupported()) {
    process.stderr.write(`⚠  OS keychain not supported. Set ${PROVIDER_ENV_VARS[provider]} instead.\n`);
    process.exit(1);
  }

  try {
    await setKeychainKey(provider, key);
    process.stdout.write(`✓ ${provider} API key saved to OS keychain (${mask(key)})\n`);
    process.stdout.write(`  The key will be loaded automatically on next orager run.\n`);
  } catch (err) {
    process.stderr.write(`Error saving key: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

async function handleDelete(args: string[]): Promise<void> {
  const provider = args[0] as KeychainProvider | undefined;

  if (!provider || !VALID_PROVIDERS.includes(provider)) {
    process.stderr.write(`Usage: orager keys delete <provider>\n`);
    process.stderr.write(`Providers: ${VALID_PROVIDERS.join(", ")}\n`);
    process.exit(1);
  }

  await deleteKeychainKey(provider);
  process.stdout.write(`✓ ${provider} API key removed from OS keychain.\n`);
}

async function handleGet(args: string[]): Promise<void> {
  const provider = args[0] as KeychainProvider | undefined;

  if (!provider || !VALID_PROVIDERS.includes(provider)) {
    process.stderr.write(`Usage: orager keys get <provider>\n`);
    process.stderr.write(`Providers: ${VALID_PROVIDERS.join(", ")}\n`);
    process.exit(1);
  }

  const key = await getKeychainKey(provider);
  if (!key) {
    process.stdout.write(`${provider}: not stored in keychain.\n`);
  } else {
    process.stdout.write(`${provider}: ${mask(key)}\n`);
  }
}

function printHelp(): void {
  process.stdout.write(`
orager keys — manage API keys in the OS keychain

Usage:
  orager keys status                   show auth status for all providers
  orager keys set <provider> [key]     store a key (prompts if key omitted)
  orager keys delete <provider>        remove a key from the OS keychain
  orager keys get <provider>           show whether a key is stored (masked)

Providers:
  openrouter   ${PROVIDER_URLS.openrouter}
  anthropic    ${PROVIDER_URLS.anthropic}
  openai       ${PROVIDER_URLS.openai}
  deepseek     ${PROVIDER_URLS.deepseek}
  gemini       ${PROVIDER_URLS.gemini}

Keys are stored in the OS keychain and loaded automatically at startup:
  macOS   — Keychain Services (security command)
  Linux   — GNOME Keyring / libsecret (secret-tool command)
  Windows — Windows Credential Manager (PowerShell PasswordVault)

Env vars (OPENROUTER_API_KEY, OPENAI_API_KEY, etc.) always take precedence
over keychain-stored keys.
`);
}

export async function handleKeysSubcommand(args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub || sub === "status") {
    await handleStatus();
  } else if (sub === "set") {
    await handleSet(args.slice(1));
  } else if (sub === "delete" || sub === "remove") {
    await handleDelete(args.slice(1));
  } else if (sub === "get") {
    await handleGet(args.slice(1));
  } else if (sub === "--help" || sub === "-h") {
    printHelp();
  } else {
    process.stderr.write(`Unknown subcommand: ${sub}\nRun \`orager keys --help\` for usage.\n`);
    process.exit(1);
  }
}
