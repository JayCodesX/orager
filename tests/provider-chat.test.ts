/**
 * Tests for provider adapter chat() delegation (ADR-0010).
 *
 * Each provider is a thin wrapper — these tests verify that chat() delegates
 * to the correct underlying function, passes options through unchanged, and
 * returns the result unmodified. Kept in a separate file from providers.test.ts
 * because that file tests supportsModel() against the real shouldUseDirect()
 * implementation and cannot coexist with the openrouter.js mock used here.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mocked } from "./mock-helpers.js";

// ── Mocks (must declare all exports — Bun static linker requirement) ──────────

vi.mock("../src/openrouter.js", () => ({
  callOpenRouter:      vi.fn(),
  callDirect:          vi.fn(),
  shouldUseDirect:     vi.fn(),
  callEmbeddings:      vi.fn(),
  fetchGenerationMeta: vi.fn(),
}));

vi.mock("../src/ollama.js", () => ({
  DEFAULT_OLLAMA_BASE_URL: "http://localhost:11434",
  OLLAMA_MODEL_MAP:        {},
  resolveOllamaBaseUrl:    vi.fn().mockReturnValue("http://localhost:11434"),
  toOllamaTag:             vi.fn((id: string) => id),
  isOllamaRunning:         vi.fn().mockResolvedValue(true),
  listOllamaModels:        vi.fn().mockResolvedValue([]),
  isModelPulled:           vi.fn().mockResolvedValue(true),
  shouldUseOllama:         vi.fn().mockReturnValue(true),
  callOllama:              vi.fn(),
}));

// ── Import mocked modules so we can configure return values ──────────────────

import {
  callOpenRouter,
  callDirect,
  callEmbeddings as _callEmbeddings,
  fetchGenerationMeta as _fetchGenerationMeta,
} from "../src/openrouter.js";
import { callOllama } from "../src/ollama.js";

// ── Shared fixtures ───────────────────────────────────────────────────────────

const OPTS = {
  apiKey:   "sk-test",
  model:    "test/model",
  messages: [{ role: "user" as const, content: "Hello" }],
};

const MOCK_RESULT = {
  content:          "Hello!",
  reasoning:        "",
  toolCalls:        [],
  usage:            { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  cachedTokens:     0,
  cacheWriteTokens: 0,
  model:            "test/model",
  finishReason:     "stop",
  isError:          false,
};

const MOCK_META = {
  id:                   "gen-001",
  model:                "test/model",
  providerName:         "TestProvider",
  totalCost:            0.001,
  cacheDiscount:        0,
  nativeTokensPrompt:   10,
  nativeTokensCompletion: 5,
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ── OpenRouterProvider ────────────────────────────────────────────────────────

describe("OpenRouterProvider.chat()", () => {
  it("delegates to callOpenRouter", async () => {
    mocked(callOpenRouter).mockResolvedValue(MOCK_RESULT as never);
    const { OpenRouterProvider } = await import("../src/providers/openrouter-provider.js");
    const provider = new OpenRouterProvider();

    const result = await provider.chat(OPTS as never);

    expect(mocked(callOpenRouter)).toHaveBeenCalledOnce();
    expect(mocked(callOpenRouter)).toHaveBeenCalledWith(OPTS);
    expect(result).toBe(MOCK_RESULT);
  });

  it("passes all options through to callOpenRouter unchanged", async () => {
    mocked(callOpenRouter).mockResolvedValue(MOCK_RESULT as never);
    const { OpenRouterProvider } = await import("../src/providers/openrouter-provider.js");
    const provider = new OpenRouterProvider();
    const richOpts = { ...OPTS, siteUrl: "https://example.com", zdr: true };

    await provider.chat(richOpts as never);

    expect(mocked(callOpenRouter)).toHaveBeenCalledWith(richOpts);
  });

  it("propagates errors from callOpenRouter", async () => {
    mocked(callOpenRouter).mockRejectedValue(new Error("rate limited"));
    const { OpenRouterProvider } = await import("../src/providers/openrouter-provider.js");
    const provider = new OpenRouterProvider();

    await expect(provider.chat(OPTS as never)).rejects.toThrow("rate limited");
  });
});

describe("OpenRouterProvider.fetchGenerationMeta()", () => {
  it("delegates to fetchGenerationMeta", async () => {
    mocked(_fetchGenerationMeta).mockResolvedValue(MOCK_META as never);
    const { OpenRouterProvider } = await import("../src/providers/openrouter-provider.js");
    const provider = new OpenRouterProvider();

    const result = await provider.fetchGenerationMeta!("sk-test", "gen-001");

    expect(mocked(_fetchGenerationMeta)).toHaveBeenCalledWith("sk-test", "gen-001");
    expect(result).toBe(MOCK_META);
  });

  it("returns null when fetchGenerationMeta returns null", async () => {
    mocked(_fetchGenerationMeta).mockResolvedValue(null);
    const { OpenRouterProvider } = await import("../src/providers/openrouter-provider.js");
    const provider = new OpenRouterProvider();

    const result = await provider.fetchGenerationMeta!("sk-test", "gen-001");

    expect(result).toBeNull();
  });
});

describe("OpenRouterProvider.callEmbeddings()", () => {
  it("delegates to callEmbeddings", async () => {
    const mockVecs = [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]];
    mocked(_callEmbeddings).mockResolvedValue(mockVecs);
    const { OpenRouterProvider } = await import("../src/providers/openrouter-provider.js");
    const provider = new OpenRouterProvider();

    const result = await provider.callEmbeddings!("sk-test", "text-embed-model", ["hello", "world"]);

    expect(mocked(_callEmbeddings)).toHaveBeenCalledWith("sk-test", "text-embed-model", ["hello", "world"]);
    expect(result).toBe(mockVecs);
  });
});

// ── AnthropicDirectProvider ───────────────────────────────────────────────────

describe("AnthropicDirectProvider.chat()", () => {
  it("delegates to callDirect", async () => {
    mocked(callDirect).mockResolvedValue(MOCK_RESULT as never);
    const { AnthropicDirectProvider } = await import("../src/providers/anthropic-provider.js");
    const provider = new AnthropicDirectProvider();

    const result = await provider.chat(OPTS as never);

    expect(mocked(callDirect)).toHaveBeenCalledOnce();
    expect(mocked(callDirect)).toHaveBeenCalledWith(OPTS);
    expect(result).toBe(MOCK_RESULT);
  });

  it("passes all options through to callDirect unchanged", async () => {
    mocked(callDirect).mockResolvedValue(MOCK_RESULT as never);
    const { AnthropicDirectProvider } = await import("../src/providers/anthropic-provider.js");
    const provider = new AnthropicDirectProvider();
    const richOpts = { ...OPTS, model: "anthropic/claude-sonnet-4-20250514", maxTokens: 1024 };

    await provider.chat(richOpts as never);

    expect(mocked(callDirect)).toHaveBeenCalledWith(richOpts);
  });

  it("propagates errors from callDirect", async () => {
    mocked(callDirect).mockRejectedValue(new Error("unauthorized"));
    const { AnthropicDirectProvider } = await import("../src/providers/anthropic-provider.js");
    const provider = new AnthropicDirectProvider();

    await expect(provider.chat(OPTS as never)).rejects.toThrow("unauthorized");
  });

  it("does not expose fetchGenerationMeta (Anthropic has no generation cost endpoint)", async () => {
    const { AnthropicDirectProvider } = await import("../src/providers/anthropic-provider.js");
    const provider = new AnthropicDirectProvider();
    expect(provider.fetchGenerationMeta).toBeUndefined();
  });
});

// ── OllamaProvider ────────────────────────────────────────────────────────────

describe("OllamaProvider.chat()", () => {
  it("delegates to callOllama with config", async () => {
    mocked(callOllama).mockResolvedValue(MOCK_RESULT as never);
    const { OllamaProvider } = await import("../src/providers/ollama-provider.js");
    const config = { enabled: true, baseUrl: "http://localhost:11434" };
    const provider = new OllamaProvider(config);

    const result = await provider.chat(OPTS as never);

    expect(mocked(callOllama)).toHaveBeenCalledOnce();
    expect(mocked(callOllama)).toHaveBeenCalledWith(OPTS, config);
    expect(result).toBe(MOCK_RESULT);
  });

  it("passes all options through to callOllama unchanged", async () => {
    mocked(callOllama).mockResolvedValue(MOCK_RESULT as never);
    const { OllamaProvider } = await import("../src/providers/ollama-provider.js");
    const config = { enabled: true, baseUrl: "http://my-ollama:11434", model: "qwen2.5:7b" };
    const provider = new OllamaProvider(config);
    const richOpts = { ...OPTS, model: "qwen/qwen2.5-7b" };

    await provider.chat(richOpts as never);

    expect(mocked(callOllama)).toHaveBeenCalledWith(richOpts, config);
  });

  it("passes custom baseUrl from config to callOllama", async () => {
    mocked(callOllama).mockResolvedValue(MOCK_RESULT as never);
    const { OllamaProvider } = await import("../src/providers/ollama-provider.js");
    const config = { enabled: true, baseUrl: "http://remote-gpu:11434" };
    const provider = new OllamaProvider(config);

    await provider.chat(OPTS as never);

    const [, passedConfig] = mocked(callOllama).mock.calls[0]!;
    expect((passedConfig as typeof config).baseUrl).toBe("http://remote-gpu:11434");
  });

  it("propagates errors from callOllama", async () => {
    mocked(callOllama).mockRejectedValue(new Error("connection refused"));
    const { OllamaProvider } = await import("../src/providers/ollama-provider.js");
    const provider = new OllamaProvider({ enabled: true });

    await expect(provider.chat(OPTS as never)).rejects.toThrow("connection refused");
  });

  it("does not expose fetchGenerationMeta (local inference has no cost metadata)", async () => {
    const { OllamaProvider } = await import("../src/providers/ollama-provider.js");
    const provider = new OllamaProvider({ enabled: true });
    expect(provider.fetchGenerationMeta).toBeUndefined();
  });
});
