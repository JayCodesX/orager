# Sprint Plan: orager UI Server

## Overview

A standalone HTTP server (`orager ui`) that provides a browser-based interface for configuring orager, monitoring the daemon, searching logs, and visualizing telemetry. It is entirely optional — the CLI wizard (`orager setup`) and daemon (`orager --serve`) continue to work without it.

### Guiding Principles

- **Separate process** from the daemon. Starting `orager ui` does not start the daemon, and vice versa.
- **Optional by design.** Nothing breaks if the UI server is not running.
- **TypeScript + React** — consistent with the existing stack. Vite handles the frontend build.
- **No secrets in the browser.** API keys are never returned by any UI server endpoint.
- **Four tabs**: Configuration · Dashboard · Logs · Telemetry

---

## Architecture

```
orager ui [--port 3457]
    │
    ├── src/ui-server.ts          Node HTTP server (no new framework deps — uses built-in `node:http`)
    │       ├── /api/config       Read & write ~/.orager/config.json
    │       ├── /api/settings     Read & write ~/.orager/settings.json
    │       ├── /api/daemon/*     Proxy to daemon (strips API keys from responses)
    │       ├── /api/logs         Stream / paginate the NDJSON log file
    │       ├── /api/telemetry    Return in-process captured spans
    │       └── /*                Serve static dist/ui/ (Vite build output)
    │
    └── ui/                       React app (Vite + React 18 + TypeScript)
            ├── src/
            │   ├── App.tsx                Tab shell (react-router-dom)
            │   ├── tabs/
            │   │   ├── Configuration.tsx  Sprint 1
            │   │   ├── Dashboard.tsx      Sprint 2
            │   │   ├── Logs.tsx           Sprint 3
            │   │   └── Telemetry.tsx      Sprint 3
            │   └── api.ts                Typed fetch helpers
            └── vite.config.ts
```

**New CLI command:** `orager ui [--port <n>]` (default port **3457** to avoid daemon collision)

**Port discovery:** writes `~/.orager/ui.port` on start so tooling can find it.

**No auth required** — binds to `127.0.0.1` only. If the user needs remote access they should tunnel.

---

## Sprint 1 — Configuration Tab

**Goal:** A browser form that reads and writes `~/.orager/config.json` and `~/.orager/settings.json`. The CLI wizard (`orager setup`) is untouched.

### Backend tasks

| # | Task | File(s) |
|---|------|---------|
| 1.1 | Add `orager ui` command to `src/index.ts` — parses `--port`, calls `startUiServer()` | `src/index.ts` |
| 1.2 | Create `src/ui-server.ts` — `node:http` server, static file handler for `dist/ui/`, JSON body parser helper | `src/ui-server.ts` |
| 1.3 | `GET /api/config` — load `~/.orager/config.json`, return JSON. Strip `agentApiKey` from response. | `src/ui-server.ts` |
| 1.4 | `POST /api/config` — validate against `OragerUserConfig` type, merge with existing config, write atomically (temp file + rename), return saved config | `src/ui-server.ts` |
| 1.5 | `GET /api/settings` — load `~/.orager/settings.json` | `src/ui-server.ts` |
| 1.6 | `POST /api/settings` — validate and write `~/.orager/settings.json` | `src/ui-server.ts` |
| 1.7 | `GET /api/config/defaults` — return `DEFAULT_CONFIG` from `src/setup.ts` (imported, not duplicated) | `src/ui-server.ts` |
| 1.8 | Write `~/.orager/ui.port` on server start; delete on clean exit | `src/ui-server.ts` |

### Frontend tasks

