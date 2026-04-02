# ADR-0003: In-process agents with optional subprocess fallback — remove the daemon

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-04-01 |
| **Deciders** | JayCodesX |

---

## Context

### Current approach

orager's daemon is a long-lived HTTP server (`orager serve`) that must be running before any agent task executes. Callers — including Paperclip — POST a prompt to the daemon and receive a streaming SSE response. The daemon owns the agent loop, memory reads/writes, model calls, and tool execution.

This is a **sidecar pattern**: a secondary process running alongside the primary application, providing supporting services over localhost. Sidecar processes are common in microservices (Envoy, Datadog agent) but carry overhead that is unnecessary when the orchestrator and the agent can share a process.

### Where it breaks down

The daemon adds friction at every layer:

- **Availability dependency** — callers must ensure the daemon is running before invoking any agent. A crashed or stale daemon silently breaks all agent work until manually restarted.
- **Process overhead** — an always-on HTTP server consuming memory and file descriptors for a tool that may be invoked infrequently.
- **Deployment complexity** — Paperclip and other embedders must manage daemon lifecycle (start, health-check, restart) as part of their own process management.
- **No in-process path** — even when the caller and agent run on the same machine, all communication goes over a TCP loopback socket, adding latency and a serialization round-trip for every token.
- **`orager serve` conflation** — the daemon mixes agent execution with UI/log-viewer concerns, making it hard to run the web UI without also running the agent server.

### Decision drivers

- Must remain embeddable — no external services, works offline, survives `bun build --compile`
- Must be non-fatal — memory and tooling failures must never abort an agent run
- Must preserve all existing capabilities: memory system, tool execution, cost tracking, streaming, multi-agent orchestration
- Must keep the HTTP server available for the UI/log-viewer as an opt-in command
- Subprocess fallback must be compatible with the MCP protocol so orager agents can be surfaced as MCP tool servers to other hosts (including Claude Code)

---

## Decision

Remove the always-on daemon. Make in-process execution the default. Provide a subprocess fallback for callers that cannot block, and an opt-in `orager serve` command for the web UI.

### Solution

#### 1. In-process execution (default)

The agent loop runs directly in the calling process. `orager run` and `orager chat` are CLI entry points that invoke the loop in-process and stream output to stdout.

```
orager run "build the login page"   # runs agent in-process, streams to stdout
orager chat                          # interactive REPL, in-process
```

All existing capabilities (memory, tools, cost tracking, multi-agent orchestration, Phase 8 multi-context) are available in-process with no network hop.

#### 2. Subprocess fallback (opt-in, caller-configured)

For callers that embed orager as a library but cannot block their main process (e.g. Paperclip with a UI thread or timeout budget), orager can be configured to spawn a short-lived child process for each agent run.

**Transport: JSON-RPC 2.0 over stdio**

This is the same protocol Claude Code uses for MCP server communication. The subprocess:
- Reads JSON-RPC 2.0 requests from stdin
- Writes JSON-RPC 2.0 responses and streaming notifications to stdout
- Writes diagnostic logs to stderr (never interferes with the protocol channel)
- Is terminated by the orchestrator when the run completes or times out (`SIGTERM` → `SIGKILL`)

```
Orchestrator process
  │  stdin  → JSON-RPC request  (agent/run, agent/cancel)
  │  stdout ← JSON-RPC notifications (token, tool_call, tool_result, done, error)
  └  stderr ← diagnostic logs (captured by orchestrator, logged via orager logger)
```

**Why JSON-RPC 2.0 over stdio:**
- Same protocol Claude Code uses for MCP tool servers — battle-tested error handling, request/response correlation via `id`, notification support for streaming tokens
- A subprocess orager agent is structurally identical to an MCP server; the same binary can expose agent capabilities to any MCP-compatible host without additional work
- Stdout is strictly protocol; stderr is strictly logs — no ambiguity in parsing
- Cancellation is `SIGTERM` on the child process — no protocol-level cancel message needed for the common case

**Trigger criteria** — configurable by the caller via `AgentLoopOptions`:

```ts
subprocess?: {
  enabled: boolean;           // default: false
  timeoutMs?: number;         // SIGTERM after N ms; default: no timeout
  binaryPath?: string;        // path to orager binary; default: process.execPath
}
```

