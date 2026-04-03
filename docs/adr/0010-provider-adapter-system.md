# ADR-0010: Provider Adapter System — Decouple Model Routing from OpenRouter

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-04-03 |
| **Deciders** | JayCodesX |

---

## Context

Orager's configuration system grew organically around OpenRouter as the sole model gateway. By Sprint 14, **27 of 103 config fields (31%)** were OpenRouter-specific — provider routing, quantizations, presets, ZDR, data collection — yet completely irrelevant when using Anthropic Direct, Ollama, or any future provider (Azure, Bedrock, Groq).

### Problems

1. **Configuration clutter.** Users configuring Ollama still see `providerOrder`, `quantizations`, `zdr`, and other OpenRouter-only fields. There's no way to know which flags apply to which backend.

2. **Tight coupling in retry logic.** The retry module (`retry.ts`) contained a hard-coded if/else chain:
   ```typescript
   if (opts._ollamaBaseUrl) → callOllama()
   else if (shouldUseDirect(model)) → callDirect()
   else → callOpenRouter()
   ```
   Adding a new provider meant editing this chain, plus every file that calls the API directly.

3. **Scattered direct calls.** Seven modules (`session-summarizer`, `skillbank`, `session`, `loop`, `tools/remember`, `omls/prm-scorer`, `omls/confidence-router`) imported `callOpenRouter` or `callEmbeddings` directly, making them structurally dependent on OpenRouter even when the user's configured backend was different.

4. **No extensibility story.** The Plugin SDK (Sprint 15) needs a way for third-party providers to register themselves. Without an interface, "add a provider" means touching 10+ files.

## Decision

Introduce a **provider adapter layer** with three components:

1. **`ModelProvider` interface** — the contract every backend implements
2. **Provider adapters** — thin wrappers around existing code (OpenRouter, Anthropic Direct, Ollama)
3. **Provider registry** — singleton that resolves the correct adapter for a given request

### Architecture

```
settings.json                    src/providers/
┌────────────────────┐          ┌──────────────────────────┐
│ providers:          │          │ types.ts     ModelProvider│
│   openrouter:       │  ──→    │ registry.ts  resolve()   │
│     siteUrl: ...    │          │ openrouter-provider.ts   │
│     zdr: true       │          │ anthropic-provider.ts    │
│   anthropic:        │          │ ollama-provider.ts       │
│     apiKey: ...     │          └──────────┬───────────────┘
│   ollama:           │                     │
│     enabled: true   │                     ▼
└────────────────────┘          ┌──────────────────────────┐
                                │ retry.ts                 │
                                │   resolveProvider(opts)   │
                                │     .provider.chat(opts)  │
                                └──────────────────────────┘
```

### ModelProvider interface

```typescript
interface ModelProvider {
  readonly name: string;
  readonly displayName: string;
  chat(opts: ChatCallOptions): Promise<ChatCallResult>;
  supportsModel(model: string): boolean;
  fetchGenerationMeta?(apiKey: string, generationId: string): Promise<GenerationMeta | null>;
  callEmbeddings?(apiKey: string, model: string, inputs: string[]): Promise<number[][]>;
}
```

### Resolution priority

The registry resolves providers in this order (first match wins):

1. **Ollama** — when `_ollamaBaseUrl` is set (explicit local routing)
2. **Anthropic Direct** — when model is `anthropic/*` and `ANTHROPIC_API_KEY` is set
3. **OpenRouter** — universal fallback (handles any model)

### Settings structure

Provider-specific config is scoped under `providers`:

```json
{
  "providers": {
    "openrouter": {
      "siteUrl": "https://myapp.com",
      "siteName": "MyApp",
      "zdr": true,
      "quantizations": ["fp8"]
    },
    "anthropic": {
      "apiKey": "sk-ant-..."
    },
    "ollama": {
      "enabled": true,
      "baseUrl": "http://localhost:11434"
    }
  }
}
```

`mergeSettings()` maps `providers.*` fields into `AgentLoopOptions` at startup, so the loop doesn't need to know about the providers block directly.

## Consequences

### Positive

- **Clean DX**: `orager init` scaffolds only relevant provider config
- **Extensibility**: adding a provider = one file implementing `ModelProvider` + `registerProvider()`
- **Testability**: mock one interface instead of HTTP internals
- **Plugin SDK path**: Sprint 15's plugin SDK becomes "implement `ModelProvider`, call `registerProvider()`"
- **Zero breakage**: flat config fields still work as OpenRouter defaults; the `providers` block is additive

### Negative

- **Two config paths**: until flat fields are deprecated, both `siteUrl` (flat) and `providers.openrouter.siteUrl` work. This is intentional for backward compat but adds surface area.
- **Non-null assertions**: callers of `getOpenRouterProvider().callEmbeddings!(...)` use `!` because `callEmbeddings` is optional on `ModelProvider`. Type-safe but slightly ugly.

### Migration path

| Phase | Status |
|-------|--------|
| 1. ModelProvider interface + registry + resolver | ✅ Done (PR #120) |
| 2. Migrate 7 direct callers to registry | ✅ Done (PR #121) |
| 3. Wire `providers` config in `mergeSettings()` | ✅ Done (PR #121) |
| 4. ADR + docs | ✅ This PR |
| 5. Deprecate flat OpenRouter fields | Future — log warning when flat fields used alongside `providers` block |
| 6. Plugin SDK provider registration | Sprint 15 |

## Alternatives considered

### Full rewrite of `callOpenRouter`

Rejected. The existing SSE parsing, prompt caching, and rate-limit tracking code is battle-tested. The adapter pattern wraps it without changing behavior.

### Generic HTTP adapter (pass URL + headers)

Rejected for now. While flexible, it pushes too much onto the user (constructing auth headers, handling streaming format differences). Provider-specific adapters handle these details.

### Config-file-only provider selection (no runtime resolution)

Rejected. Auto-detection (Anthropic Direct when `ANTHROPIC_API_KEY` is set) is a valuable zero-config optimization. The resolver handles this without user configuration.
