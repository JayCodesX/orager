# ADR-0009: Local-First Inference, Desktop Client Architecture, and Subscription Model

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-04-02 |
| **Deciders** | JayCodesX |

---

## Context

### The current dependency problem

Orager's current inference architecture requires an `OPENROUTER_API_KEY` to function. Every agent run, every tool call, every memory retrieval that involves LLM reasoning routes through OpenRouter. This creates four compounding problems:

1. **Zero-friction onboarding is impossible.** A new user clones the repo, runs `orager chat`, and immediately hits `OPENROUTER_API_KEY not set`. No key, no product.
2. **"Personal AI" is a false promise if all data leaves the machine.** Every prompt, every memory entry fed to the model, every tool result travels to an external API. For privacy-sensitive users this is a non-starter.
3. **OpenRouter is a single point of failure.** An outage, a pricing change, or an account suspension takes every orager user offline simultaneously.
4. **The subscription model has no clear free tier.** Without a genuinely useful free experience, there is no funnel.

### The OMLS infrastructure gap

ADR-0007 (OMLS) designed the training pipeline around external infrastructure: Together AI for model hosting, VPS burst for training compute. This works but is cloud-dependent from day one, pricing the full OMLS learning loop out of reach for users who cannot or will not pay for cloud training.

The key hardware reality:

| Hardware | Can run 7B inference? | Can run 7B QLoRA training? |
|----------|----------------------|--------------------------|
| MacBook Air M1 8 GB | 3B models only | Marginal — slow, hot |
| MacBook Air M1/M2 16 GB | 7B comfortably | Yes — 15–30 min/run |
| MacBook Pro M2/M3 16 GB | 7B–13B | Yes — 15–30 min/run |
| MacBook Pro M3 Max 36 GB | 13B–30B | Yes — fast |
| Windows/Linux RTX 3080 (10 GB) | 7B | Yes — 8–12 min/run |
| Windows/Linux RTX 4090 (24 GB) | 13B–30B | Yes — fast |

Approximately **40–50% of the target developer audience** (MacBook Pro 16 GB+, mid-range GPU) can run local LoRA training. The remainder — particularly the large 8 GB MacBook Air segment — can run inference but not training without degraded experience.

This hardware split maps directly onto a subscription model: local inference is free and accessible to everyone; cloud OMLS training is the paid upgrade for users who want the full learning loop without the hardware requirement.

### The desktop client opportunity

Orager's current UI (`src/ui/`) is a React + Vite dashboard served by `orager serve`. It is functional but browser-based, requires a running server process, and lacks OS integration (tray, notifications, hotkeys, window management). It does not create a subscription conversion moment.

A native desktop client built on **Tauri** addresses this:

- Tauri v2 ships with mobile support (iOS/Android) built in — desktop-first, then mobile is literally Tauri's roadmap
- Tiny binary (~5–10 MB shell) — the existing React + Vite frontend drops in directly
- Orager core runs as a Bun sidecar process managed by the Tauri shell
- The existing JSON-RPC 2.0 subprocess transport (`src/subprocess.ts`) is the communication layer — no new protocol needed
- OS integration: system tray, native notifications, global hotkeys, auto-launch on login

The client is the subscription gate — the point at which a free CLI user converts to a paying customer.

---

## Decision

### 1. Ollama as the default local inference backend

Ollama (`https://ollama.ai`) is adopted as the default LLM backend. It runs open-weight models locally via an OpenAI-compatible REST API at `localhost:11434`, requires no API key, and supports the models most relevant to orager's use case (Llama 3.2, Mistral, Phi-4, DeepSeek-R1, Qwen).

**Inference routing hierarchy:**

```
Incoming task
      ↓
Local Ollama available AND task within local model capability?
      ├─ Yes → Ollama (free, private, offline)
      └─ No
            ↓
      OpenRouter API key present?
            ├─ Yes → OpenRouter (frontier models: Claude, GPT-4o, Gemini)
            └─ No → Fall back to best available local model with capability warning
```

The confidence router (ADR-0007) is extended to treat Ollama and OpenRouter as parallel backends with separate capability profiles. Local models are preferred for tasks scored below the confidence threshold; frontier models are used for complex reasoning, multi-step planning, and tasks where local model accuracy is insufficient.

**Model capability profiles** are maintained in `src/model-capabilities.ts` for local models (context length, coding ability, tool-use reliability, reasoning depth). These inform routing decisions without requiring a live capability check.

