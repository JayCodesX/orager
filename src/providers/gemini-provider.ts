/**
 * Google Gemini Direct API provider adapter.
 *
 * Calls the Google Generative Language API directly, converting to/from
 * the orager-native ChatCallOptions/ChatCallResult format.
 *
 * Supported auth methods (in priority order):
 *   1. GEMINI_API_KEY / GOOGLE_API_KEY env var (API key)
 *   2. providers.gemini.apiKey in settings.json
 *   (Google OAuth via GOOGLE_APPLICATION_CREDENTIALS is a future Phase 2 addition)
 *
 * Note on training: Gemini API outputs may NOT be used to train other models
 * per Google's terms. The OMLS training pipeline hard-blocks gemini/* trajectories.
 */

import type { ModelProvider, ChatCallOptions, ChatCallResult } from "./types.js";
import type { Message, ToolDefinition, ToolCall } from "../types.js";
import { trace } from "@opentelemetry/api";

const GEMINI_BASE = (process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com").replace(/\/$/, "");

/** Model prefixes routed to Gemini Direct when GEMINI_API_KEY is set. */
const GEMINI_MODEL_PREFIXES = ["gemini/", "google/gemini", "gemini-"];

function isGeminiModel(model: string): boolean {
  return GEMINI_MODEL_PREFIXES.some((p) => model.startsWith(p));
}

/** Normalize model name to bare Gemini model ID (e.g. "gemini-2.5-pro"). */
function normalizeModel(model: string): string {
  if (model.startsWith("gemini/")) return model.slice(7);
  if (model.startsWith("google/")) return model.slice(7);
  return model;
}

function getApiKey(opts: ChatCallOptions): string | undefined {
  return opts.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
}

export class GeminiDirectProvider implements ModelProvider {
  readonly name = "gemini" as const;
  readonly displayName = "Google Gemini Direct";

  supportsModel(model: string): boolean {
    return isGeminiModel(model) && !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
  }

  async chat(opts: ChatCallOptions): Promise<ChatCallResult> {
    return callGeminiDirect(opts);
  }
}

export async function callGeminiDirect(opts: ChatCallOptions): Promise<ChatCallResult> {
  const tracer = trace.getTracer("orager");
  return tracer.startActiveSpan("gemini.chat", async (span) => {
    try {
      const result = await _callGemini(opts);
      span.setAttribute("model", result.model);
      span.setAttribute("prompt_tokens", result.usage.prompt_tokens);
      span.setAttribute("completion_tokens", result.usage.completion_tokens);
      return result;
    } finally {
      span.end();
    }
  });
}

// ── Gemini API types ──────────────────────────────────────────────────────────

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: { content: string } };
  inlineData?: { mimeType: string; data: string };
}

interface GeminiTool {
  functionDeclarations: Array<{
    name: string;
    description: string;
    parameters?: Record<string, unknown>;
  }>;
}

interface GeminiCandidate {
  content: GeminiContent;
  finishReason: string;
}

interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

interface GeminiStreamChunk {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsage;
  error?: { message?: string; code?: number };
}

// ── Message conversion ────────────────────────────────────────────────────────

/**
 * Convert orager's OpenAI-compatible messages to Gemini's content format.
 * Gemini uses "user"/"model" roles and a flat parts array.
 */
function convertMessages(messages: Message[]): { system?: string; contents: GeminiContent[] } {
  let system: string | undefined;
  const contents: GeminiContent[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      system = typeof msg.content === "string" ? msg.content : "";
      continue;
    }

    if (msg.role === "user") {
      if (Array.isArray(msg.content)) {
        // Multimodal content blocks
        const parts: GeminiPart[] = [];
        for (const block of msg.content as unknown as Array<Record<string, unknown>>) {
          if (block.type === "text") {
            parts.push({ text: block.text as string });
          } else if (block.type === "image_url") {
            // Convert data URI to inlineData
            const url = (block.image_url as { url: string }).url;
            const match = url.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
              parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
            }
          }
        }
        contents.push({ role: "user", parts });
      } else {
        contents.push({ role: "user", parts: [{ text: msg.content as string }] });
      }
      continue;
    }

    if (msg.role === "assistant") {
      const parts: GeminiPart[] = [];
      if (typeof msg.content === "string" && msg.content) {
        parts.push({ text: msg.content });
      }
      // Tool calls from assistant
      if (Array.isArray((msg as unknown as Record<string, unknown>).tool_calls)) {
        for (const tc of (msg as unknown as Record<string, unknown>).tool_calls as ToolCall[]) {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(tc.function.arguments) as Record<string, unknown>; } catch { /* keep empty */ }
          parts.push({ functionCall: { name: tc.function.name, args } });
        }
      }
      if (parts.length > 0) contents.push({ role: "model", parts });
      continue;
    }

    if (msg.role === "tool") {
      // Tool results — Gemini expects these as user-role functionResponse parts
      const last = contents[contents.length - 1];
      const part: GeminiPart = {
        functionResponse: {
          name: (msg as unknown as Record<string, unknown>).name as string ?? "tool",
          response: { content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content) },
        },
      };
      if (last?.role === "user") {
        last.parts.push(part);
      } else {
        contents.push({ role: "user", parts: [part] });
      }
    }
  }

  return { system, contents };
}

