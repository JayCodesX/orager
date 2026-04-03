/**
 * Subprocess transport for orager agent runs.
 *
 * Protocol: JSON-RPC 2.0 over stdio, one message per line (same as MCP servers).
 *   stdin  → JSON-RPC requests  (agent/run, agent/cancel)
 *   stdout ← JSON-RPC responses + streaming notifications (agent/event)
 *   stderr ← diagnostic logs (never mixed into the protocol channel)
 *
 * Orchestrator side: runAgentLoopSubprocess
 *   Spawns a child orager process with --subprocess, writes the agent/run
 *   request, streams agent/event notifications back as EmitEvents, then
 *   resolves when the child sends a final result response.
 *
 * Server side: startSubprocessServer
 *   Reads agent/run from stdin, calls runAgentLoop, emits agent/event
 *   notifications for every EmitEvent, then sends the final JSON-RPC response.
 */

import { spawn } from "node:child_process";
import * as readline from "node:readline";
import { runAgentLoop } from "./loop.js";
import { log } from "./logger.js";
import type { AgentLoopOptions, EmitEvent } from "./types.js";

// ── Safety limit ─────────────────────────────────────────────────────────────
// Reject any single JSON-RPC line exceeding this size to prevent OOM on a
// runaway LLM response or malformed message. 50 MB is generous for real payloads.
const MAX_LINE_BYTES = 50 * 1024 * 1024; // 50 MB

// ── JSON-RPC 2.0 wire types ───────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: unknown;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return "id" in msg && ("result" in msg || "error" in msg);
}

function isNotification(msg: JsonRpcMessage): msg is JsonRpcNotification {
  return !("id" in msg) && "method" in msg;
}

function writeLine(stream: NodeJS.WritableStream, msg: JsonRpcMessage): void {
  const ok = stream.write(JSON.stringify(msg) + "\n");
  if (!ok) {
    // Buffer is full — log to stderr so operators can tune pipe buffer sizes.
    // We don't block here because JSON-RPC messages are small enough that the
    // OS will drain the buffer before the next write.
    process.stderr.write("[orager/subprocess] writeLine: write buffer full, message queued\n");
  }
}

// ── Kill helpers ──────────────────────────────────────────────────────────────

const SIGKILL_GRACE_MS = 2000;

function killChild(child: ReturnType<typeof spawn>): void {
  try { child.kill("SIGTERM"); } catch { /* already dead */ }
  setTimeout(() => {
    try { child.kill("SIGKILL"); } catch { /* already dead */ }
  }, SIGKILL_GRACE_MS).unref();
}

// ── Orchestrator side ─────────────────────────────────────────────────────────

/**
 * Run the agent loop in a child orager process over JSON-RPC 2.0 stdio.
 * Equivalent to runAgentLoop but the work happens in an isolated subprocess.
 */