**Ollama auto-detection at startup:**

```typescript
// Attempt connection to localhost:11434
// If unreachable: warn user, fall back to OpenRouter if key present
// If reachable but no models pulled: prompt user to run `ollama pull llama3.2`
```

### 2. Local LoRA training via MLX (Apple Silicon) and llama.cpp (cross-platform)

OMLS training (ADR-0007) is extended with a local training path:

- **Apple Silicon (M1+):** MLX framework for QLoRA fine-tuning. 7B models train in 15–30 minutes on 16 GB unified memory. MLX is optimized for Apple's unified memory architecture — the same RAM serves both CPU and GPU, making 7B QLoRA feasible on 16 GB machines.
- **NVIDIA GPU:** llama.cpp with CUDA backend. RTX 3080 (10 GB VRAM) trains 7B QLoRA in 8–12 minutes.
- **CPU-only fallback:** llama.cpp CPU mode — slow (hours) but functional. Presented to users as "overnight training" with honest time estimates.

The OMLS heartbeat scheduler (ADR-0007) detects idle windows and dispatches training to the appropriate local backend. Trained LoRA adapters are stored at `~/.orager/models/<memoryKey>/<baseModel>/adapter.bin` and loaded automatically when the corresponding memory namespace is active.

**Cloud training path (unchanged from ADR-0007)** remains available for users whose hardware cannot train locally or who prefer not to use local compute.

### 3. Desktop client built on Tauri v2

**Architecture:**

```
┌─────────────────────────────────────────┐
│           Tauri Shell (Rust)            │
│  System tray, auto-update, OS APIs,     │
│  window management, license validation  │
└──────────────┬──────────────────────────┘
               │ Tauri IPC (invoke/events)
┌──────────────┴──────────────────────────┐
│       React + Vite Frontend             │
│  Chat UI, memory browser, SkillBank     │
│  dashboard, settings, cost tracker,     │
│  OMLS status, Ollama manager            │
└──────────────┬──────────────────────────┘
               │ JSON-RPC 2.0 over stdio (subprocess.ts)
┌──────────────┴──────────────────────────┐
│       Orager Core (Bun sidecar)         │
│  runAgentLoop, all tools, memory,       │
│  SkillBank, MCP, bun:sqlite (ADR-0008)  │
└─────────────────────────────────────────┘
```

The Tauri shell manages the Bun sidecar lifecycle: starts it on app launch, monitors health, restarts on crash, terminates on app close. The existing `src/subprocess.ts` JSON-RPC transport is the communication layer between frontend and core — no new protocol required.

**Client-exclusive features (subscription-gated):**

- Persistent chat UI with searchable, resumable conversation history
- Memory browser — visualize, edit, tag, and delete memory entries
- System tray agent — orager runs in background, global hotkey to summon
- Multi-session tabs — parallel agents visible in real time
- SkillBank dashboard — approve/reject learned skills, view success rates and use counts
- Cost tracker — spend per session, per model, per day with budget alerts
- OMLS status panel — training progress, adapter performance curves over time
- Ollama manager (Pro/Cloud) — install, pull models, monitor local inference health
- Settings GUI — replaces manual `settings.json` editing and CLI flags
- Cross-device memory sync (Pro/Cloud)
- Trained LoRA adapter sync across devices (Pro/Cloud)

**Platform targets:**

- macOS (arm64 + x86_64) — primary
- Windows (x86_64) — launch alongside macOS
- Linux (x86_64) — community tier, best-effort
- iOS/Android — Tauri v2 mobile, post-desktop

### 4. Subscription tiers and licensing model

**Four tiers:**

| Tier | Delivery | LLM | OMLS Training | Key Required | Price |
|------|----------|-----|---------------|--------------|-------|
| **Free** | CLI only (MIT) | Ollama local | None | None | $0 |
| **Pro** | CLI + Desktop client | Ollama + BYOK OpenRouter | Cloud OMLS + local adapter sync | OpenRouter key (BYOK) | ~$15/month |
| **Orager Cloud** | Desktop client (primary) + CLI | Managed frontier models | Cloud OMLS included | None — managed | ~$25/month |
| **Enterprise** | Client + CLI + self-hosted cloud | Custom | Custom | None | Custom |

**Free tier** is genuinely useful — full agent loop, persistent memory, SkillBank prompt adaptation, MCP, all CLI features, local Ollama inference. Not crippled.

