/**
 * together-hosting.ts — ADR-0007
 *
 * Upload a LoRA adapter checkpoint to Together AI for hosted inference.
 * Returns the new model endpoint string (e.g., "together/orager-ft-v3").
 *
 * Together AI fine-tune hosting charges at base model inference prices and
 * serves the adapter at a stable endpoint that can be swapped atomically.
 *
 * API reference: https://docs.together.ai/reference/finetune
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { OmlsConfig } from "../types.js";

const TOGETHER_API_BASE = "https://api.together.xyz/v1";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface HostedModel {
  endpoint: string;    // e.g. "together/orager-ft-v3"
  jobId: string;       // Together AI fine-tune job ID
  uploadedAt: string;  // ISO timestamp
  version: number;     // adapter version number
}

// ── Config helpers ────────────────────────────────────────────────────────────

function getTogetherApiKey(cfg: OmlsConfig): string {
  const key =
    cfg.rl?.hosting?.together?.apiKey ??
    process.env["TOGETHER_API_KEY"] ?? "";
  if (!key) throw new Error("TOGETHER_API_KEY not set");
  return key;
}

// ── Version registry ──────────────────────────────────────────────────────────
// Stored in ~/.orager/adapters/registry.json

export function getAdaptersDir(): string {
  return path.join(os.homedir(), ".orager", "adapters");
}

async function loadRegistry(): Promise<{ versions: HostedModel[]; current?: string }> {
  const reg = path.join(getAdaptersDir(), "registry.json");
  try {
    const raw = await fs.readFile(reg, "utf8");
    return JSON.parse(raw) as { versions: HostedModel[]; current?: string };
  } catch {
    return { versions: [] };
  }
}

async function saveRegistry(data: { versions: HostedModel[]; current?: string }): Promise<void> {
  const dir = getAdaptersDir();
  await fs.mkdir(dir, { recursive: true });
  const reg = path.join(dir, "registry.json");
  await fs.writeFile(reg, JSON.stringify(data, null, 2) + "\n", "utf8");
}

/** Return the current active RL model endpoint, or null if no adapter is deployed. */
export async function getCurrentEndpoint(): Promise<string | null> {
  const registry = await loadRegistry();
  return registry.current ?? null;
}

/** Return all deployed adapter versions, newest first. */
export async function listAdapterVersions(): Promise<HostedModel[]> {
  const registry = await loadRegistry();
  return registry.versions.slice().reverse();
}

// ── Upload ────────────────────────────────────────────────────────────────────

interface TogetherUploadResponse {
  id: string;
  status: string;
}

interface TogetherFineTuneJob {
  id: string;
  status: string;
  output_name?: string;
  model?: string;
}

/**
 * Upload a LoRA adapter directory to Together AI and wait for it to be ready.
 *
 * @param adapterDir  - Local directory containing the LoRA adapter checkpoint
 * @param baseModel   - The base model the adapter was trained on
 * @param cfg         - OMLS configuration
 * @returns The hosted model endpoint string
 */
export async function uploadAdapter(
  adapterDir: string,
  baseModel: string,
  cfg: OmlsConfig,
): Promise<HostedModel> {
  const apiKey = getTogetherApiKey(cfg);
  const registry = await loadRegistry();
  const nextVersion = registry.versions.length + 1;
  const modelName = `orager-ft-v${nextVersion}`;

  // ── Step 1: Find the adapter tarball or zip ───────────────────────────────
  const files = await fs.readdir(adapterDir);
  const archiveFile = files.find((f) => f.endsWith(".tar.gz") || f.endsWith(".zip"));
  if (!archiveFile) throw new Error(`No .tar.gz or .zip found in adapter dir: ${adapterDir}`);
  const archivePath = path.join(adapterDir, archiveFile);

  // ── Step 2: Upload file to Together AI ───────────────────────────────────
  const fileBuffer = await fs.readFile(archivePath);
  const formData = new FormData();
  formData.append("purpose", "fine-tune");
  formData.append("file", new Blob([fileBuffer]), archiveFile);

  const uploadResp = await fetch(`${TOGETHER_API_BASE}/files`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });
  if (!uploadResp.ok) {
    throw new Error(`Together AI file upload failed: ${uploadResp.status} ${await uploadResp.text()}`);
  }
  const uploadData = await uploadResp.json() as TogetherUploadResponse;
  const fileId = uploadData.id;

  // ── Step 3: Create fine-tune job ─────────────────────────────────────────
  const ftResp = await fetch(`${TOGETHER_API_BASE}/fine-tunes`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: baseModel,
      training_file: fileId,
      model_name: modelName,
      adapter_type: "lora",
      // LoRA config mirrors training config
      lora_r: cfg.rl?.training?.loraRank ?? 16,
      lora_alpha: cfg.rl?.training?.loraAlpha ?? 32,
    }),
  });
  if (!ftResp.ok) {
    throw new Error(`Together AI fine-tune creation failed: ${ftResp.status} ${await ftResp.text()}`);
  }
  const ftData = await ftResp.json() as TogetherFineTuneJob;
  const jobId = ftData.id;

  // ── Step 4: Poll until ready (up to 30 minutes) ───────────────────────────
  const timeout = Date.now() + 30 * 60 * 1000;
  while (Date.now() < timeout) {
    await new Promise((r) => setTimeout(r, 30_000)); // poll every 30s
    const statusResp = await fetch(`${TOGETHER_API_BASE}/fine-tunes/${jobId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!statusResp.ok) continue;
    const status = await statusResp.json() as TogetherFineTuneJob;
    if (status.status === "complete" || status.status === "succeeded") {
      const endpoint = `together/${status.output_name ?? modelName}`;
      const hosted: HostedModel = {
        endpoint,
        jobId,
        uploadedAt: new Date().toISOString(),
        version: nextVersion,
      };

      // Update registry
      registry.versions.push(hosted);
      registry.current = endpoint;
      await saveRegistry(registry);

      return hosted;
    }
    if (status.status === "failed" || status.status === "error") {
      throw new Error(`Together AI fine-tune job ${jobId} failed with status: ${status.status}`);
    }
  }
  throw new Error(`Together AI fine-tune job ${jobId} did not complete within 30 minutes`);
}

// ── Endpoint swap ─────────────────────────────────────────────────────────────

/**
 * Atomically update the active RL model endpoint in the local registry.
 * Does NOT modify settings.json — the endpoint is read from the registry
 * by the confidence router at runtime.
 */
export async function swapEndpoint(newEndpoint: string): Promise<void> {
  const registry = await loadRegistry();
  registry.current = newEndpoint;
  await saveRegistry(registry);
  process.stderr.write(`[together-hosting] Active endpoint → ${newEndpoint}\n`);
}

/**
 * Roll back to the previous adapter version.
 * Returns the previous endpoint, or null if no previous version exists.
 */
export async function rollbackEndpoint(): Promise<string | null> {
  const registry = await loadRegistry();
  if (registry.versions.length < 2) return null;
  const prev = registry.versions[registry.versions.length - 2];
  if (!prev) return null;
  registry.current = prev.endpoint;
  await saveRegistry(registry);
  process.stderr.write(`[together-hosting] Rolled back → ${prev.endpoint}\n`);
  return prev.endpoint;
}