#### 3. Shared SQLite memory (WAL mode)

When the subprocess fallback is active, both the orchestrator and the subprocess share the same SQLite database in WAL mode. WAL allows concurrent readers and a single writer without blocking, so:
- The orchestrator can read memory entries written by the subprocess in near-real-time
- The subprocess can read memory entries written by the orchestrator (e.g. master context set before the run)
- No additional IPC channel is needed for memory synchronisation

This is already how the memory system works today across multiple agent runs — no schema changes required.

#### 4. `orager serve` — opt-in HTTP server

The web UI (log viewer, cost dashboard, session explorer) is preserved as an opt-in command:

```
orager serve [--port 3000]   # starts HTTP + SSE server for UI only
```

`orager serve` does **not** execute agents. It provides:
- `GET /logs` — log file streaming (daily rotation, filters)
- `GET /costs` — cost aggregation from SQLite
- `GET /sessions` — session history browser
- `GET /memory` — memory namespace browser

Agent execution is never routed through `orager serve`. This separates the UI concern from the execution concern cleanly.

#### 5. AgentConfig and AgentWorkflow — typed multi-agent composition

`AgentLoopOptions` is the complete configuration surface for a single agent run. For multi-agent workflows, constructing a full `AgentLoopOptions` per agent is verbose and repetitive. Two new types formalise the composition pattern:

```ts
/**
 * Per-agent configuration slice. Overrides the shared base config for a single
 * agent step in a workflow. Only the fields that differ between agents need to
 * be specified — everything else inherits from AgentWorkflow.base.
 */
interface AgentConfig {
  /** Human-readable name for this agent step (used in logs and cost tracking). */
  role: string;
  /** Model to use for this step. Overrides AgentWorkflow.base.model. */
  model: string;
  /** Appended to the shared system prompt. Defines this agent's specific role and output format. */
  appendSystemPrompt?: string;
  /** Sampling temperature for this step. */
  temperature?: number;
  /**
   * Memory namespace(s) this agent reads from and writes to.
   * Overrides AgentWorkflow.base.memoryKey for this step.
   * Array form: index 0 = write target, all = read sources (Phase 8 multi-context).
   */
  memoryKey?: string | string[];
  /** Maximum turns for this step. Overrides AgentWorkflow.base.maxTurns. */
  maxTurns?: number;
  /** Hard cost ceiling for this step in USD. */
  maxCostUsd?: number;
}

/**
 * A named, sequential multi-agent workflow. The orchestrator runs each step
 * in order, passing the previous step's output as the next step's prompt
 * unless a custom handoff function is provided.
 */
interface AgentWorkflow {
  /** Shared base config applied to every step unless overridden by AgentConfig. */
  base: Omit<AgentLoopOptions, "prompt" | "model">;
  /** Ordered list of agent steps. */
  steps: AgentConfig[];
  /**
   * Optional handoff: given the output of step N, produce the prompt for step N+1.
   * Default: pass the full output text of the previous step as the next prompt.
   */
  handoff?: (stepIndex: number, output: string) => string;
}
```

**Usage — research workflow example:**

```ts
const workflow: AgentWorkflow = {
  base: {
    apiKey: process.env.OPENROUTER_API_KEY,
    memoryKey: "product-research",
    maxCostUsd: 5.00,
    onEmit: streamToStdout,
    cwd: process.cwd(),
    addDirs: [],
    dangerouslySkipPermissions: false,
    verbose: false,
  },
  steps: [
    {
      role: "researcher",
      model: "deepseek/deepseek-r1",
      appendSystemPrompt: "Research thoroughly. Output a structured findings report.",
      temperature: 0.7,
      maxCostUsd: 2.00,
    },
    {
      role: "synthesizer",
      model: "anthropic/claude-sonnet-4-6",
      appendSystemPrompt: "Synthesize the research into a concise recommendation.",
      temperature: 0.3,
      maxCostUsd: 1.00,
    },
  ],
};

await runAgentWorkflow(workflow, initialPrompt);
```

**Implementation:** `runAgentWorkflow` merges `base` with each `AgentConfig` step into a full `AgentLoopOptions`, captures the step's output via `onEmit`, runs `runAgentLoop`, then calls `handoff` (or default pass-through) to produce the next prompt. No new runtime infrastructure — thin orchestration layer over the existing `runAgentLoop`.

