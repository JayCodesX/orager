/**
 * Tests for MCP HTTP reconnect-on-disconnect and per-call retry logic.
 *
 * We mock @modelcontextprotocol/sdk so no real network calls are made.
 * The tests verify:
 *   1. On ECONNRESET during a tool call, the client reconnects and retries once.
 *   2. On 429 rate-limit, retries with backoff up to MCP_TOOL_CALL_RETRIES times.
 *   3. On non-retriable errors, the error propagates immediately.
 *   4. After successful reconnect, subsequent calls work on the new client.
 *   5. compactedAt is set; compactedFrom is NOT set for in-place compaction.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mocked } from "./mock-helpers.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

// ── MCP SDK mock ──────────────────────────────────────────────────────────────

const mockCallTool = vi.fn();
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);
const mockListTools = vi.fn().mockResolvedValue({
  tools: [
    { name: "echo", description: "echo tool", inputSchema: { type: "object", properties: { msg: { type: "string" } } } },
  ],
});

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    close: mockClose,
    listTools: mockListTools,
    callTool: mockCallTool,
  })),
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn().mockImplementation(() => ({ type: "http-transport" })),
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn().mockImplementation(() => ({ type: "stdio-transport" })),
}));

// ── Test state ─────────────────────────────────────────────────────────────────

let testDir: string;
let savedEnv: string | undefined;

beforeEach(async () => {
  vi.clearAllMocks();
  mockConnect.mockResolvedValue(undefined);
  mockClose.mockResolvedValue(undefined);
  mockListTools.mockResolvedValue({
    tools: [
      { name: "echo", description: "echo tool", inputSchema: { type: "object", properties: {} } },
    ],
  });
  savedEnv = process.env["ORAGER_SESSIONS_DIR"];
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), "orager-mcp-reconnect-"));
  testDir = await fs.realpath(raw);
  process.env["ORAGER_SESSIONS_DIR"] = testDir;
});

afterEach(async () => {
  if (savedEnv === undefined) delete process.env["ORAGER_SESSIONS_DIR"];
  else process.env["ORAGER_SESSIONS_DIR"] = savedEnv;
  await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("MCP HTTP reconnect-on-disconnect", () => {
  it("reconnects and retries once on ECONNRESET during tool call", async () => {
    const { connectMcpServer } = await import("../src/mcp-client.js");

    // First call throws ECONNRESET, second call succeeds after reconnect
    mockCallTool
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce({ content: [{ type: "text", text: "echoed" }], isError: false });

    const handle = await connectMcpServer("test", { url: "http://localhost:9999/mcp" });
    expect(handle.tools).toHaveLength(1);

    const result = await handle.tools[0].execute({ msg: "hello" });

    // Should have succeeded after reconnect
    expect(result.isError).toBe(false);
    expect(result.content).toContain("echoed");
    // connect should have been called twice (initial + reconnect)
    expect(mockConnect).toHaveBeenCalledTimes(2);
    await handle.close();
  });

  it("reconnects and retries once on 'connection closed' error", async () => {
    const { connectMcpServer } = await import("../src/mcp-client.js");

    mockCallTool
      .mockRejectedValueOnce(new Error("Transport connection closed"))
      .mockResolvedValueOnce({ content: [{ type: "text", text: "ok" }], isError: false });

    const handle = await connectMcpServer("test", { url: "http://localhost:9999/mcp" });
    const result = await handle.tools[0].execute({});

    expect(result.isError).toBe(false);
    expect(mockConnect).toHaveBeenCalledTimes(2);
    await handle.close();
  });

  it("does NOT reconnect on non-transport errors (e.g. tool validation failure)", async () => {
    const { connectMcpServer } = await import("../src/mcp-client.js");

    mockCallTool.mockRejectedValue(new Error("Invalid argument: 'x' is required"));

    const handle = await connectMcpServer("test", { url: "http://localhost:9999/mcp" });
    const result = await handle.tools[0].execute({});

    // Error propagates as tool error, no reconnect
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid argument");
    // connect called only once (initial)
    expect(mockConnect).toHaveBeenCalledTimes(1);
    await handle.close();
  });

  it("returns error if reconnect itself fails", async () => {
    const { connectMcpServer } = await import("../src/mcp-client.js");

    mockCallTool.mockRejectedValue(new Error("ECONNRESET"));
    // First connect succeeds, reconnect fails
    mockConnect
      .mockResolvedValueOnce(undefined)         // initial connect
      .mockRejectedValueOnce(new Error("Server unavailable")); // reconnect fails

    const handle = await connectMcpServer("test", { url: "http://localhost:9999/mcp" });
    const result = await handle.tools[0].execute({});

    expect(result.isError).toBe(true);
    expect(result.content).toContain("failed to reconnect");
    await handle.close();
  });

  it("retries on 429 rate-limit with backoff (up to 2 retries)", async () => {
    vi.useFakeTimers();
    const { connectMcpServer } = await import("../src/mcp-client.js");

    mockCallTool
      .mockRejectedValueOnce(new Error("429: Too Many Requests"))
      .mockRejectedValueOnce(new Error("rate limit exceeded"))
      .mockResolvedValueOnce({ content: [{ type: "text", text: "done" }], isError: false });

    const handle = await connectMcpServer("test", { url: "http://localhost:9999/mcp" });

    // Run the execute, advancing timers to skip delays
    const resultPromise = handle.tools[0].execute({});
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.isError).toBe(false);
    expect(result.content).toContain("done");
    // 3 callTool calls: initial + 2 rate-limit retries
    expect(mockCallTool).toHaveBeenCalledTimes(3);

    vi.useRealTimers();
    await handle.close();
  });

  it("stdio transports do NOT use reconnectable client (connect called only once per call)", async () => {
    const { connectMcpServer } = await import("../src/mcp-client.js");

    mockCallTool.mockResolvedValue({ content: [{ type: "text", text: "stdio result" }], isError: false });

    const handle = await connectMcpServer("stdio-test", { command: "echo", args: [] });
    const result = await handle.tools[0].execute({});

    expect(result.isError).toBe(false);
    // For stdio, connect is called once and never reconnected
    expect(mockConnect).toHaveBeenCalledTimes(1);
    await handle.close();
  });
});

// ── compactedFrom / compactedAt fix ───────────────────────────────────────────

describe("compactSession: compactedAt set, compactedFrom NOT set for in-place compaction", () => {
  it("sets compactedAt ISO timestamp and leaves compactedFrom undefined after compaction", async () => {
    const { saveSession, loadSession, newSessionId, compactSession } = await import("../src/session.js");
    const { callOpenRouter } = await import("../src/openrouter.js");

    const id = newSessionId();
    await saveSession({
      sessionId: id,
      model: "test-model",
      messages: [
        { role: "assistant", content: "I ran some tools and completed the task." },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      turnCount: 1,
      cwd: testDir,
    });

    // Mock the OpenRouter call used for summarization
    mocked(callOpenRouter).mockResolvedValueOnce({
      content: "Session summary: completed task successfully.",
      reasoning: "",
      toolCalls: [],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      cachedTokens: 0,
      cacheWriteTokens: 0,
      model: "test-model",
      finishReason: "stop",
      isError: false,
    });

    const before = new Date();
    await compactSession(id, "fake-key", "test-model");
    const after = new Date();

    const compacted = await loadSession(id);
    expect(compacted?.summarized).toBe(true);

    // compactedAt should be set and within the test window
    expect(compacted?.compactedAt).toBeDefined();
    const compactedAtTime = new Date(compacted!.compactedAt!).getTime();
    expect(compactedAtTime).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(compactedAtTime).toBeLessThanOrEqual(after.getTime() + 1000);

    // compactedFrom should NOT be set for in-place compaction (was self-referential)
    expect(compacted?.compactedFrom).toBeUndefined();
  });
});

// ── openrouter.js mock (needed for compactSession test) ───────────────────────

vi.mock("../src/openrouter.js", () => ({
  callOpenRouter: vi.fn(),
  callDirect: vi.fn(),
  shouldUseDirect: vi.fn().mockReturnValue(false),
  fetchGenerationMeta: vi.fn().mockResolvedValue(null),
  callEmbeddings: vi.fn().mockResolvedValue([[]]),
}));
