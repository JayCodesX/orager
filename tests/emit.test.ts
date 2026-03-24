import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { emit } from "../src/emit.js";

describe("emit", () => {
  let writtenChunks: string[];
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    writtenChunks = [];
    spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writtenChunks.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    spy.mockRestore();
  });

  it("writes valid JSON followed by a newline", () => {
    emit({ type: "system", subtype: "init", model: "test-model", session_id: "abc" });
    expect(writtenChunks).toHaveLength(1);
    const written = writtenChunks[0];
    expect(written).toMatch(/\n$/);
    const parsed = JSON.parse(written.trimEnd());
    expect(parsed).toBeDefined();
  });

  it("emits init event with correct shape", () => {
    emit({ type: "system", subtype: "init", model: "deepseek/deepseek-chat-v3-2", session_id: "session-123" });
    const parsed = JSON.parse(writtenChunks[0].trimEnd());
    expect(parsed).toEqual({
      type: "system",
      subtype: "init",
      model: "deepseek/deepseek-chat-v3-2",
      session_id: "session-123",
    });
  });

  it("emits result event with correct shape", () => {
    emit({
      type: "result",
      subtype: "success",
      result: "done",
      session_id: "sess-456",
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 },
      total_cost_usd: 0.001,
    });
    const parsed = JSON.parse(writtenChunks[0].trimEnd());
    expect(parsed.type).toBe("result");
    expect(parsed.subtype).toBe("success");
    expect(parsed.result).toBe("done");
    expect(parsed.session_id).toBe("sess-456");
    expect(parsed.usage).toEqual({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 });
    expect(parsed.total_cost_usd).toBe(0.001);
  });

  it("emits tool event — omits is_error when not an error", () => {
    emit({
      type: "tool",
      content: [{ type: "tool_result", tool_use_id: "tool-use-id", content: "some output" }],
    });
    const parsed = JSON.parse(writtenChunks[0].trimEnd());
    expect(parsed.type).toBe("tool");
    const item = parsed.content[0];
    expect(item.tool_use_id).toBe("tool-use-id");
    expect(item.content).toBe("some output");
    expect(item.is_error).toBeUndefined();
  });

  it("emits tool event — includes is_error when true", () => {
    emit({
      type: "tool",
      content: [{ type: "tool_result", tool_use_id: "tool-use-id-2", content: "error output", is_error: true }],
    });
    const parsed = JSON.parse(writtenChunks[0].trimEnd());
    const item = parsed.content[0];
    expect(item.is_error).toBe(true);
  });
});
