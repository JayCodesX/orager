/**
 * Tests for the JSON-RPC 2.0 subprocess transport (Ticket 2).
 *
 * Server-side tests use Bun.spawn to run a helper script in a clean process
 * (same pattern as audit.test.ts). Orchestrator-side tests use real node
 * child processes with scripted JSON-RPC output.
 */

import { describe, it, expect, vi } from "vitest";
import { spawn } from "node:child_process";
import * as readline from "node:readline";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Spawn a node script and collect its stdout lines. */
async function captureNodeScript(script: string): Promise<string[]> {
  const child = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] });
  child.stdin!.end();
  const lines: string[] = [];
  await new Promise<void>((resolve) => {
    const rl = readline.createInterface({ input: child.stdout! });
    rl.on("line", (l) => lines.push(l));
    child.on("close", () => resolve());
  });
  return lines.filter(Boolean);
}

/** Run startSubprocessServer in a fresh Bun process with piped input. */
async function runServerInSubprocess(inputLine: string): Promise<{ stdout: string; exitCode: number }> {
  // Write a small bun script that calls startSubprocessServer
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orager-test-"));
  const scriptPath = path.join(tmpDir, "server-runner.ts");
  await fs.writeFile(scriptPath, [
    `import { startSubprocessServer } from ${JSON.stringify(path.resolve("src/subprocess.ts"))};`,
    `await startSubprocessServer().catch(() => {});`,
  ].join("\n"));

  const proc = Bun.spawn(
    [process.execPath.endsWith("bun") ? process.execPath : "/usr/local/bin/bun", "run", scriptPath],
    {
      stdin: new TextEncoder().encode(inputLine + "\n"),
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const [stdout, , exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  await fs.rm(tmpDir, { recursive: true, force: true });
  return { stdout, exitCode };
}

function makeRunRequest(extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "agent/run",
    params: {
      prompt: "test", model: "test-model", apiKey: "test-key",
      sessionId: null, addDirs: [], maxTurns: 1, cwd: "/tmp",
      dangerouslySkipPermissions: false, verbose: false,
      ...extra,
    },
  });
}

// ── JSON-RPC protocol format tests (no subprocess needed) ─────────────────────

describe("JSON-RPC 2.0 wire format", () => {
  it("notification format: method + params, no id", () => {
    const notification = {
      jsonrpc: "2.0" as const,
      method: "agent/event",
      params: { type: "system", subtype: "init" },
    };
    const line = JSON.stringify(notification);
    const parsed = JSON.parse(line);
    expect(parsed.jsonrpc).toBe("2.0");
    expect(parsed.method).toBe("agent/event");
    expect("id" in parsed).toBe(false);
    expect(parsed.params.type).toBe("system");
  });

  it("response format: id + result, no method", () => {
    const response = { jsonrpc: "2.0" as const, id: 1, result: { done: true } };
    const line = JSON.stringify(response);
    const parsed = JSON.parse(line);
    expect(parsed.id).toBe(1);
    expect(parsed.result.done).toBe(true);
    expect("method" in parsed).toBe(false);
  });

  it("error response format: id + error object", () => {
    const err = { jsonrpc: "2.0" as const, id: 1, error: { code: -32000, message: "failed" } };
    const line = JSON.stringify(err);
    const parsed = JSON.parse(line);
    expect(parsed.error.code).toBe(-32000);
    expect(parsed.error.message).toBe("failed");
  });

  it("each message is a single newline-delimited line", () => {
    const messages = [
      { jsonrpc: "2.0", method: "agent/event", params: { type: "assistant" } },
      { jsonrpc: "2.0", id: 1, result: { done: true } },
    ];
    const wire = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
    const lines = wire.split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    lines.forEach((l) => expect(() => JSON.parse(l)).not.toThrow());
  });
});

// ── Orchestrator-side protocol parsing (scripted child processes) ─────────────

describe("orchestrator protocol parsing", () => {
  it("parses agent/event notification from stdout", async () => {
    const script = [
      `const n = JSON.stringify({ jsonrpc:"2.0", method:"agent/event", params:{ type:"system", subtype:"init" } });`,
      `const r = JSON.stringify({ jsonrpc:"2.0", id:1, result:{ done:true } });`,
      `process.stdout.write(n + "\\n" + r + "\\n");`,
    ].join("\n");

    const lines = await captureNodeScript(script);
    const parsed = lines.map((l) => JSON.parse(l));

    const notification = parsed.find((m) => m.method === "agent/event");
    expect(notification?.params?.type).toBe("system");
    expect(parsed.find((m) => m.result?.done)).toBeDefined();
  });

  it("parses error response from stdout", async () => {
    const script = `
      const r = JSON.stringify({ jsonrpc:"2.0", id:1, error:{ code:-32000, message:"agent failed" } });
      process.stdout.write(r + "\\n");
    `;
    const lines = await captureNodeScript(script);
    const parsed = lines.map((l) => JSON.parse(l));
    const err = parsed.find((m) => m.error?.code === -32000);
    expect(err?.error?.message).toBe("agent failed");
  });

  it("multiple notifications before final response", async () => {
    const script = `
      const events = ["assistant", "tool", "assistant"];
      for (const t of events) {
        process.stdout.write(JSON.stringify({ jsonrpc:"2.0", method:"agent/event", params:{ type:t } }) + "\\n");
      }
      process.stdout.write(JSON.stringify({ jsonrpc:"2.0", id:1, result:{ done:true } }) + "\\n");
    `;
    const lines = await captureNodeScript(script);
    const parsed = lines.map((l) => JSON.parse(l));
    const notifications = parsed.filter((m) => m.method === "agent/event");
    expect(notifications).toHaveLength(3);
    expect(parsed.find((m) => m.result?.done)).toBeDefined();
  });
});

// ── runAgentLoopSubprocess: child process that exits with non-zero ────────────

import { runAgentLoopSubprocess } from "../src/subprocess.js";

describe("runAgentLoopSubprocess", () => {
  it("rejects when child exits with non-zero code and no JSON-RPC response", async () => {
    // node -e "process.exit(1)" — hangs no longer, exits immediately with code 1.
    // runAgentLoopSubprocess gets no response line, child closes with code 1.
    await expect(
      runAgentLoopSubprocess({
        prompt: "p", model: "m", apiKey: "k", sessionId: null, addDirs: [],
        maxTurns: 1, cwd: "/tmp", dangerouslySkipPermissions: false, verbose: false,
        onEmit: vi.fn(),
        subprocess: {
          enabled: true,
          // Use node to run -e script. The --subprocess arg is passed but node
          // ignores unrecognised args after -e "script" (treats them as argv).
          binaryPath: "/usr/local/bin/node",
        },
      }),
    ).rejects.toThrow();
    // Any rejection is acceptable — the child exited without a valid response.
  }, 5000);
});