**Why not a class hierarchy:** `AgentLoopOptions` is already a config object, not a class. Composition via plain object merge keeps the pattern consistent, avoids inheritance coupling, and is trivially testable (each step's merged config is a plain value).

#### 6. Paperclip migration

Paperclip currently posts prompts to the daemon. Migration path:
1. Replace daemon HTTP calls with direct in-process `runAgentLoop(options)` calls
2. If Paperclip's architecture requires non-blocking execution, enable the subprocess fallback via `subprocess: { enabled: true }`
3. Remove daemon lifecycle management (health-check polling, restart logic) from Paperclip

#### 6. Prompt prefix stability (replaces keep-alive cache warming)

The daemon's keep-alive pattern existed partly to keep the system prompt warm in the provider cache. With in-process execution, cache warming is replaced by **stable prompt prefix** construction:

- The frozen section of the system prompt (base instructions, CLAUDE.md, retrieved memory) is assembled once per run and is structurally identical across runs for the same project
- Anthropic's prompt cache keys on content, not connection — the frozen section is cached after the first run of the day and hits on all subsequent runs in the same billing period
- No warm-up request is needed; the first real user turn populates the cache

---

## Alternatives Considered

### 1. Keep the daemon, fix the availability problem with auto-start

Auto-start the daemon lazily on first use and restart it on crash via a supervisor.

**Rejected because:** This adds a supervisor dependency and does not eliminate the TCP round-trip on every token. The root cause is that a separate process is unnecessary when in-process execution is available. Auto-start is a workaround for a structural problem.

### 2. Keep JSON-RPC but use a Unix domain socket instead of stdio

A Unix domain socket allows bidirectional streaming and multiple concurrent connections over a local socket file.

**Rejected for the common case because:** stdio is sufficient for the one-orchestrator-one-subprocess model and requires no socket lifecycle management (bind, listen, accept, cleanup on crash). The upgrade path to a domain socket is open if mid-run configuration injection (dynamic tool registration, cancellation with partial result) becomes a requirement.

### 3. Subprocess communicates via shared SQLite only (polling)

The subprocess writes tokens/results to a `agent_output` table; the orchestrator polls.

**Rejected because:** Polling latency (~50–100ms) is perceptible for streaming output. JSON-RPC notifications over stdout are zero-latency. SQLite polling is the right pattern for durability (surviving orchestrator restarts), not for streaming.

### 4. Expose agent execution over `orager serve` (keep daemon, make it opt-in)

Move agent execution endpoints behind `orager serve --agents` rather than removing them.

**Rejected because:** The in-process path is strictly better for single-machine deployments. Keeping agent execution in the HTTP server preserves the TCP round-trip and process isolation overhead for no benefit when the caller is on the same machine. Remote-execution use cases can be addressed later with a dedicated design.

---

## Consequences

**Positive**
- No daemon to start, health-check, or restart — `orager run` works immediately in any environment
- In-process execution eliminates the TCP loopback hop and SSE serialisation overhead on every token
- Subprocess fallback implements MCP protocol — orager agents are natively surfaceable to Claude Code and other MCP hosts without additional code
- `orager serve` is a clean, single-purpose command: UI and observability only
- Paperclip loses daemon lifecycle management code; gains a simpler direct-call integration

**Negative / Trade-offs**
- Callers that relied on the daemon for process isolation (crashing agent does not crash caller) must opt-in to the subprocess fallback explicitly
- The subprocess fallback adds a binary distribution concern: `binaryPath` must point to a valid orager binary; misconfiguration silently falls back to in-process (with a logged warning)
- JSON-RPC 2.0 is more structured than plain NDJSON — implementing the subprocess server requires adhering to the spec (id correlation, error objects), though the surface area is small (two methods: `agent/run`, `agent/cancel`)

**Neutral**
- The HTTP server (`orager serve`) and all existing UI features are fully preserved
- The memory system, tool execution, cost tracking, and multi-agent orchestration are unchanged — this ADR is purely about the execution transport layer
- The frozen prompt prefix + Anthropic cache covers the keep-alive use case without a persistent connection