**Pro tier** sells software value on top of the user's own API key. Orager does not absorb API costs on Pro. Revenue is pure margin. Ship Pro first.

**Orager Cloud** absorbs API costs and charges a margin. Requires usage caps, circuit breakers, and cost monitoring infrastructure before launch. Ship after Pro usage patterns are understood.

**Enterprise** activates when 10+ team customers exist. Includes SSO, audit logs, shared team memory namespaces, dedicated infra, SLA.

**License model:**

- Orager core (`@orager/core`) — MIT license, forever
- Desktop client — proprietary license, source-available on request for Enterprise
- License key issued at subscription activation, stored locally as a signed JWT
- Offline grace period: client functions for 14 days without license verification (travel, poor connectivity)
- License validated on startup against `license.oragerai.com` — lightweight endpoint, no usage data sent

**Conversion funnel:**

```
User discovers orager (GitHub, HN, Reddit, word of mouth)
        ↓
Installs CLI (free, open source, zero friction)
        ↓
Hits limitation: no UI, no cross-device sync, no cloud OMLS
        ↓
Downloads desktop client → Pro subscription prompt
        ↓
Enters OpenRouter key (Pro) OR skips it (Orager Cloud)
        ↓
Full experience unlocked
```

The CLI is the acquisition channel. The desktop client is the conversion point. This mirrors Obsidian (free app, paid sync), Raycast (free launcher, paid AI), and Linear (free core, paid collaboration).

### 5. OpenRouter retained as optional cloud backend

OpenRouter is not removed — it remains the recommended path to frontier models (Claude, GPT-4o, Gemini, DeepSeek via API). Users who want frontier model quality on the free CLI tier can still provide their own key.

OpenRouter's role shifts from **required dependency** to **optional upgrade path**:

```
No key + Ollama installed → fully functional, local models
No key + no Ollama        → degraded, prompt to install Ollama
OpenRouter key present    → frontier models unlocked, routing to cloud
Orager Cloud subscription → managed frontier models, no key needed
```

---

## Consequences

### Positive

**Frictionless onboarding.** `npm install -g @orager/core` + `ollama pull llama3.2` = fully functional agent with no accounts, no credit cards, no API keys. This is the story that gets shared on HackerNews.

**"Personal AI" is now literally true.** For free tier users on Ollama, no data leaves the machine. Memory, sessions, skills, tool calls — all local. The privacy pitch is honest.

**Clear subscription value ladder.** Free → Pro → Cloud each adds a distinct, meaningful tier with no artificial crippling of the free tier. Users upgrade because they want more capability, not because the free tier is unusable.

**Resilience.** If OpenRouter has an outage, free-tier users are unaffected. Pro users fall back to local Ollama. Orager Cloud is the only tier fully dependent on external providers.

**Desktop client creates compounding moat.** The client integrates deeply with the user's OS (tray, hotkeys, notifications) and data (`~/.orager/`). Switching cost is high once memory and skills accumulate locally. This is the same moat that makes users stay with Obsidian.

**Mobile path is built in.** Tauri v2's mobile support means the iOS/Android client is not a rewrite — it is a frontend adaptation of the same React codebase running against the same Bun core (remotely, or on-device for capable hardware).

### Negative

**Ollama is an external dependency.** The CLI now has an implicit dependency on the user having Ollama installed. Clear error messaging and onboarding documentation mitigate this but do not eliminate it.

**Local model quality gap.** 7B–8B local models are noticeably less capable than Claude Sonnet or GPT-4o for complex tasks. SkillBank and OMLS close this gap over time but do not eliminate it. Users expecting frontier model quality out of the box on the free tier will be disappointed without expectation setting.

**Two training backends to maintain.** MLX (Apple Silicon) and llama.cpp (cross-platform) have different APIs, different quantization formats, and different update cadences. A thin adapter layer in `src/omls/` abstracts them but adds maintenance surface.

**License enforcement complexity.** JWT-based offline licensing requires key generation infrastructure, rotation policy, and revocation handling. Keepass-style local license files are simpler but more easily pirated. The 14-day grace period balances UX against enforcement.

**Pro API cost risk is zero but Orager Cloud margin risk is real.** A single power user running 50-agent OMLS workflows on Orager Cloud can consume $200+/month of API while paying $25. Usage caps (configurable per account), circuit breakers, and hard monthly limits are required before Cloud launch.

### Neutral

**The `shouldUseDirect` / `callDirect` routing path** in `src/openrouter.ts` is repurposed as the Ollama routing path. The abstraction already exists; it needs Ollama-specific headers and model name translation.