/** Convert orager ToolDefinitions to Gemini function declarations. */
function convertTools(tools?: ToolDefinition[]): GeminiTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return [{
    functionDeclarations: tools.map((t) => ({
      name: t.function.name,
      description: t.function.description ?? "",
      parameters: t.function.parameters as unknown as Record<string, unknown> | undefined,
    })),
  }];
}

// ── Main call ─────────────────────────────────────────────────────────────────

async function _callGemini(opts: ChatCallOptions): Promise<ChatCallResult> {
  const apiKey = getApiKey(opts);
  if (!apiKey) {
    return makeErrorResult("GEMINI_API_KEY (or GOOGLE_API_KEY) is not set");
  }

  const modelId = normalizeModel(opts.model);
  const { system, contents } = convertMessages(opts.messages);
  const geminiTools = convertTools(opts.tools);

  const body: Record<string, unknown> = { contents };

  if (system) {
    body.systemInstruction = { parts: [{ text: system }] };
  }

  if (geminiTools) body.tools = geminiTools;

  const genConfig: Record<string, unknown> = {};
  if (opts.max_completion_tokens) genConfig.maxOutputTokens = opts.max_completion_tokens;
  if (opts.temperature !== undefined) genConfig.temperature = opts.temperature;
  if (opts.top_p !== undefined) genConfig.topP = opts.top_p;
  if (opts.top_k !== undefined) genConfig.topK = opts.top_k;
  if (opts.stop) genConfig.stopSequences = opts.stop;
  if (Object.keys(genConfig).length > 0) body.generationConfig = genConfig;

  const url = `${GEMINI_BASE}/v1beta/models/${modelId}:streamGenerateContent?key=${apiKey}&alt=sse`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "orager/1.0" },
      body: JSON.stringify(body),
      signal: opts.signal ?? undefined,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return makeErrorResult(`Gemini fetch error: ${msg}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return makeErrorResult(`Gemini API error ${res.status}: ${text}`);
  }

  return parseGeminiStream(res, opts, modelId);
}

async function parseGeminiStream(
  res: Response,
  opts: ChatCallOptions,
  modelId: string,
): Promise<ChatCallResult> {
  const contentParts: string[] = [];
  const toolCallMap = new Map<string, { id: string; name: string; args: string }>();
  let usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } = {
    prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
  };
  let finishReason: string | null = null;
  let streamError: string | null = null;

  const reader = res.body?.getReader();
  if (!reader) return makeErrorResult("Gemini: no response body");

  const decoder = new TextDecoder();
  let buf = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (!data) continue;

        let chunk: GeminiStreamChunk;
        try {
          chunk = JSON.parse(data) as GeminiStreamChunk;
        } catch {
          continue;
        }

        if (chunk.error) {
          streamError = chunk.error.message ?? "Gemini stream error";
          break;
        }

        if (chunk.usageMetadata) {
          usage = {
            prompt_tokens: chunk.usageMetadata.promptTokenCount ?? 0,
            completion_tokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
            total_tokens: chunk.usageMetadata.totalTokenCount ?? 0,
          };
        }

        for (const candidate of chunk.candidates ?? []) {
          if (candidate.finishReason) finishReason = candidate.finishReason;

          for (const part of candidate.content?.parts ?? []) {
            if (part.text) {
              contentParts.push(part.text);
              opts.onChunk?.({
                choices: [{ delta: { content: part.text }, finish_reason: null, index: 0 }],
                id: "",
                model: `gemini/${modelId}`,
                usage: undefined as unknown as typeof usage,
              });
            }

            if (part.functionCall) {
              // Use function name as key since Gemini doesn't emit IDs in stream
              const key = part.functionCall.name;
              if (!toolCallMap.has(key)) {
                toolCallMap.set(key, {
                  id: `gemini-${Date.now()}-${key}`,
                  name: key,
                  args: JSON.stringify(part.functionCall.args ?? {}),
                });
              }
            }
          }
        }
      }
    }
  } catch (err) {
    if ((err as Error).name !== "AbortError") {
      streamError = err instanceof Error ? err.message : String(err);
    }
  } finally {
    reader.releaseLock();
  }

  if (streamError) return makeErrorResult(streamError);

  const toolCalls: ToolCall[] = [...toolCallMap.values()].map((tc) => ({
    id: tc.id,
    type: "function" as const,
    function: { name: tc.name, arguments: tc.args },
  }));

  return {
    content: contentParts.join(""),
    reasoning: "",
    toolCalls,
    usage,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    model: `gemini/${modelId}`,
    finishReason: finishReason ?? "stop",
    isError: false,
  };
}

function makeErrorResult(message: string): ChatCallResult {
  return {
    content: message,
    reasoning: "",
    toolCalls: [],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    cachedTokens: 0,
    cacheWriteTokens: 0,
    model: "gemini/unknown",
    finishReason: "stop",
    isError: true,
  };
}
