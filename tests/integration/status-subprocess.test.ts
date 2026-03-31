/**
 * End-to-end subprocess test for `orager --status` with a live daemon.
 *
 * Rather than calling handleStatus() directly (which calls process.exit()
 * internally), this test:
 *   1. Starts a minimal HTTP server that responds to /health with { status: "ok" }
 *   2. Writes ~/.orager/daemon.port with the server's port
 *   3. Spawns `tsx src/index.ts --status [--json]` as a real subprocess
 *   4. Asserts exit code and stdout output
 *
 * The existing status-command.test.ts only validates structural JSON shapes
 * in isolation. These tests verify the full CLI → port file → HTTP → output
 * pipeline against a real (mock) daemon.
 *
 * NOTE: Writes to ~/.orager/daemon.port during test execution. Do not run
 * alongside a real orager daemon.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";

const PORT_FILE = path.join(os.homedir(), ".orager", "daemon.port");
const INDEX_TS = path.join(process.cwd(), "src", "index.ts");

let mockServer: http.Server;
let mockPort: number;
let originalPortFile: string | null = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function runStatus(
  extraArgs: string[] = [],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath, // node
      ["--import", "tsx/esm", INDEX_TS, "--status", ...extraArgs],
      { cwd: process.cwd(), env: { ...process.env, FORCE_COLOR: "0" } },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
  });
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // Preserve any existing port file so we can restore it after the test run
  try {
    originalPortFile = await fs.readFile(PORT_FILE, "utf8");
  } catch {
    originalPortFile = null;
  }

  // Start a minimal mock server that responds to /health
  mockServer = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", checks: {} }));
      return;
    }
    // All other routes (e.g. /metrics) → 401 (no signing key in test)
    res.writeHead(401);
    res.end();
  });
  await new Promise<void>((resolve) =>
    mockServer.listen(0, "127.0.0.1", () => resolve()),
  );
  mockPort = (mockServer.address() as AddressInfo).port;

  // Write port file so the CLI can discover the mock daemon
  await fs.mkdir(path.dirname(PORT_FILE), { recursive: true });
  await fs.writeFile(PORT_FILE, String(mockPort), "utf8");
}, 10_000);

afterAll(async () => {
  // Close mock server
  await new Promise<void>((resolve) => mockServer.close(() => resolve()));

  // Restore or remove port file
  if (originalPortFile !== null) {
    await fs.writeFile(PORT_FILE, originalPortFile, "utf8");
  } else {
    await fs.unlink(PORT_FILE).catch(() => {});
  }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("orager --status (subprocess, live mock daemon)", () => {
  // Re-write port file before each test — other integration tests (daemon-lifecycle)
  // may start a real daemon that overwrites ~/.orager/daemon.port concurrently.
  beforeEach(async () => {
    await fs.writeFile(PORT_FILE, String(mockPort), "utf8");
  });

  it("exits 0 and prints a 'running' line in text mode", async () => {
    const { code, stdout } = await runStatus();
    expect(code).toBe(0);
    expect(stdout.toLowerCase()).toMatch(/running/);
  }, 20_000);

  it("--json exits 0 and outputs valid JSON with running: true and correct port", async () => {
    const { code, stdout } = await runStatus(["--json"]);
    expect(code).toBe(0);

    let parsed: Record<string, unknown>;
    expect(() => { parsed = JSON.parse(stdout.trim()); }).not.toThrow();
    parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;

    expect(parsed.running).toBe(true);
    expect(parsed.port).toBe(mockPort);
    expect(parsed.url).toBe(`http://127.0.0.1:${mockPort}`);
  }, 20_000);

  it("--json exits 1 and reports running: false when port file is absent", async () => {
    // Temporarily remove the port file
    await fs.unlink(PORT_FILE);
    try {
      const { code, stdout } = await runStatus(["--json"]);
      expect(code).toBe(1);

      const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
      expect(parsed.running).toBe(false);
      expect(parsed.port).toBeNull();
      expect(typeof parsed.error).toBe("string");
    } finally {
      // Restore port file for subsequent tests
      await fs.writeFile(PORT_FILE, String(mockPort), "utf8");
    }
  }, 20_000);

  it("--json exits 1 and reports error when daemon is not responding", async () => {
    // Write a port that no server is listening on
    const deadPort = 19999;
    await fs.writeFile(PORT_FILE, String(deadPort), "utf8");
    try {
      const { code, stdout } = await runStatus(["--json"]);
      expect(code).toBe(1);

      const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
      expect(parsed.running).toBe(false);
      expect(typeof parsed.error).toBe("string");
    } finally {
      // Restore correct port
      await fs.writeFile(PORT_FILE, String(mockPort), "utf8");
    }
  }, 20_000);
});