**The confidence router** (ADR-0007) requires capability profiles for local models. These are static initially (hardcoded in `model-capabilities.ts`) and can be made dynamic via periodic benchmark runs later.

---

## Alternatives Considered

### Ollama bundled in binary

Bundle Ollama directly into the orager binary or installer, eliminating the separate install step.

**Rejected:** Ollama is ~200 MB. Bundling it inflates the orager binary unacceptably. The desktop client's Ollama manager (detect, install, manage) provides the smooth onboarding experience without bundling.

### Electron instead of Tauri

Electron ships Chromium (consistent rendering, large ecosystem). Tauri uses the OS WebView (smaller binary, native feel).

**Rejected:** Electron binaries are 150+ MB. Orager positions as a lightweight local runtime — a 150 MB Electron shell contradicts that positioning. Tauri's 5–10 MB shell is consistent with orager's values. WebView rendering differences across OS are manageable with the existing React + Vite stack.

### Fully open source client (MIT)

MIT-license the desktop client alongside the core.

**Rejected:** An MIT client cannot be the subscription gate. The business model requires the client to be proprietary or at minimum source-available with a commercial restriction. The core stays MIT to drive community adoption; the client is the monetization layer.

### Remove OpenRouter entirely

Replace OpenRouter with direct provider integrations (Anthropic API, OpenAI API, etc.).

**Rejected:** OpenRouter provides multi-provider routing, rate limit fallback, and a single billing relationship that simplifies the user's setup. Removing it increases integration surface significantly. It is retained as optional but not required.

---

## Implementation Plan

**Phase 1 — Ollama integration (CLI)**
1. Add Ollama backend to `src/openrouter.ts` (or new `src/ollama.ts`)
2. Auto-detect Ollama at startup, surface clear messaging if absent
3. Update `shouldUseDirect` routing to include Ollama as a first-class path
4. Add local model capability profiles to `model-capabilities.ts`
5. Update `orager run` and `orager chat` to work without `OPENROUTER_API_KEY`

**Phase 2 — Local OMLS training**
1. Add MLX training adapter for Apple Silicon (`src/omls/mlx-trainer.ts`)
2. Add llama.cpp training adapter for cross-platform (`src/omls/llamacpp-trainer.ts`)
3. Update heartbeat scheduler to detect hardware capability and dispatch accordingly
4. Store trained adapters at `~/.orager/models/<memoryKey>/<baseModel>/`
5. Load adapters automatically when the corresponding namespace is active in Ollama

**Phase 3 — Desktop client (Tauri)**
1. Scaffold Tauri v2 project wrapping existing React + Vite UI
2. Implement Bun sidecar lifecycle management in Tauri shell
3. Wire JSON-RPC 2.0 transport between frontend and sidecar
4. Add client-exclusive UI panels (memory browser, SkillBank dashboard, cost tracker, OMLS status)
5. Implement Ollama manager (detect, install prompt, model pull UI)
6. macOS + Windows build pipeline via GitHub Actions

**Phase 4 — Subscription and licensing**
1. License JWT generation and validation service (`license.oragerai.com`)
2. Stripe integration for Pro and Orager Cloud billing
3. Feature flag system in client keyed to license tier
4. 14-day offline grace period with local expiry tracking
5. Usage cap enforcement for Orager Cloud (monthly token budget per account)

**Phase 5 — Orager Cloud**
1. Multi-tenant cloud backend (PostgreSQL + pgvector — separate ADR)
2. Managed OpenRouter key pool with per-account cost tracking
3. Cross-device memory sync (client ↔ cloud)
4. Trained LoRA adapter sync and hosting

Each phase is independently shippable. Phase 1 (Ollama CLI integration) is the highest-priority item — it unblocks frictionless onboarding immediately.

---

## References

- [Ollama documentation](https://ollama.ai/docs)
- [Tauri v2 documentation](https://v2.tauri.app)
- [MLX framework — Apple Silicon training](https://github.com/ml-explore/mlx)
- [llama.cpp QLoRA fine-tuning](https://github.com/ggerganov/llama.cpp)
- [sqlite-vec benchmarks](https://alexgarcia.xyz/blog/2024/sqlite-vec-stable-release/index.html)
- [Obsidian pricing model](https://obsidian.md/pricing)
- ADR-0007: OMLS opportunistic RL training
- ADR-0008: Storage architecture overhaul
