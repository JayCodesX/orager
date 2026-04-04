/**
 * Tests for the provider adapter system (ADR-0010).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Registry tests ──────────────────────────────────────────────────────────

describe("provider registry", () => {
  // Dynamic import to get fresh module state with mocks in place
  let registry: typeof import("../src/providers/registry.js");

  beforeEach(async () => {
    registry = await import("../src/providers/registry.js");
    registry._resetRegistryForTesting();
  });

  it("has openrouter and anthropic registered by default", () => {
    const names = registry.listProviders();
    expect(names).toContain("openrouter");
    expect(names).toContain("anthropic");
  });

  it("getProvider returns undefined for unregistered provider", () => {
    expect(registry.getProvider("bedrock")).toBeUndefined();
  });

  it("registerProvider adds a new provider", () => {
    const custom = {
      name: "custom" as const,
      displayName: "Custom Provider",
      supportsModel: () => true,
      chat: vi.fn(),
    };
    registry.registerProvider(custom);
    expect(registry.getProvider("custom")).toBe(custom);
    expect(registry.listProviders()).toContain("custom");
  });

  it("registerOllama adds ollama provider", () => {
    expect(registry.getProvider("ollama")).toBeUndefined();
    registry.registerOllama({ enabled: true, baseUrl: "http://localhost:11434" });
    const ollama = registry.getProvider("ollama");
    expect(ollama).toBeDefined();
    expect(ollama!.name).toBe("ollama");
  });

  it("_resetRegistryForTesting clears custom providers", () => {
    registry.registerOllama({ enabled: true });
    expect(registry.listProviders()).toContain("ollama");
    registry._resetRegistryForTesting();
    expect(registry.listProviders()).not.toContain("ollama");
    // But defaults remain
    expect(registry.listProviders()).toContain("openrouter");
    expect(registry.listProviders()).toContain("anthropic");
  });
});

// ── Resolver tests ──────────────────────────────────────────────────────────

describe("resolveProvider", () => {
  let registry: typeof import("../src/providers/registry.js");

  beforeEach(async () => {
    registry = await import("../src/providers/registry.js");
    registry._resetRegistryForTesting();
  });

  it("resolves to openrouter by default", () => {
    const { provider, reason } = registry.resolveProvider({
      apiKey: "test",
      model: "qwen/qwen3-8b",
      messages: [],
    });
    expect(provider.name).toBe("openrouter");
    expect(reason).toContain("openrouter");
  });

  it("resolves to ollama when _ollamaBaseUrl is set and ollama registered", () => {
    registry.registerOllama({ enabled: true, baseUrl: "http://localhost:11434" });
    const { provider, reason } = registry.resolveProvider({
      apiKey: "test",
      model: "qwen/qwen3-8b",
      messages: [],
      _ollamaBaseUrl: "http://localhost:11434",
    });
    expect(provider.name).toBe("ollama");
    expect(reason).toContain("ollama");
  });

  it("creates ad-hoc ollama provider when _ollamaBaseUrl set but not registered", () => {
    const { provider, reason } = registry.resolveProvider({
      apiKey: "test",
      model: "qwen/qwen3-8b",
      messages: [],
      _ollamaBaseUrl: "http://localhost:11434",
    });
    expect(provider.name).toBe("ollama");
    expect(reason).toContain("ad-hoc");
  });

  it("resolves to anthropic for anthropic/* models when API key is set", () => {
    // The anthropic provider's supportsModel checks process.env.ANTHROPIC_API_KEY
    const origKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    try {
      const { provider, reason } = registry.resolveProvider({
        apiKey: "test",
        model: "anthropic/claude-sonnet-4-20250514",
        messages: [],
      });
      expect(provider.name).toBe("anthropic");
      expect(reason).toContain("anthropic direct");
    } finally {
      if (origKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = origKey;
      }
    }
  });

  it("falls back to openrouter for anthropic/* when no ANTHROPIC_API_KEY", () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const { provider } = registry.resolveProvider({
        apiKey: "test",
        model: "anthropic/claude-sonnet-4-20250514",
        messages: [],
      });
      expect(provider.name).toBe("openrouter");
    } finally {
      if (origKey !== undefined) {
        process.env.ANTHROPIC_API_KEY = origKey;
      }
    }
  });

  it("ollama takes priority over anthropic direct", () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    registry.registerOllama({ enabled: true });
    try {
      const { provider } = registry.resolveProvider({
        apiKey: "test",
        model: "anthropic/claude-sonnet-4-20250514",
        messages: [],
        _ollamaBaseUrl: "http://localhost:11434",
      });
      expect(provider.name).toBe("ollama");
    } finally {
      if (origKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = origKey;
      }
    }
  });
});

// ── Provider implementation tests ───────────────────────────────────────────

describe("OpenRouterProvider", () => {
  it("supportsModel always returns true", async () => {
    const { OpenRouterProvider } = await import("../src/providers/openrouter-provider.js");
    const provider = new OpenRouterProvider();
    expect(provider.supportsModel("anything/model")).toBe(true);
    expect(provider.supportsModel("anthropic/claude-sonnet-4-20250514")).toBe(true);
    expect(provider.supportsModel("ollama-local")).toBe(true);
  });

  it("has correct name and displayName", async () => {
    const { OpenRouterProvider } = await import("../src/providers/openrouter-provider.js");
    const provider = new OpenRouterProvider();
    expect(provider.name).toBe("openrouter");
    expect(provider.displayName).toBe("OpenRouter");
  });
});

describe("AnthropicDirectProvider", () => {
  it("has correct name and displayName", async () => {
    const { AnthropicDirectProvider } = await import("../src/providers/anthropic-provider.js");
    const provider = new AnthropicDirectProvider();
    expect(provider.name).toBe("anthropic");
    expect(provider.displayName).toBe("Anthropic Direct");
  });

  it("supportsModel returns false when ANTHROPIC_API_KEY not set", async () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const { AnthropicDirectProvider } = await import("../src/providers/anthropic-provider.js");
      const provider = new AnthropicDirectProvider();
      expect(provider.supportsModel("anthropic/claude-sonnet-4-20250514")).toBe(false);
    } finally {
      if (origKey !== undefined) process.env.ANTHROPIC_API_KEY = origKey;
    }
  });

  it("supportsModel returns false for non-anthropic models", async () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    try {
      const { AnthropicDirectProvider } = await import("../src/providers/anthropic-provider.js");
      const provider = new AnthropicDirectProvider();
      expect(provider.supportsModel("openai/gpt-4o")).toBe(false);
      expect(provider.supportsModel("qwen/qwen3-8b")).toBe(false);
    } finally {
      if (origKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = origKey;
      }
    }
  });
});

describe("OllamaProvider", () => {
  it("has correct name and displayName", async () => {
    const { OllamaProvider } = await import("../src/providers/ollama-provider.js");
    const provider = new OllamaProvider({ enabled: true });
    expect(provider.name).toBe("ollama");
    expect(provider.displayName).toBe("Ollama (Local)");
  });

  it("supportsModel returns true when enabled", async () => {
    const { OllamaProvider } = await import("../src/providers/ollama-provider.js");
    const provider = new OllamaProvider({ enabled: true });
    expect(provider.supportsModel("anything")).toBe(true);
  });

  it("supportsModel returns false when disabled", async () => {
    const { OllamaProvider } = await import("../src/providers/ollama-provider.js");
    const provider = new OllamaProvider({ enabled: false });
    expect(provider.supportsModel("anything")).toBe(false);
  });
});

// ── Settings validation for providers block ─────────────────────────────────

describe("settings.validateSettings — providers block", () => {
  let validateSettings: typeof import("../src/settings.js").validateSettings;

  beforeEach(async () => {
    const mod = await import("../src/settings.js");
    validateSettings = mod.validateSettings;
  });

  it("accepts valid providers config", () => {
    const { settings, warnings, errors } = validateSettings({
      providers: {
        openrouter: { siteUrl: "https://myapp.com", siteName: "MyApp", zdr: true },
        anthropic: { apiKey: "sk-ant-test" },
        ollama: { enabled: true, baseUrl: "http://localhost:11434" },
      },
    });
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(0);
    expect(settings.providers?.openrouter?.siteUrl).toBe("https://myapp.com");
    expect(settings.providers?.anthropic?.apiKey).toBe("sk-ant-test");
    expect(settings.providers?.ollama?.enabled).toBe(true);
  });

  it("warns on unknown provider names", () => {
    const { warnings } = validateSettings({
      providers: {
        bedrock: { region: "us-east-1" },
      },
    });
    expect(warnings.some(w => w.includes("unknown provider") && w.includes("bedrock"))).toBe(true);
  });

  it("warns on unknown keys within a provider", () => {
    const { warnings } = validateSettings({
      providers: {
        openrouter: { unknownField: true },
      },
    });
    expect(warnings.some(w => w.includes("unknown key") && w.includes("unknownField"))).toBe(true);
  });

  it("validates openrouter.zdr is boolean", () => {
    const { warnings } = validateSettings({
      providers: {
        openrouter: { zdr: "yes" },
      },
    });
    expect(warnings.some(w => w.includes("zdr") && w.includes("boolean"))).toBe(true);
  });

  it("validates openrouter.dataCollection values", () => {
    const { warnings } = validateSettings({
      providers: {
        openrouter: { dataCollection: "maybe" },
      },
    });
    expect(warnings.some(w => w.includes("dataCollection"))).toBe(true);
  });

  it("validates openrouter.sort values", () => {
    const { warnings } = validateSettings({
      providers: {
        openrouter: { sort: "random" },
      },
    });
    expect(warnings.some(w => w.includes("sort"))).toBe(true);
  });

  it("validates ollama.enabled is boolean", () => {
    const { warnings } = validateSettings({
      providers: {
        ollama: { enabled: "true" },
      },
    });
    expect(warnings.some(w => w.includes("ollama.enabled") && w.includes("boolean"))).toBe(true);
  });

  it("rejects non-object providers block", () => {
    const { warnings } = validateSettings({
      providers: "openrouter",
    });
    expect(warnings.some(w => w.includes("providers") && w.includes("object"))).toBe(true);
  });

  it("rejects non-object provider config", () => {
    const { warnings } = validateSettings({
      providers: {
        openrouter: "default",
      },
    });
    expect(warnings.some(w => w.includes("providers.openrouter") && w.includes("object"))).toBe(true);
  });
});

// ── mergeSettings provider wiring ───────────────────────────────────────────

describe("mergeSettings — providers config wiring", () => {
  let mergeSettings: typeof import("../src/settings.js").mergeSettings;

  beforeEach(async () => {
    const mod = await import("../src/settings.js");
    mergeSettings = mod.mergeSettings;
  });

  it("maps providers.openrouter fields into flat AgentLoopOptions", () => {
    const runtime = { requireApproval: undefined, bashPolicy: undefined, hooks: undefined } as any;
    const fileSettings = {
      providers: {
        openrouter: {
          siteUrl: "https://myapp.com",
          siteName: "MyApp",
          preset: "custom-preset",
          transforms: ["middle-out"],
        },
      },
    };
    const merged = mergeSettings(runtime, fileSettings);
    expect(merged.siteUrl).toBe("https://myapp.com");
    expect(merged.siteName).toBe("MyApp");
    expect(merged.preset).toBe("custom-preset");
    expect(merged.transforms).toEqual(["middle-out"]);
  });

  it("runtime opts override providers.openrouter fields", () => {
    const runtime = {
      siteUrl: "https://override.com",
      requireApproval: undefined,
      bashPolicy: undefined,
      hooks: undefined,
    } as any;
    const fileSettings = {
      providers: {
        openrouter: {
          siteUrl: "https://myapp.com",
          siteName: "MyApp",
        },
      },
    };
    const merged = mergeSettings(runtime, fileSettings);
    expect(merged.siteUrl).toBe("https://override.com");
    expect(merged.siteName).toBe("MyApp"); // not overridden
  });

  it("maps providers.ollama into ollama config", () => {
    const runtime = { requireApproval: undefined, bashPolicy: undefined, hooks: undefined } as any;
    const fileSettings = {
      providers: {
        ollama: { enabled: true, baseUrl: "http://localhost:11434" },
      },
    };
    const merged = mergeSettings(runtime, fileSettings);
    expect(merged.ollama).toEqual({ enabled: true, baseUrl: "http://localhost:11434" });
  });

  it("runtime ollama config takes precedence over providers.ollama", () => {
    const runtime = {
      ollama: { enabled: false },
      requireApproval: undefined,
      bashPolicy: undefined,
      hooks: undefined,
    } as any;
    const fileSettings = {
      providers: {
        ollama: { enabled: true, baseUrl: "http://localhost:11434" },
      },
    };
    const merged = mergeSettings(runtime, fileSettings);
    expect(merged.ollama.enabled).toBe(false); // runtime wins
  });

  it("maps providers.openrouter.apiKey as lowest priority", () => {
    const runtime = { requireApproval: undefined, bashPolicy: undefined, hooks: undefined } as any;
    const fileSettings = {
      providers: {
        openrouter: { apiKey: "settings-key", apiKeys: ["extra1", "extra2"] },
      },
    };
    const merged = mergeSettings(runtime, fileSettings);
    expect(merged.apiKey).toBe("settings-key");
    expect(merged.apiKeys).toEqual(["extra1", "extra2"]);
  });

  it("does nothing when providers block is absent", () => {
    const runtime = { requireApproval: undefined, bashPolicy: undefined, hooks: undefined } as any;
    const merged = mergeSettings(runtime, {});
    expect(merged.siteUrl).toBeUndefined();
    expect(merged.ollama).toBeUndefined();
  });
});
