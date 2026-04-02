/**
 * vps-client.ts — ADR-0007
 *
 * VPS GPU provider client. Supports Vast.ai and RunPod.
 *
 * Responsibilities:
 *   - Spin up an on-demand GPU instance (RTX 4090, spot/interruptible)
 *   - Wait for the instance to be ready
 *   - Upload the training bundle via SCP
 *   - Execute the training script remotely
 *   - Download the LoRA adapter checkpoint
 *   - Terminate the instance immediately after download
 *
 * All I/O errors propagate up — the training pipeline handles retries.
 */

import { execSync, execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { OmlsConfig, VpsBackend } from "../types.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface VpsInstance {
  id: string;
  host: string;
  port: number;
  backend: VpsBackend;
}

export interface VpsClientOptions {
  backend: VpsBackend;
  cfg: OmlsConfig;
}

// ── Vast.ai client ────────────────────────────────────────────────────────────

const VASTAI_API_BASE = "https://console.vast.ai/api/v0";

async function vastaiRequest(
  method: string,
  endpoint: string,
  apiKey: string,
  body?: unknown,
): Promise<unknown> {
  const resp = await fetch(`${VASTAI_API_BASE}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) {
    throw new Error(`Vast.ai ${method} ${endpoint} → ${resp.status}: ${await resp.text()}`);
  }
  return resp.json();
}

async function vastaiLaunch(cfg: OmlsConfig): Promise<VpsInstance> {
  const apiKey =
    cfg.rl?.vastai?.apiKey ?? process.env["VASTAI_API_KEY"] ?? "";
  if (!apiKey) throw new Error("VASTAI_API_KEY not set");

  const gpuType = cfg.rl?.vastai?.gpuType ?? "RTX_4090";
  const imageId = cfg.rl?.vastai?.imageId ?? "unsloth/unsloth:latest";
  const spot = cfg.rl?.vastai?.spot !== false;

  // Find cheapest matching offer
  const offers = await vastaiRequest("GET", `/bundles?q={"gpu_name":"${gpuType}","rentable":true,"rented":false}&order_by=dph_total`, apiKey) as {
    offers?: Array<{ id: number; dph_total: number; ssh_host: string; ssh_port: number }>;
  };
  const offer = offers.offers?.[0];
  if (!offer) throw new Error(`No Vast.ai offer found for GPU: ${gpuType}`);

  // Create instance
  const created = await vastaiRequest("PUT", `/asks/${offer.id}/`, apiKey, {
    client_id: "me",
    image: imageId,
    runtype: spot ? "spot" : "on-demand",
    disk: 40,
    env: "-e PYTHONUNBUFFERED=1",
    onstart: "sleep inf",
  }) as { new_contract?: number };

  const instanceId = String(created.new_contract ?? "");
  if (!instanceId) throw new Error("Vast.ai did not return an instance ID");

  // Wait for ready (up to 5 minutes)
  const start = Date.now();
  while (Date.now() - start < 5 * 60 * 1000) {
    await new Promise((r) => setTimeout(r, 10_000));
    const status = await vastaiRequest("GET", `/instances/${instanceId}/`, apiKey) as {
      instances?: Array<{ actual_status?: string; ssh_host?: string; ssh_port?: number }>;
    };
    const inst = status.instances?.[0];
    if (inst?.actual_status === "running" && inst.ssh_host && inst.ssh_port) {
      return {
        id: instanceId,
        host: inst.ssh_host,
        port: inst.ssh_port,
        backend: "vastai",
      };
    }
  }
  throw new Error("Vast.ai instance did not reach 'running' state within 5 minutes");
}

async function vastaiTerminate(instanceId: string, cfg: OmlsConfig): Promise<void> {
  const apiKey =
    cfg.rl?.vastai?.apiKey ?? process.env["VASTAI_API_KEY"] ?? "";
  await vastaiRequest("DELETE", `/instances/${instanceId}/`, apiKey);
}

// ── RunPod client ─────────────────────────────────────────────────────────────

const RUNPOD_API_BASE = "https://api.runpod.io/graphql";

async function runpodMutation(apiKey: string, query: string): Promise<unknown> {
  const resp = await fetch(RUNPOD_API_BASE, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  if (!resp.ok) throw new Error(`RunPod API → ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

async function runpodLaunch(cfg: OmlsConfig): Promise<VpsInstance> {
  const apiKey =
    cfg.rl?.runpod?.apiKey ?? process.env["RUNPOD_API_KEY"] ?? "";
  if (!apiKey) throw new Error("RUNPOD_API_KEY not set");

  const gpuType = cfg.rl?.runpod?.gpuType ?? "NVIDIA GeForce RTX 4090";
  const spot = cfg.rl?.runpod?.spot !== false;

  const mutation = `
    mutation {
      podFindAndDeployOnDemand(input: {
        cloudType: ${spot ? "SECURE" : "ALL"},
        gpuCount: 1,
        gpuTypeId: "${gpuType}",
        containerDiskInGb: 40,
        volumeInGb: 0,
        imageName: "runpod/pytorch:2.1.0-py3.10-cuda11.8.0-devel-ubuntu22.04",
        dockerArgs: "sleep inf",
        name: "orager-omls-training",
        ports: "22/tcp"
      }) {
        id
        desiredStatus
        runtime { ports { ip privatePort publicPort type } }
      }
    }
  `;

  const result = await runpodMutation(apiKey, mutation) as {
    data?: { podFindAndDeployOnDemand?: { id?: string; runtime?: { ports?: Array<{ ip?: string; publicPort?: number; type?: string }> } } };
  };
  const pod = result.data?.podFindAndDeployOnDemand;
  if (!pod?.id) throw new Error("RunPod did not return a pod ID");

  // Wait for SSH port to be available (up to 5 minutes)
  const start = Date.now();
  while (Date.now() - start < 5 * 60 * 1000) {
    await new Promise((r) => setTimeout(r, 15_000));
    const statusQ = `query { pod(input: {podId: "${pod.id}"}) { runtime { ports { ip publicPort type } } } }`;
    const s = await runpodMutation(apiKey, statusQ) as {
      data?: { pod?: { runtime?: { ports?: Array<{ ip?: string; publicPort?: number; type?: string }> } } };
    };
    const sshPort = s.data?.pod?.runtime?.ports?.find((p) => p.type === "tcp");
    if (sshPort?.ip && sshPort.publicPort) {
      return { id: pod.id, host: sshPort.ip, port: sshPort.publicPort, backend: "runpod" };
    }
  }
  throw new Error("RunPod pod did not expose SSH within 5 minutes");
}

async function runpodTerminate(podId: string, cfg: OmlsConfig): Promise<void> {
  const apiKey =
    cfg.rl?.runpod?.apiKey ?? process.env["RUNPOD_API_KEY"] ?? "";
  await runpodMutation(apiKey, `mutation { podTerminate(input: {podId: "${podId}"}) }`);
}

// ── SSH file transfer ─────────────────────────────────────────────────────────

const SSH_OPTS = [
  "-o", "StrictHostKeyChecking=no",
  "-o", "UserKnownHostsFile=/dev/null",
  "-o", "ConnectTimeout=30",
  "-o", "BatchMode=yes",
];

/** SCP upload: local → remote */
export function scpUpload(
  localPath: string,
  instance: VpsInstance,
  remotePath: string,
): void {
  execFileSync("scp", [
    ...SSH_OPTS,
    "-P", String(instance.port),
    "-r",
    localPath,
    `root@${instance.host}:${remotePath}`,
  ], { stdio: "inherit", timeout: 10 * 60 * 1000 });
}

/** SCP download: remote → local */
export function scpDownload(
  instance: VpsInstance,
  remotePath: string,
  localPath: string,
): void {
  execFileSync("scp", [
    ...SSH_OPTS,
    "-P", String(instance.port),
    "-r",
    `root@${instance.host}:${remotePath}`,
    localPath,
  ], { stdio: "inherit", timeout: 20 * 60 * 1000 });
}

/** Run a command on the remote instance via SSH. */
export function sshExec(
  instance: VpsInstance,
  command: string,
  timeoutMs = 4 * 60 * 60 * 1000, // 4 hours default
): void {
  execFileSync("ssh", [
    ...SSH_OPTS,
    "-p", String(instance.port),
    `root@${instance.host}`,
    command,
  ], { stdio: "inherit", timeout: timeoutMs });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Launch a VPS GPU instance. Returns the instance descriptor.
 */
export async function launchInstance(cfg: OmlsConfig): Promise<VpsInstance> {
  const backend = cfg.rl?.backend ?? "vastai";
  if (backend === "vastai") return vastaiLaunch(cfg);
  if (backend === "runpod") return runpodLaunch(cfg);
  throw new Error(`VPS backend '${backend}' is not yet supported. Use 'vastai' or 'runpod'.`);
}

/**
 * Terminate a VPS instance immediately.
 */
export async function terminateInstance(instance: VpsInstance, cfg: OmlsConfig): Promise<void> {
  if (instance.backend === "vastai") return vastaiTerminate(instance.id, cfg);
  if (instance.backend === "runpod") return runpodTerminate(instance.id, cfg);
}