export async function runAgentLoopSubprocess(opts: AgentLoopOptions): Promise<void> {
  const { subprocess, onEmit, ...rest } = opts;
  const binaryPath = subprocess?.binaryPath ?? process.execPath;
  const timeoutMs = subprocess?.timeoutMs;

  // Strip the subprocess option itself — the child runs in-process mode.
  const params: Omit<AgentLoopOptions, "onEmit" | "subprocess"> = rest;

  const child = spawn(binaryPath, ["--subprocess"], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  let settled = false;
  let responseReceived = false;

  return new Promise<void>((resolve, reject) => {
    // ── Timeout ────────────────────────────────────────────────────────────────
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          killChild(child);
          reject(new Error(`orager subprocess timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      timer.unref();
    }

    function cleanup() {
      if (timer) clearTimeout(timer);
    }

    // ── Read stdout line by line ───────────────────────────────────────────────
    const rl = readline.createInterface({ input: child.stdout! });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (Buffer.byteLength(trimmed) > MAX_LINE_BYTES) {
        process.stderr.write(`[orager/subprocess] dropping oversized message from child (${Buffer.byteLength(trimmed)} bytes > ${MAX_LINE_BYTES} limit)\n`);
        return;
      }
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(trimmed) as JsonRpcMessage;
      } catch {
        process.stderr.write(`[orager/subprocess] malformed JSON from child: ${trimmed}\n`);
        return;
      }

      if (isNotification(msg) && msg.method === "agent/event") {
        // Forward the EmitEvent to the caller's onEmit handler.
        try {
          onEmit(msg.params as EmitEvent);
        } catch (err) {
          // onEmit errors must not propagate into the protocol loop, but they
          // should not be silently discarded — log so operators can diagnose.
          process.stderr.write(
            `[orager/subprocess] onEmit handler threw (event dropped): ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
        return;
      }

      if (isResponse(msg) && msg.id === 1) {
        // Final response — resolve or reject.
        responseReceived = true;
        cleanup();
        if (!settled) {
          settled = true;
          if (msg.error) {
            reject(new Error(msg.error.message));
          } else {
            resolve();
          }
        }
      }
    });

    // ── Stderr → logger ───────────────────────────────────────────────────────
    child.stderr!.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
    });

    // ── Child exit ────────────────────────────────────────────────────────────
    child.on("close", (code) => {
      cleanup();
      if (!settled) {
        settled = true;
        if (code === 0 && !responseReceived) {
          // Clean exit but the JSON-RPC result response was never sent — treat
          // as a failure so callers don't silently succeed with no output.
          reject(new Error("orager subprocess exited without sending a JSON-RPC response"));
        } else if (code === 0) {
          resolve();
        } else {
          reject(new Error(`orager subprocess exited with code ${code}`));
        }
      }
    });

    child.on("error", (err) => {
      cleanup();
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    // ── Send the agent/run request ─────────────────────────────────────────────
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "agent/run",
      params,
    };
    child.stdin!.on("error", (err) => {
      cleanup();
      if (!settled) {
        settled = true;
        reject(new Error(`orager subprocess stdin error: ${err.message}`));
      }
    });
    writeLine(child.stdin!, request);
    child.stdin!.end();
  });
}

// ── Server side ───────────────────────────────────────────────────────────────

/**
 * Start the subprocess server. Reads a single JSON-RPC agent/run request from
 * stdin, executes the agent loop, streams agent/event notifications to stdout,
 * and writes the final JSON-RPC response before exiting.
 *
 * Called when orager is spawned with --subprocess.
 */
export async function startSubprocessServer(): Promise<void> {
  // Read the single request line from stdin.
  const rl = readline.createInterface({ input: process.stdin });

  const request = await new Promise<JsonRpcRequest>((resolve, reject) => {
    let received = false;
    rl.on("line", (line) => {
      if (received) return;
      const trimmed = line.trim();
      if (!trimmed) return;
      if (Buffer.byteLength(trimmed) > MAX_LINE_BYTES) {
        reject(new Error(`JSON-RPC request exceeds max size (${Buffer.byteLength(trimmed)} bytes > ${MAX_LINE_BYTES} limit)`));
        return;
      }
      received = true;
      try {
        const msg = JSON.parse(trimmed) as JsonRpcRequest;
        resolve(msg);
      } catch (err) {
        reject(new Error(`Failed to parse JSON-RPC request: ${err}`));
      }
    });
    rl.on("close", () => {
      if (!received) reject(new Error("stdin closed before receiving a request"));
    });
  });

  if (request.method !== "agent/run") {
    writeLine(process.stdout, {
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32601, message: `Method not found: ${request.method}` },
    });
    process.exit(1);
  }

  // Reconstruct AgentLoopOptions from params, adding onEmit that writes notifications.
  const params = request.params as Omit<AgentLoopOptions, "onEmit" | "subprocess">;

  const onEmit = (event: EmitEvent): void => {
    const notification: JsonRpcNotification = {
      jsonrpc: "2.0",
      method: "agent/event",
      params: event,
    };
    writeLine(process.stdout, notification);
  };

  try {
    await runAgentLoop({ ...params, onEmit });
    writeLine(process.stdout, {
      jsonrpc: "2.0",
      id: request.id,
      result: { done: true },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("subprocess_run_error", { error: message });
    writeLine(process.stdout, {
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32000, message },
    });
    process.exit(1);
  }
}