| # | Task | File(s) |
|---|------|---------|
| 1.9 | Scaffold `ui/` with Vite + React 18 + TypeScript. Add `vite.config.ts` with `outDir: ../dist/ui`. Add `npm run build:ui` script to `package.json` | `ui/`, `package.json` |
| 1.10 | `App.tsx` — top-level tab bar (Configuration · Dashboard · Logs · Telemetry) using `react-router-dom`. Remaining tabs render placeholder `<div>Coming soon</div>` | `ui/src/App.tsx` |
| 1.11 | `api.ts` — typed `apiFetch` wrapper; all UI server calls go through it | `ui/src/api.ts` |
| 1.12 | `Configuration.tsx` — two sub-sections: **Config** and **Settings**. Loads current values on mount. | `ui/src/tabs/Configuration.tsx` |
| 1.13 | Config section: grouped form fields matching `OragerUserConfig` (Models, Agent Loop, Cost Limits, Sampling, Reasoning, Provider Routing, Memory, Daemon, Misc). Each group is a collapsible card. | `ui/src/tabs/Configuration.tsx` |
| 1.14 | Settings section: permissions table (tool → allow/deny/ask), bash policy fields, hooks editor (textarea per event), hooksEnabled toggle | `ui/src/tabs/Configuration.tsx` |
| 1.15 | Save/Reset buttons. Save calls `POST /api/config` and `POST /api/settings`. Reset calls `GET /api/config/defaults` then repopulates form without saving. | `ui/src/tabs/Configuration.tsx` |
| 1.16 | Inline validation (required fields, numeric ranges, duration string format). Display field-level errors before submitting. | `ui/src/tabs/Configuration.tsx` |
| 1.17 | Toast notification on save success / error | `ui/src/components/Toast.tsx` |

### Dependencies to add

```jsonc
// package.json devDependencies (frontend build only)
"vite": "^5",
"@vitejs/plugin-react": "^4",
"react": "^18",
"react-dom": "^18",
"react-router-dom": "^6",
"@types/react": "^18",
"@types/react-dom": "^18"
```

No new **runtime** Node dependencies. `src/ui-server.ts` uses `node:http`, `node:fs`, `node:path` only.

### Definition of Done

- `orager ui` starts without error
- Visiting `http://localhost:3457` shows the app with four tab headers
- Configuration tab loads existing `~/.orager/config.json` values into the form
- Editing fields and clicking Save rewrites the file; reloading the page reflects the new values
- CLI wizard (`orager setup`) still works and reads/writes the same file
- `npm run build` (tsc) + `npm run build:ui` (vite) both pass with no errors

---

## Sprint 2 — Dashboard Tab

**Goal:** Live daemon status panel showing health and metrics. No API keys visible anywhere.

### Backend tasks

| # | Task | File(s) |
|---|------|---------|
| 2.1 | `GET /api/daemon/status` — read `~/.orager/daemon.port`; if absent return `{ running: false }`. If present, proxy `/health` to daemon with 2 s timeout. Return `{ running: true, port, health }` or `{ running: false }` on failure. | `src/ui-server.ts` |
| 2.2 | `GET /api/daemon/metrics` — proxy daemon `/metrics` (JWT not needed here since UI server calls daemon internally using the daemon key from `~/.orager/daemon.key`). Before returning to browser, strip any field whose key contains "key", "token", or "secret" (case-insensitive). | `src/ui-server.ts` |
| 2.3 | `GET /api/daemon/sessions` — proxy daemon `/sessions` (same internal JWT strategy, same key-stripping). Pass through `limit` / `offset` query params. | `src/ui-server.ts` |
| 2.4 | Helper: `buildInternalJwt()` — signs a short-lived (30 s) JWT using `~/.orager/daemon.key` for internal daemon calls. Reuse `src/jwt.ts`. | `src/ui-server.ts` |

### Frontend tasks

| # | Task | File(s) |
|---|------|---------|
| 2.5 | `Dashboard.tsx` — polling loop (every 5 s) calling `/api/daemon/status` and `/api/daemon/metrics`. Display "Daemon offline" banner when not running. | `ui/src/tabs/Dashboard.tsx` |
| 2.6 | Status card: running/offline badge, port, uptime, PID (from `~/.orager/daemon.pid` via status endpoint) | `ui/src/tabs/Dashboard.tsx` |
| 2.7 | Metrics cards: activeRuns / maxConcurrent, completedRuns, errorRuns, uptime, current model, provider health indicators | `ui/src/tabs/Dashboard.tsx` |
| 2.8 | Rate-limit card: current RPM, limit, time-until-reset | `ui/src/tabs/Dashboard.tsx` |
| 2.9 | Circuit-breaker table: one row per provider — state (closed/open/half-open), failure count, last failure time | `ui/src/tabs/Dashboard.tsx` |
| 2.10 | Sessions panel: paginated table (sessionId, model, turnCount, cumulativeCostUsd, source, updatedAt). 20 rows per page. No message content shown. | `ui/src/tabs/Dashboard.tsx` |
| 2.11 | Auto-refresh toggle (on by default). Manual refresh button. Last-refreshed timestamp. | `ui/src/tabs/Dashboard.tsx` |

