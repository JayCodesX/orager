import { describe, it, expect, vi, afterEach } from "vitest";
import { callOpenRouter } from "../src/openrouter.js";

const CALL_OPTS = {
  apiKey: "test-key",
  model: "deepseek/deepseek-chat-v3-2",
  messages: [{ role: "user" as const, content: "hi" }],
  tools: [],
};

function makeStreamResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  const body = lines.join("\n") + "\n";
  const uint8 = encoder.encode(body);

  // Build a minimal ReadableStream that returns all bytes in one chunk
  let sent = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(uint8);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("callOpenRouter — happy path", () => {
  it("parses content, usage, and finishReason from a 3-chunk stream", async () => {
    const lines = [
      `data: {"id":"1","model":"deepseek/deepseek-chat-v3-2","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}`,
      `data: {"id":"1","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}`,
      `data: {"id":"1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}`,
      `data: [DONE]`,
    ];

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeStreamResponse(lines)));

    const result = await callOpenRouter(CALL_OPTS);

    expect(result.content).toBe("Hello world");
    expect(result.usage.prompt_tokens).toBe(10);
    expect(result.usage.completion_tokens).toBe(5);
    expect(result.usage.total_tokens).toBe(15);
    expect(result.finishReason).toBe("stop");
    expect(result.isError).toBe(false);
  });

  it("extracts model name from the stream", async () => {
    const lines = [
      `data: {"id":"1","model":"openai/gpt-4o","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}`,
      `data: [DONE]`,
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeStreamResponse(lines)));
    const result = await callOpenRouter(CALL_OPTS);
    expect(result.model).toBe("openai/gpt-4o");
  });

  it("accumulates reasoning via delta.reasoning", async () => {
    const lines = [
      `data: {"id":"1","choices":[{"index":0,"delta":{"reasoning":"step 1"},"finish_reason":null}]}`,
      `data: {"id":"1","choices":[{"index":0,"delta":{"reasoning":" step 2","content":"answer"},"finish_reason":"stop"}]}`,
      `data: [DONE]`,
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeStreamResponse(lines)));
    const result = await callOpenRouter(CALL_OPTS);
    expect(result.reasoning).toBe("step 1 step 2");
    expect(result.content).toBe("answer");
  });

  it("accumulates tool call arguments split across multiple chunks", async () => {
    const lines = [
      `data: {"id":"2","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-abc","type":"function","function":{"name":"bash","arguments":"{\\"comm"}}]},"finish_reason":null}]}`,
      `data: {"id":"2","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"and\\":\\"ec"}}]},"finish_reason":null}]}`,
      `data: {"id":"2","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ho hello\\"}"}}]},"finish_reason":"tool_calls"}]}`,
      `data: [DONE]`,
    ];

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeStreamResponse(lines)));

    const result = await callOpenRouter(CALL_OPTS);

    expect(result.toolCalls).toHaveLength(1);
    const tc = result.toolCalls[0];
    expect(tc.id).toBe("call-abc");
    expect(tc.function.name).toBe("bash");
    const args = JSON.parse(tc.function.arguments);
    expect(args.command).toBe("echo hello");
  });

  it("handles empty stream (just [DONE]) without crashing", async () => {
    const lines = [`data: [DONE]`];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeStreamResponse(lines)));
    const result = await callOpenRouter(CALL_OPTS);
    expect(result.content).toBe("");
    expect(result.toolCalls).toHaveLength(0);
    expect(result.isError).toBe(false);
  });

  it("silently ignores malformed JSON lines", async () => {
    const lines = [
      `data: NOT_JSON`,
      `data: {"id":"1","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}`,
      `data: [DONE]`,
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeStreamResponse(lines)));
    const result = await callOpenRouter(CALL_OPTS);
    expect(result.content).toBe("ok");
    expect(result.isError).toBe(false);
  });

  it("reads content split across trailing buffer correctly", async () => {
    // Simulate a stream where the final SSE line ends up in the trailing buffer
    // (not followed by a newline in the ReadableStream chunk)
    const encoder = new TextEncoder();
    const line1 = `data: {"id":"1","choices":[{"index":0,"delta":{"content":"part1"},"finish_reason":null}]}\n`;
    const line2 = `data: {"id":"1","choices":[{"index":0,"delta":{"content":"part2"},"finish_reason":"stop"}]}`;
    // No trailing newline on line2 — it stays in the buffer until drain
    let sent = 0;
    const chunks = [encoder.encode(line1), encoder.encode(line2)];
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent < chunks.length) {
          controller.enqueue(chunks[sent++]);
        } else {
          controller.close();
        }
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }))
    );
    const result = await callOpenRouter(CALL_OPTS);
    expect(result.content).toBe("part1part2");
  });

  it("filters out tool calls with no id or name", async () => {
    const lines = [
      // A complete tool call
      `data: {"id":"1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"bash","arguments":"{}"}}]},"finish_reason":null}]}`,
      // An incomplete tool call (missing name — would be filtered)
      `data: {"id":"1","choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"call-2","function":{"arguments":"{}"}}]},"finish_reason":"tool_calls"}]}`,
      `data: [DONE]`,
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeStreamResponse(lines)));
    const result = await callOpenRouter(CALL_OPTS);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].id).toBe("call-1");
  });

  it("extracts cached tokens from prompt_tokens_details", async () => {
    const lines = [
      `data: {"id":"1","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110,"prompt_tokens_details":{"cached_tokens":80}}}`,
      `data: [DONE]`,
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeStreamResponse(lines)));
    const result = await callOpenRouter(CALL_OPTS);
    expect(result.cachedTokens).toBe(80);
  });
});

