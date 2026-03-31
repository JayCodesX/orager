#!/usr/bin/env node
/**
 * orager MCP server
 *
 * Exposes orager's agent loop as MCP tools so any MCP-compatible client
 * (Cursor, Claude Desktop, VS Code, etc.) can delegate long-running tasks
 * to OpenRouter models without leaving their editor.
 *
 * Usage (stdio transport — add to your editor's MCP config):
 *   {
 *     "mcpServers": {
 *       "orager": {
 *         "command": "node",
 *         "args": ["/path/to/orager/dist/mcp.js"],
 *         "env": { "PROTOCOL_API_KEY": "sk-or-..." }
 *       }
 *     }
 *   }
 *
 * Tools exposed:
 *   run_agent   — run an agent to completion, returns result + session_id
 *   list_models — return the configured default/fallback models
 */
import process from "node:process";
import path from "node:path";
import fs from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { runAgentLoop } from "./loop.js";
import type { EmitEvent } from "./types.js";

// ── Defaults (overridable via env) ────────────────────────────────────────────

const DEFAULT_MODEL =
  process.env["ORAGER_DEFAULT_MODEL"] ?? "deepseek/deepseek-chat-v3-0324";
const DEFAULT_MAX_TURNS = parseInt(
  process.env["ORAGER_MAX_TURNS"] ?? "20",
  10,
);
const DEFAULT_MAX_COST_USD = parseFloat(
  process.env["ORAGER_MAX_COST_USD"] ?? "0",
);

// ── Server ────────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "orager", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

// ── Tool definitions ──────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "run_agent",
      description:
        "Run an AI agent using an OpenRouter model. The agent can read/write files, " +
        "run shell commands, and complete multi-step tasks autonomously. " +
        "Returns the agent's final summary and a session_id you can pass on the " +
        "next call to continue the conversation.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "The task or question for the agent.",
          },
          model: {
            type: "string",
            description: `OpenRouter model ID (default: ${DEFAULT_MODEL}). Examples: deepseek/deepseek-chat-v3-0324, anthropic/claude-3.5-sonnet, openai/gpt-4o`,
          },
          session_id: {
            type: "string",
            description:
              "Resume a previous session. Pass the session_id returned by a prior run_agent call to continue the conversation.",
          },
          cwd: {
            type: "string",
            description:
              "Working directory for the agent. Defaults to the server process cwd.",
          },
          max_turns: {
            type: "number",
            description: `Maximum agent turns before stopping (default: ${DEFAULT_MAX_TURNS}).`,
          },
          max_cost_usd: {
            type: "number",
            description:
              "Stop the agent if cumulative cost exceeds this amount in USD.",
          },
          system_prompt: {
            type: "string",
            description:
              "Extra text appended to the system prompt (e.g. project context, coding style guides).",
          },
        },
        required: ["prompt"],
      },
    },
    {
      name: "list_models",
      description:
        "Return the default and any configured fallback OpenRouter model IDs for this server.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
  ],
}));

// ── Tool execution ────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
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
    // L-05: shuttingDown guard prevents new calls during drain
    if (shuttingDown) {
      return {
        content: [{ type: "text", text: "The orager MCP server is shutting down. Please try again shortly." }],
        isError: true,
      };
    }

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
      typeof args?.["session_id"] === "string" && args["session_id"].trim()
        ? args["session_id"].trim()
        : null;
    const rawCwd =
      typeof args?.["cwd"] === "string" && args["cwd"].trim()
        ? args["cwd"].trim()
        : process.cwd();
    const cwd = path.resolve(rawCwd);

    // Reject path-traversal attempts: after resolving, the normalized form must not contain ".."
    if (path.normalize(cwd).includes("..")) {
      return {
        content: [{ type: "text", text: "Error: cwd must not contain path traversal (..)." }],
        isError: true,
      };
    }

    // Verify the directory actually exists
    try {
      const stat = await fs.stat(cwd);
      if (!stat.isDirectory()) {
        return {
          content: [{ type: "text", text: `Error: cwd is not a directory: ${cwd}` }],
          isError: true,
        };
      }
    } catch {
      return {
        content: [{ type: "text", text: `Error: cwd does not exist: ${cwd}` }],
        isError: true,
      };
    }

    const maxTurns =
      typeof args?.["max_turns"] === "number"
        ? args["max_turns"]
        : DEFAULT_MAX_TURNS;
    const maxCostUsd =
      typeof args?.["max_cost_usd"] === "number"
        ? args["max_cost_usd"]
        : DEFAULT_MAX_COST_USD > 0
          ? DEFAULT_MAX_COST_USD
          : undefined;
    const appendSystemPrompt =
      typeof args?.["system_prompt"] === "string"
        ? args["system_prompt"]
        : undefined;

    // Collect all log output so we can include it in the response
    const logLines: string[] = [];

    let finalSessionId = sessionId ?? "";
    let resultSummary = "";
    let resultSubtype = "";
    let totalCostUsd = 0;

    activeCallCount++;
    try {
      await runAgentLoop({
        prompt,
        model,
        apiKey,
        sessionId,
        addDirs: [],
        maxTurns,
        cwd,
        dangerouslySkipPermissions: false,
        verbose: false,
        appendSystemPrompt,
        maxCostUsd,
        onEmit: (event: EmitEvent) => {
          if (event.type === "system" && "session_id" in event) {
            finalSessionId = String(event.session_id ?? finalSessionId);
          }
          if (event.type === "result") {
            resultSummary = String(event.result ?? "");
            resultSubtype = String(event.subtype ?? "");
            totalCostUsd = typeof event.total_cost_usd === "number"
              ? event.total_cost_usd
              : 0;
          }
        },
        onLog: (_stream, chunk) => {
          logLines.push(chunk);
        },
      });
    } catch (err) {
      activeCallCount--;
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Agent error: ${msg}` }],
        isError: true,
      };
    }
    activeCallCount--;

    const isError =
      resultSubtype !== "success" && resultSubtype !== "error_max_turns";

    // Build a clean response: result first, then metadata
    const meta: Record<string, unknown> = {
      session_id: finalSessionId || null,
      model,
      subtype: resultSubtype,
      cost_usd: totalCostUsd,
    };
    if (resultSubtype === "error_max_turns") {
      meta["note"] =
        "Agent reached the turn limit. Pass session_id to continue.";
    }

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

// ── Graceful shutdown ─────────────────────────────────────────────────────────

let activeCallCount = 0;
let shuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return; // already handling
  shuttingDown = true;

  if (activeCallCount > 0) {
    process.stderr.write(
      `[orager-mcp] received ${signal} — draining ${activeCallCount} active call(s). Up to 60s...\n`
    );
    const deadline = Date.now() + 60_000;
    while (activeCallCount > 0 && Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, 500));
    }
    if (activeCallCount > 0) {
      process.stderr.write(
        `[orager-mcp] timeout waiting for ${activeCallCount} call(s) — forcing exit\n`
      );
    } else {
      process.stderr.write(`[orager-mcp] all calls complete, exiting cleanly\n`);
    }
  } else {
    process.stderr.write(`[orager-mcp] received ${signal} — no active calls, exiting\n`);
  }

  process.exit(0);
}

process.on("SIGTERM", () => { void gracefulShutdown("SIGTERM"); });
process.on("SIGINT", () => { void gracefulShutdown("SIGINT"); });

// ── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
