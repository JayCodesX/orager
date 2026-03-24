import { spawn } from "node:child_process";
import type { ToolExecutor, ToolResult } from "../types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_CHARS = 20_000;

export const bashTool: ToolExecutor = {
  definition: {
    type: "function",
    function: {
      name: "bash",
      description:
        "Execute a bash command in the working directory. Use for running tests, installing packages, checking git status, reading command output, etc.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The bash command to execute",
          },
          timeout_ms: {
            type: "number",
            description:
              "Timeout in milliseconds (default 30000, max 300000)",
          },
        },
        required: ["command"],
      },
    },
  },

  async execute(
    input: Record<string, unknown>,
    cwd: string
  ): Promise<ToolResult> {
    if (typeof input["command"] !== "string" || !input["command"]) {
      return { toolCallId: "", content: "command must be a non-empty string", isError: true };
    }
    const command = input["command"];
    const rawTimeout =
      typeof input["timeout_ms"] === "number"
        ? (input["timeout_ms"] as number)
        : DEFAULT_TIMEOUT_MS;
    if (rawTimeout < 0) {
      return { toolCallId: "", content: "timeout_ms must be non-negative", isError: true };
    }
    const timeoutMs = Math.min(rawTimeout, MAX_TIMEOUT_MS);

    return new Promise<ToolResult>((resolve) => {
      const chunks: string[] = [];
      let timedOut = false;
      let killTimer: ReturnType<typeof setTimeout> | null = null;

      const proc = spawn("bash", ["-c", command], {
        cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      proc.stdout.on("data", (data: Buffer) => {
        chunks.push(data.toString());
      });

      proc.stderr.on("data", (data: Buffer) => {
        const lines = data.toString().split("\n");
        const prefixed = lines
          .map((l, i) =>
            i === lines.length - 1 && l === "" ? "" : `[stderr] ${l}`
          )
          .join("\n");
        chunks.push(prefixed);
      });

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGTERM");
        killTimer = setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            // process may have already exited
          }
        }, 2_000);
      }, timeoutMs);

      proc.on("close", (code) => {
        clearTimeout(timeoutHandle);
        if (killTimer !== null) clearTimeout(killTimer);

        if (timedOut) {
          resolve({
            toolCallId: "",
            content: `[timed out after ${timeoutMs}ms]\n${buildOutput(chunks)}`,
            isError: true,
          });
          return;
        }

        const output = buildOutput(chunks);
        const isError = code !== 0 && code !== null;
        resolve({ toolCallId: "", content: output, isError });
      });

      proc.on("error", (err) => {
        clearTimeout(timeoutHandle);
        if (killTimer !== null) clearTimeout(killTimer);
        resolve({
          toolCallId: "",
          content: `Failed to spawn process: ${err.message}`,
          isError: true,
        });
      });
    });
  },
};

function buildOutput(chunks: string[]): string {
  let output = chunks.join("");
  if (output.length > MAX_OUTPUT_CHARS) {
    output = output.slice(0, MAX_OUTPUT_CHARS) + "\n[output truncated]";
  }
  return output;
}
