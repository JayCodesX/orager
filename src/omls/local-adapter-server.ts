/**
 * local-adapter-server.ts — ADR-0009 Phase 2 (inference side)
 *
 * Manages a local OpenAI-compatible inference server that loads the trained
 * LoRA adapter so the confidence router in loop.ts can route to it.
 *
 * Backend support:
 *   mlx          — python3 -m mlx_lm.server --model <base> --adapter-path <dir>
 *                  Default port: 8765 (avoids conflict with Ollama on 11434)
 *   llamacpp-cpu / llamacpp-cuda — python3 -m transformers_openai_api (if available)
 *                  Falls back gracefully — no server started, returns null.
 *
 * The server process is started once per orager process and tracked via a
 * PID file at ~/.orager/models/<key>/<model>/server.pid.
 *
 * Usage in loop.ts:
 *   const info = await resolveLocalAdapterServer(memoryKey, baseModel, backend);
 *   if (info) { _localAdapterBaseUrl = info.baseUrl; _rlModelId = info.modelId; }
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import type { LocalBackend, AdapterMeta } from "./hardware-detector.js";
import {
  resolveAdapterDir,
  resolveAdapterPath,
  resolveAdapterMetaPath,
} from "./hardware-detector.js";
import { modelSupportsVision } from "./supported-models.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LocalAdapterServerInfo {
  /** OpenAI-compatible base URL, e.g. "http://localhost:8765/v1" */
  baseUrl: string;
  /** Model ID to use in chat/completions calls (the base model HF path) */
  modelId: string;
  backend: LocalBackend;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_MLX_PORT = 8765;
const SERVER_STARTUP_TIMEOUT_MS = 30_000;
const HEALTH_POLL_INTERVAL_MS = 500;

// ── Helpers ───────────────────────────────────────────────────────────────────

function pidFilePath(adapterDir: string): string {
  return path.join(adapterDir, "server.pid");
}

async function readPidFile(adapterDir: string): Promise<number | null> {
  try {
    const raw = await fs.readFile(pidFilePath(adapterDir), "utf8");
    const pid = parseInt(raw.trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

async function isProcessAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0); // signal 0 = check existence, no signal sent
    return true;
  } catch {
    return false;
  }
}

/**
 * Poll the server health endpoint until it responds or times out.
 * mlx_lm.server exposes GET /health → 200 when ready.
 */
async function waitForServer(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const healthUrl = `${baseUrl}/health`;

  while (Date.now() < deadline) {
    const alive = await new Promise<boolean>((resolve) => {
      const url = new URL(healthUrl);
      const req = http.get({ hostname: url.hostname, port: Number(url.port), path: url.pathname }, (res) => {
        resolve(res.statusCode === 200);
      });
      req.on("error", () => resolve(false));
      req.setTimeout(400, () => { req.destroy(); resolve(false); });
    });
    if (alive) return true;
    await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
  }
  return false;
}

// ── MLX server ────────────────────────────────────────────────────────────────

