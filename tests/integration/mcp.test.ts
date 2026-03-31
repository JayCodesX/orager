/**
 * Integration tests for the orager MCP server handler logic and
 * connectAllMcpServers failure-isolation behaviour.
 *
 * File 1 — "orager MCP server — handler logic":
 *   Builds an in-process MCP Server with the same ListTools / CallTool handlers
 *   as mcp.ts, connects via InMemoryTransport, and mocks runAgentLoop.
 *
 * File 2 — "connectAllMcpServers — parallel connection + failure isolation":
 *   Mocks connectMcpServer at the module level and verifies the error-isolation
 *   and logging behaviour of connectAllMcpServers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mocked } from "../mock-helpers.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("../../src/loop.js", () => ({ runAgentLoop: vi.fn() }));

// We provide both connectMcpServer (as a spy) and a re-implemented
// connectAllMcpServers that calls the spy so tests can control both.
const _mockConnectMcpServer = vi.fn();

vi.mock("../../src/mcp-client.js", () => {
  return {
    connectMcpServer: _mockConnectMcpServer,
    connectAllMcpServers: async (
      servers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>,
      onLog?: (msg: string) => void,
    ) => {
      const entries = Object.entries(servers);
      const results = await Promise.all(
        entries.map(async ([name, config]) => {
          try {
            const handle = await _mockConnectMcpServer(name, config);
            onLog?.(`[orager] MCP: connected to '${name}' (${(handle as { tools: unknown[] }).tools.length} tools)\n`);
            return handle;
          } catch (err) {
            onLog?.(`[orager] WARNING: MCP server '${name}' failed to connect: ${err instanceof Error ? err.message : String(err)}\n`);
            return null;
          }
        }),
      );
      return results.filter((h) => h !== null);
    },
  };
});

// Deferred imports — resolved after mocks are registered.
const { runAgentLoop } = await import("../../src/loop.js");
const { connectAllMcpServers } = await import("../../src/mcp-client.js");
// connectMcpServer is accessed via _mockConnectMcpServer (defined in mock factory above).

// ── Defaults (mirroring mcp.ts) ───────────────────────────────────────────────

const DEFAULT_MODEL = "deepseek/deepseek-chat-v3-0324";

// ── Helper: build a minimal in-process MCP server ─────────────────────────────
//
// Registers the same ListTools and CallTool handlers as mcp.ts but wired
// against the mocked runAgentLoop.

function createTestMcpServer(): Server {
  const srv = new Server(
    { name: "orager-test", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  // ── ListTools ──────────────────────────────────────────────────────────────
  srv.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "run_agent",
        description: "Run an AI agent using an OpenRouter model.",
        inputSchema: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "The task or question for the agent." },
            model: { type: "string", description: "OpenRouter model ID." },
            session_id: { type: "string", description: "Resume a previous session." },
          },
          required: ["prompt"],
        },
      },
      {
        name: "list_models",
        description: "Return the default and configured fallback OpenRouter model IDs.",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));

  // ── CallTool ───────────────────────────────────────────────────────────────
  srv.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === "list_models") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ default_model: DEFAULT_MODEL }, null, 2),
          },
        ],
      };
    }

    if (name === "run_agent") {
      const apiKey =
        process.env["PROTOCOL_API_KEY"] ?? "";

      if (!apiKey) {
        return {
          content: [
            {
              type: "text",
              text: "Error: PROTOCOL_API_KEY is not set in the orager MCP server environment.",
            },
          ],
          isError: true,
        };
      }

      const prompt = String(args?.["prompt"] ?? "").trim();
      if (!prompt) {
        return {
          content: [{ type: "text", text: "Error: prompt is required." }],
          isError: true,
        };
      }

      const model = String(args?.["model"] ?? DEFAULT_MODEL);
      const sessionId =
        typeof args?.["session_id"] === "string" && (args["session_id"] as string).trim()
          ? (args["session_id"] as string).trim()
          : null;

      let finalSessionId = sessionId ?? "";
      let resultSummary = "";
      let resultSubtype = "";
      let totalCostUsd = 0;

      await (runAgentLoop as ReturnType<typeof vi.fn>)({
        prompt,
        model,
        apiKey,
        sessionId,
        forceResume: sessionId !== null ? true : undefined,
        addDirs: [],
        maxTurns: 20,
        cwd: process.cwd(),
        dangerouslySkipPermissions: false,
        verbose: false,
        onEmit: (event: { type: string; session_id?: string; result?: string; subtype?: string; total_cost_usd?: number }) => {
          if (event.type === "system" && "session_id" in event) {
            finalSessionId = String(event.session_id ?? finalSessionId);
          }
          if (event.type === "result") {
            resultSummary = String(event.result ?? "");
            resultSubtype = String(event.subtype ?? "");
            totalCostUsd = typeof event.total_cost_usd === "number" ? event.total_cost_usd : 0;
          }
        },
        onLog: () => {},
      });

      const isError =
        resultSubtype !== "success" && resultSubtype !== "error_max_turns";

      const meta: Record<string, unknown> = {
        session_id: finalSessionId || null,
        model,
        subtype: resultSubtype,
        cost_usd: totalCostUsd,
      };

      const responseText = [
        resultSummary || "(no summary produced)",
        "",
        "---",
        JSON.stringify(meta, null, 2),
      ].join("\n");

      return {
        content: [{ type: "text", text: responseText }],
        isError,
      };
    }

    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  });

  return srv;
}

// ── describe block 1: MCP server handler logic ────────────────────────────────

describe("orager MCP server — handler logic", () => {
  let mcpServer: Server;
  let mcpClient: Client;

  beforeEach(async () => {
    vi.resetAllMocks();
    process.env["PROTOCOL_API_KEY"] = "test-key";

    mcpServer = createTestMcpServer();
    mcpClient = new Client({ name: "test-client", version: "1.0.0" });

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    await mcpClient.connect(clientTransport);
  });

  afterEach(async () => {
    delete process.env["PROTOCOL_API_KEY"];
    await mcpClient.close().catch(() => {});
    await mcpServer.close().catch(() => {});
  });

  it("list_tools returns run_agent and list_models", async () => {
    const { tools } = await mcpClient.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("run_agent");
    expect(names).toContain("list_models");
  });

  it("list_models returns default_model", async () => {
    const result = await mcpClient.callTool({ name: "list_models", arguments: {} });
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
    const parsed = JSON.parse(text) as { default_model: string };
    expect(parsed.default_model).toBe(DEFAULT_MODEL);
  });

  it("run_agent without prompt returns isError=true", async () => {
    const result = await mcpClient.callTool({ name: "run_agent", arguments: { prompt: "" } });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
    expect(text).toMatch(/prompt is required/i);
  });

  it("run_agent calls runAgentLoop and returns result + session_id", async () => {
    mocked(runAgentLoop).mockImplementation(async (opts) => {
      const emitter = (opts as { onEmit?: (e: unknown) => void }).onEmit;
      // Emit a system/init event with session_id so the handler captures it
      emitter?.({ type: "system", subtype: "init", session_id: "new-sess", model: "gpt-4" });
      emitter?.({
        type: "result",
        subtype: "success",
        result: "done",
        session_id: "new-sess",
        finish_reason: "stop",
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
        total_cost_usd: 0,
      });
    });

    const result = await mcpClient.callTool({
      name: "run_agent",
      arguments: { prompt: "do the thing" },
    });

    expect(mocked(runAgentLoop)).toHaveBeenCalledOnce();
    expect(result.isError).toBeFalsy();

    const text = (result.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
    expect(text).toContain("done");
    // session_id appears in the JSON metadata block
    expect(text).toContain("new-sess");
  });

  it("run_agent with session_id passes forceResume=true to runAgentLoop", async () => {
    mocked(runAgentLoop).mockImplementation(async (opts) => {
      (opts as { onEmit?: (e: unknown) => void }).onEmit?.({
        type: "result",
        subtype: "success",
        result: "resumed",
        session_id: "existing-sess",
        finish_reason: "stop",
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
        total_cost_usd: 0,
      });
    });

    await mcpClient.callTool({
      name: "run_agent",
      arguments: { prompt: "continue", session_id: "existing-sess" },
    });

    expect(mocked(runAgentLoop)).toHaveBeenCalledOnce();
    const callArgs = mocked(runAgentLoop).mock.calls[0]![0] as {
      sessionId: string | null;
      forceResume: boolean;
    };
    expect(callArgs.sessionId).toBe("existing-sess");
    expect(callArgs.forceResume).toBe(true);
  });

  it("run_agent without PROTOCOL_API_KEY returns isError=true with key error message", async () => {
    delete process.env["PROTOCOL_API_KEY"];

    const result = await mcpClient.callTool({
      name: "run_agent",
      arguments: { prompt: "do something" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
    expect(text).toMatch(/PROTOCOL_API_KEY/);
  });
});

// ── describe block 2: connectAllMcpServers ────────────────────────────────────

describe("connectAllMcpServers — parallel connection + failure isolation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("connects all servers in parallel (Promise.all) — all handles returned", async () => {
    const handle1 = {
      tools: [{ definition: { type: "function", function: { name: "mcp__s1__tool", description: "", parameters: { type: "object", properties: {} } } }, execute: vi.fn() }],
      close: vi.fn().mockResolvedValue(undefined),
    };
    const handle2 = {
      tools: [],
      close: vi.fn().mockResolvedValue(undefined),
    };

    mocked(_mockConnectMcpServer)
      .mockResolvedValueOnce(handle1 as never)
      .mockResolvedValueOnce(handle2 as never);

    const handles = await connectAllMcpServers({
      server1: { command: "fake1" },
      server2: { command: "fake2" },
    });

    expect(handles).toHaveLength(2);
    expect(handles[0]).toBe(handle1);
    expect(handles[1]).toBe(handle2);
  });

  it("one failed server does not block others — result has 1 handle", async () => {
    const handle2 = {
      tools: [{ definition: { type: "function", function: { name: "mcp__s2__tool", description: "", parameters: { type: "object", properties: {} } } }, execute: vi.fn() }],
      close: vi.fn().mockResolvedValue(undefined),
    };

    mocked(_mockConnectMcpServer)
      .mockRejectedValueOnce(new Error("server1 connection failed"))
      .mockResolvedValueOnce(handle2 as never);

    const handles = await connectAllMcpServers({
      server1: { command: "bad-server" },
      server2: { command: "good-server" },
    });

    expect(handles).toHaveLength(1);
    expect(handles[0]).toBe(handle2);
  });

  it("returns empty array when no servers configured", async () => {
    const handles = await connectAllMcpServers({});
    expect(handles).toHaveLength(0);
    expect(mocked(_mockConnectMcpServer)).not.toHaveBeenCalled();
  });

  it("logs connection success with tool count", async () => {
    const handle = {
      tools: [
        { definition: { type: "function", function: { name: "mcp__myserver__tool_a", description: "", parameters: { type: "object", properties: {} } } }, execute: vi.fn() },
        { definition: { type: "function", function: { name: "mcp__myserver__tool_b", description: "", parameters: { type: "object", properties: {} } } }, execute: vi.fn() },
      ],
      close: vi.fn().mockResolvedValue(undefined),
    };

    mocked(_mockConnectMcpServer).mockResolvedValueOnce(handle as never);

    const logMessages: string[] = [];
    await connectAllMcpServers(
      { myserver: { command: "my-cmd" } },
      (msg) => logMessages.push(msg),
    );

    expect(logMessages.some((m) => m.includes("myserver") && m.includes("2 tools"))).toBe(true);
  });

  it("logs warning when a server fails to connect", async () => {
    mocked(_mockConnectMcpServer).mockRejectedValueOnce(new Error("ENOENT: not found"));

    const logMessages: string[] = [];
    await connectAllMcpServers(
      { brokenserver: { command: "does-not-exist" } },
      (msg) => logMessages.push(msg),
    );

    expect(
      logMessages.some(
        (m) =>
          m.toLowerCase().includes("warning") &&
          m.includes("brokenserver"),
      ),
    ).toBe(true);
  });
});