describe("callOpenRouter — error handling", () => {
  it("returns isError:true with httpStatus for non-ok HTTP response (401)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401, statusText: "Unauthorized" }))
    );
    const result = await callOpenRouter(CALL_OPTS);
    expect(result.isError).toBe(true);
    expect(result.httpStatus).toBe(401);
    expect(result.errorMessage).toContain("OpenRouter error 401");
  });

  it("returns isError:true with httpStatus for non-ok HTTP response (500)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("Server Error", { status: 500, statusText: "Internal Server Error" }))
    );
    const result = await callOpenRouter(CALL_OPTS);
    expect(result.isError).toBe(true);
    expect(result.httpStatus).toBe(500);
    expect(result.errorMessage).toContain("500");
  });

  it("throws when response has no body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    );
    await expect(callOpenRouter(CALL_OPTS)).rejects.toThrow("no body");
  });

  it("returns isError:true for mid-stream chunk.error", async () => {
    const lines = [
      `data: {"id":"1","choices":[{"index":0,"delta":{"content":"part"},"finish_reason":null}]}`,
      `data: {"id":"1","error":{"code":503,"message":"Service unavailable"},"choices":[{"index":0,"delta":{},"finish_reason":"error"}]}`,
      `data: [DONE]`,
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeStreamResponse(lines)));
    const result = await callOpenRouter(CALL_OPTS);
    expect(result.isError).toBe(true);
    expect(result.errorMessage).toContain("Service unavailable");
  });

  it("returns isError:true when finish_reason is error with no error object", async () => {
    const lines = [
      `data: {"id":"1","choices":[{"index":0,"delta":{},"finish_reason":"error"}]}`,
      `data: [DONE]`,
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeStreamResponse(lines)));
    const result = await callOpenRouter(CALL_OPTS);
    expect(result.isError).toBe(true);
    expect(result.errorMessage).toContain("error");
  });

  it("slices error body to 500 chars in the error message", async () => {
    const longBody = "x".repeat(1000);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(longBody, { status: 500, statusText: "Internal Server Error" }))
    );
    const result = await callOpenRouter(CALL_OPTS);
    expect(result.isError).toBe(true);
    expect(result.errorMessage).toBeDefined();
    expect(result.errorMessage!).toContain("500");
    // Strip the "OpenRouter error 500 …: " prefix; remaining body must be ≤ 500 chars
    const bodyPart = result.errorMessage!.replace(/^[^:]+:\s*/, "");
    expect(bodyPart.length).toBeLessThanOrEqual(500);
  });

  it("sends HTTP-Referer header when siteUrl is set", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(makeStreamResponse([`data: [DONE]`]));
    vi.stubGlobal("fetch", fetchSpy);
    await callOpenRouter({ ...CALL_OPTS, siteUrl: "https://my-app.example.com" });
    const headers = fetchSpy.mock.calls[0][1].headers as Record<string, string>;
    expect(headers["HTTP-Referer"]).toBe("https://my-app.example.com");
  });

  it("sends X-Title header when siteName is set", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(makeStreamResponse([`data: [DONE]`]));
    vi.stubGlobal("fetch", fetchSpy);
    await callOpenRouter({ ...CALL_OPTS, siteName: "My App" });
    const headers = fetchSpy.mock.calls[0][1].headers as Record<string, string>;
    expect(headers["X-Title"]).toBe("My App");
  });

  it("does not send HTTP-Referer or X-Title when site fields are absent", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(makeStreamResponse([`data: [DONE]`]));
    vi.stubGlobal("fetch", fetchSpy);
    await callOpenRouter(CALL_OPTS);
    const headers = fetchSpy.mock.calls[0][1].headers as Record<string, string>;
    expect(headers["HTTP-Referer"]).toBeUndefined();
    expect(headers["X-Title"]).toBeUndefined();
  });

  it("invokes onChunk callback for each parsed chunk", async () => {
    const lines = [
      `data: {"id":"1","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}`,
      `data: [DONE]`,
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeStreamResponse(lines)));
    const chunks: unknown[] = [];
    await callOpenRouter({ ...CALL_OPTS, onChunk: (c) => chunks.push(c) });
    expect(chunks).toHaveLength(1);
  });
});