async function startMlxServer(
  baseModel: string,
  adapterDir: string,
  port: number,
  onProgress?: (msg: string) => void,
): Promise<boolean> {
  const log = onProgress ?? (() => {});

  // Vision models use mlx_vlm.server; text-only models use mlx_lm.server
  const serverModule = modelSupportsVision(baseModel) ? "mlx_vlm.server" : "mlx_lm.server";

  const args = [
    "-m", serverModule,
    "--model", baseModel,
    "--adapter-path", adapterDir,
    "--port", String(port),
    "--host", "127.0.0.1",
  ];

  log(`[local-adapter] starting ${serverModule} on port ${port}…\n`);

  const proc = spawn("python3", args, {
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
    env: { ...process.env },
  });

  // Detach so it outlives the current orager process
  proc.unref();

  if (proc.pid) {
    await fs.writeFile(pidFilePath(adapterDir), String(proc.pid) + "\n", "utf8");
    log(`[local-adapter] server started (pid=${proc.pid})\n`);
    return true;
  }

  return false;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Load adapter metadata if a trained adapter exists for the given memoryKey + baseModel.
 * Returns null if no adapter has been trained yet.
 */
export async function loadLocalAdapterMeta(
  memoryKey: string,
  baseModel: string,
): Promise<AdapterMeta | null> {
  try {
    const raw = await fs.readFile(resolveAdapterMetaPath(memoryKey, baseModel), "utf8");
    // Also verify the adapter weights file exists
    await fs.access(resolveAdapterPath(memoryKey, baseModel));
    return JSON.parse(raw) as AdapterMeta;
  } catch {
    return null;
  }
}

/**
 * Resolve a running (or startable) local adapter inference server.
 *
 * Returns server connection info if:
 *   1. A trained local adapter exists at the expected path, AND
 *   2. The backend supports server-mode inference (mlx), AND
 *   3. The server is already running or can be started successfully.
 *
 * Returns null if no adapter exists, the backend doesn't support serving,
 * or the server fails to start. Never throws — all failures degrade gracefully.
 *
 * @param memoryKey   Memory namespace (same as used during training)
 * @param baseModel   HuggingFace model ID
 * @param backend     LocalBackend from hardware detection
 * @param onProgress  Optional log callback
 */
export async function resolveLocalAdapterServer(
  memoryKey: string,
  baseModel: string,
  backend: LocalBackend,
  onProgress?: (msg: string) => void,
): Promise<LocalAdapterServerInfo | null> {
  const log = onProgress ?? (() => {});

  // ── 1. Check adapter exists ───────────────────────────────────────────────
  const meta = await loadLocalAdapterMeta(memoryKey, baseModel);
  if (!meta) {
    return null; // no trained adapter yet
  }

  const adapterDir = resolveAdapterDir(memoryKey, baseModel);

  // ── 2. MLX server path ────────────────────────────────────────────────────
  if (backend === "mlx") {
    const port = DEFAULT_MLX_PORT;
    const baseUrl = `http://127.0.0.1:${port}/v1`;

    // Check if an existing server process is alive
    const existingPid = await readPidFile(adapterDir);
    if (existingPid && await isProcessAlive(existingPid)) {
      // Verify it's actually responding
      const alive = await waitForServer(baseUrl, 2_000);
      if (alive) {
        log(`[local-adapter] reusing mlx_lm.server (pid=${existingPid})\n`);
        return { baseUrl, modelId: baseModel, backend };
      }
    }

    // Start a new server
    const started = await startMlxServer(baseModel, adapterDir, port, log);
    if (!started) return null;

    // Wait for it to be ready
    const ready = await waitForServer(baseUrl, SERVER_STARTUP_TIMEOUT_MS);
    if (!ready) {
      log(`[local-adapter] mlx_lm.server did not become ready within ${SERVER_STARTUP_TIMEOUT_MS / 1000}s\n`);
      return null;
    }

    log(`[local-adapter] mlx_lm.server ready → ${baseUrl} (model=${baseModel} adapter=v${meta.version})\n`);
    return { baseUrl, modelId: baseModel, backend };
  }

  // ── 3. peft/CPU/CUDA — no built-in server mode ───────────────────────────
  // peft adapters require a custom serving script. For now we skip server-mode
  // inference on CPU/CUDA backends. The cloud RL endpoint (Together AI) is used
  // as the fallback — or the user can expose the adapter via a vLLM / TGI server
  // and point localTraining.serverUrl at it in the future.
  log(`[local-adapter] backend=${backend} does not support auto-serve; using cloud RL endpoint\n`);
  return null;
}

/**
 * Roll back the local adapter to the previous version.
 *
 * Finds the highest `adapter.v<N>.safetensors` file with N < current version,
 * swaps it back to `adapter.safetensors`, and updates `adapter.meta.json`.
 *
 * Returns true if rollback succeeded, false if no previous version exists.
 */
export async function rollbackLocalAdapter(
  memoryKey: string,
  baseModel: string,
): Promise<boolean> {
  const meta = await loadLocalAdapterMeta(memoryKey, baseModel);
  if (!meta || meta.version <= 1) return false;

  const adapterDir = resolveAdapterDir(memoryKey, baseModel);
  const adapterFile = resolveAdapterPath(memoryKey, baseModel);

  // Find the highest versioned file lower than current
  let targetVersion: number | null = null;
  for (let v = meta.version - 1; v >= 1; v--) {
    const vPath = path.join(adapterDir, `adapter.v${v}.safetensors`);
    try {
      await fs.access(vPath);
      targetVersion = v;
      break;
    } catch { /* version not found, try lower */ }
  }

  if (targetVersion === null) return false;

  const versionedPath = path.join(adapterDir, `adapter.v${targetVersion}.safetensors`);

  // Swap: copy versioned file back to adapter.safetensors
  await fs.copyFile(versionedPath, adapterFile);

  // Update metadata
  const updatedMeta: AdapterMeta = {
    ...meta,
    version: targetVersion,
    trainedAt: new Date().toISOString(),
  };
  await fs.writeFile(
    resolveAdapterMetaPath(memoryKey, baseModel),
    JSON.stringify(updatedMeta, null, 2) + "\n",
    "utf8",
  );

  // Stop the running server so it picks up the rolled-back adapter on next resolve
  await stopLocalAdapterServer(memoryKey, baseModel);

  return true;
}

/**
 * Stop a running local adapter server for the given memoryKey + baseModel.
 * Reads the PID file and sends SIGTERM. Non-fatal.
 */
export async function stopLocalAdapterServer(
  memoryKey: string,
  baseModel: string,
): Promise<void> {
  const adapterDir = resolveAdapterDir(memoryKey, baseModel);
  const pid = await readPidFile(adapterDir);
  if (!pid) return;
  try {
    process.kill(pid, "SIGTERM");
    await fs.unlink(pidFilePath(adapterDir)).catch(() => {});
  } catch { /* process already dead */ }
}