### Dependencies to add

None. Recharts will be added in Sprint 3 and can back-fill the cost sparkline if desired.

### Definition of Done

- Dashboard shows "Daemon offline" when daemon is not running
- Dashboard shows live metrics cards when daemon is running
- No API key values appear anywhere in the browser tab, network response, or browser devtools
- Sessions panel paginates correctly
- Polling stops when the tab is hidden (use `visibilitychange` event) and resumes on focus

---

## Sprint 3 — Logs Tab + Telemetry Tab

### Logs Tab

**Chosen log-parsing library:** [`split2`](https://github.com/mcollina/split2) (3 KB, zero dependencies, streams a readable by newline, used by pino). Each line is passed through `JSON.parse`. This is the only new runtime dependency added for logging.

**Goal:** Search and browse the NDJSON log file (`ORAGER_LOG_FILE`) in the browser.

#### Backend tasks

| # | Task | File(s) |
|---|------|---------|
| 3.1 | `GET /api/logs?q=&level=&limit=200&offset=0&from=&to=` — open log file as a read stream, pipe through `split2`, parse each line as JSON, filter by `q` (substring match on `event` + serialized line), `level`, and time range. Return `{ entries: LogEvent[], total: number, truncated: boolean }`. Max 500 entries per request. If `ORAGER_LOG_FILE` is not set, return `{ entries: [], configured: false }`. | `src/ui-server.ts` |
| 3.2 | `GET /api/logs/stream` — SSE endpoint (`text/event-stream`) that tails the log file in real time using `fs.watchFile`. Each new line is parsed and pushed as an SSE `data:` frame. Client disconnects close the watcher. | `src/ui-server.ts` |

#### Frontend tasks

| # | Task | File(s) |
|---|------|---------|
| 3.3 | `Logs.tsx` — search bar (debounced 300 ms), level filter dropdown (all/info/warn/error/debug), date-range pickers, Live toggle | `ui/src/tabs/Logs.tsx` |
| 3.4 | Log table: timestamp, level badge (color-coded), event name, sessionId, model, expandable JSON detail row | `ui/src/tabs/Logs.tsx` |
| 3.5 | Live mode: opens SSE connection to `/api/logs/stream`, prepends new entries to table. Pause button buffers without disconnecting. | `ui/src/tabs/Logs.tsx` |
| 3.6 | "Not configured" empty state with instructions to set `ORAGER_LOG_FILE` | `ui/src/tabs/Logs.tsx` |
| 3.7 | Virtualized list (use `@tanstack/react-virtual`) for large log files — keeps DOM node count constant regardless of result size | `ui/src/tabs/Logs.tsx` |

---

### Telemetry Tab

**Goal:** Visualize OpenTelemetry spans captured in-process — no external collector required.

**Approach:** Add an in-process `InMemorySpanExporter`-style ring buffer (capped at 2000 spans) to `src/telemetry.ts`. The UI server reads from that buffer. If `OTEL_EXPORTER_OTLP_ENDPOINT` is also set, spans are exported to both the external collector and the ring buffer.

**Chosen chart library:** [`recharts`](https://recharts.org) — lightweight React-native SVG charts, no canvas dependency, tree-shakeable.

#### Backend tasks

| # | Task | File(s) |
|---|------|---------|
| 3.8 | Add `SpanBuffer` class to `src/telemetry.ts`: circular buffer (max 2000), stores `{ traceId, spanId, parentSpanId, name, startTime, endTime, durationMs, attributes, status }`. Register as a second `SpanExporter` alongside the OTLP exporter (or as the only exporter if OTLP not configured). | `src/telemetry.ts` |
| 3.9 | Export `getSpanBuffer()` from `src/telemetry.ts` so `src/ui-server.ts` can read it without circular imports. | `src/telemetry.ts` |
| 3.10 | `GET /api/telemetry/spans?traceId=&name=&limit=200&offset=0` — return spans from buffer, filtered optionally by `traceId` or `name` substring. Return `{ spans, total, bufferSize, bufferMax }`. If telemetry not initialised, return `{ spans: [], configured: false }`. | `src/ui-server.ts` |
| 3.11 | `GET /api/telemetry/traces` — group spans by `traceId`, return trace summaries: `{ traceId, rootSpanName, startTime, totalDurationMs, spanCount, errorCount }`. Sorted by `startTime` descending. | `src/ui-server.ts` |

#### Frontend tasks

| # | Task | File(s) |
|---|------|---------|
| 3.12 | `Telemetry.tsx` — top summary bar: total traces, total spans, p50/p95 duration, error rate | `ui/src/tabs/Telemetry.tsx` |
| 3.13 | Span-duration histogram: `BarChart` from recharts, x-axis = duration buckets (0–50 ms, 50–200 ms, …), y-axis = count | `ui/src/tabs/Telemetry.tsx` |
| 3.14 | Trace timeline: `AreaChart` (spans-per-minute over last 30 min, sampled from buffer timestamps) | `ui/src/tabs/Telemetry.tsx` |
| 3.15 | Trace list table: traceId (truncated), root span name, start time, total duration, span count, error badge. Clicking a row opens a detail drawer. | `ui/src/tabs/Telemetry.tsx` |
| 3.16 | Trace detail drawer: waterfall view of spans for the selected trace (offset bar per span, colored by status), span attributes as a key-value table | `ui/src/tabs/Telemetry.tsx` |
| 3.17 | "Not configured" empty state with instructions to set `OTEL_EXPORTER_OTLP_ENDPOINT` or note that spans are collected automatically when `orager ui` is running | `ui/src/tabs/Telemetry.tsx` |

#### Dependencies to add (Sprint 3)

```jsonc
// package.json — runtime (Node)
"split2": "^4"     // NDJSON log line parser — ~3 KB, zero deps

// package.json — devDependencies (frontend)
"recharts": "^2",
"@tanstack/react-virtual": "^3"
```

### Definition of Done (Sprint 3)

- Logs tab shows "not configured" state when `ORAGER_LOG_FILE` is unset
- When configured, logs load, filter by level and query, and paginate
- Live mode streams new log lines in real time
- Telemetry tab shows span buffer stats and charts when `orager ui` is running alongside the daemon or CLI
- Waterfall trace detail view renders correctly for a real orager agent run
- All four tabs are functional; no tab shows any API key values

---

## New npm Scripts (cumulative)

```jsonc
"scripts": {
  // existing
  "build": "tsc",
  "dev": "tsx src/index.ts",
  "test": "vitest",

  // new
  "build:ui": "vite build --config ui/vite.config.ts",
  "dev:ui": "vite --config ui/vite.config.ts",
  "build:all": "npm run build && npm run build:ui"
}
```

---

## File Map (all new or modified files)

```
orager/
├── src/
│   ├── index.ts              modified — add `orager ui` command routing
│   ├── ui-server.ts          new      — UI HTTP server + all /api/* routes
│   └── telemetry.ts          modified — add SpanBuffer, getSpanBuffer()
├── ui/
│   ├── vite.config.ts        new
│   ├── index.html            new
│   └── src/
│       ├── main.tsx          new
│       ├── App.tsx           new
│       ├── api.ts            new
│       ├── components/
│       │   └── Toast.tsx     new (Sprint 1)
│       └── tabs/
│           ├── Configuration.tsx   new (Sprint 1)
│           ├── Dashboard.tsx       new (Sprint 2)
│           ├── Logs.tsx            new (Sprint 3)
│           └── Telemetry.tsx       new (Sprint 3)
├── docs/
│   └── sprint-plan-ui-server.md   this file
└── package.json              modified — new scripts + deps
```

---

## Risk & Notes

| Item | Note |
|------|------|
| `SpanBuffer` in `telemetry.ts` | OTel SDK span exporters are async. The buffer must implement `export(spans, resultCallback)`. Use `@opentelemetry/sdk-trace-base`'s `SpanExporter` interface — already a transitive dep. |
| Vite dev proxy | During development (`npm run dev:ui`), add a proxy in `vite.config.ts` that forwards `/api/*` to `http://localhost:3457` so the dev server and UI server can run side-by-side without CORS issues. |
| Atomic config writes | Use `fs.rename` after writing to a temp file (same directory) to avoid a partial-write corrupting the config. Pattern already used in `src/session.ts`. |
| `split2` and ESM | Orager builds to CJS via `tsc`. `split2` v4 ships dual CJS/ESM — use the CJS entry. |
| `~/.orager/ui.port` cleanup | Register `process.on('exit')` and `process.on('SIGINT')` handlers to delete the port file, matching the pattern in `src/daemon.ts`. |
