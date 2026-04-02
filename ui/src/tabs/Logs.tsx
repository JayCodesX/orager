import React, { useCallback, useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { authHeaders } from "../api";
import { type DateRangePreset, presetToFromIso, DATE_RANGE_OPTIONS } from "../dateRange";

// ── Types ─────────────────────────────────────────────────────────────────────

interface LogEntry {
  ts?: string;
  level?: string;
  event?: string;
  sessionId?: string;
  agentId?: string;
  model?: string;
  [key: string]: unknown;
}

interface LogsResponse {
  entries: LogEntry[];
  total: number;
  truncated?: boolean;
  configured: boolean;
}

const PAGE_SIZE = 100;

// ── Helpers ───────────────────────────────────────────────────────────────────

const LEVEL_COLORS: Record<string, string> = {
  info:  "var(--accent)",
  warn:  "var(--warn)",
  error: "var(--error)",
  debug: "var(--text-muted)",
};

function LevelBadge({ level }: { level?: string }) {
  const color = LEVEL_COLORS[level ?? ""] ?? "var(--text-muted)";
  return (
    <span style={{
      color,
      border: `1px solid ${color}`,
      borderRadius: 3,
      padding: "1px 5px",
      fontSize: 11,
      fontWeight: 600,
      display: "inline-block",
      minWidth: 40,
      textAlign: "center",
      background: `${color}18`,
    }}>
      {level ?? "?"}
    </span>
  );
}

// ── Log row ───────────────────────────────────────────────────────────────────

function LogRow({ entry, expanded, onToggle }: {
  entry: LogEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      style={{
        borderBottom: "1px solid var(--border)",
        cursor: "pointer",
        background: expanded ? "var(--accent-subtle)" : undefined,
      }}
      onClick={onToggle}
    >
      {/* Summary row */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 12px" }}>
        <span style={{ fontSize: 11, color: "var(--text-muted)", minWidth: 140, flexShrink: 0 }}>
          {entry.ts
            ? new Date(entry.ts).toLocaleTimeString([], {
                hour12: false,
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                fractionalSecondDigits: 3,
              })
            : "—"}
        </span>
        <LevelBadge level={entry.level} />
        <span style={{ fontSize: 13, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {entry.event ?? "(no event)"}
        </span>
        {entry.sessionId && (
          <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "monospace", flexShrink: 0 }}>
            {String(entry.sessionId).slice(0, 12)}
          </span>
        )}
        {entry.model && (
          <span style={{ fontSize: 11, color: "var(--text-muted)", flexShrink: 0 }}>
            {entry.model}
          </span>
        )}
        <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{expanded ? "▲" : "▼"}</span>
      </div>

      {/* Expanded detail — full entry JSON so nothing is hidden */}
      {expanded && (
        <pre style={{
          margin: "0 12px 10px",
          fontSize: 11,
          color: "var(--text-muted)",
          background: "var(--bg-input)",
          borderRadius: 4,
          padding: "8px 10px",
          overflowX: "auto",
          lineHeight: 1.6,
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
        }}>
          {JSON.stringify(entry, null, 2)}
        </pre>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Logs() {
  const [entries, setEntries]     = useState<LogEntry[]>([]);
  const [total, setTotal]         = useState(0);
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading]     = useState(false);
  const [query, setQuery]         = useState("");
  const [level, setLevel]         = useState("");
  const [eventFilter, setEventFilter] = useState("");
  const [dateRange, setDateRange] = useState<DateRangePreset>("24h");
  const [page, setPage]           = useState(0);
  const [liveMode, setLiveMode]   = useState(false);
  const [paused, setPaused]       = useState(false);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  const debounceRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const eventSrcRef   = useRef<EventSource | null>(null);
  const liveBufferRef = useRef<LogEntry[]>([]);
  const parentRef     = useRef<HTMLDivElement>(null);

  // ── Fetch (non-live) ──────────────────────────────────────────────────────
  const fetchLogs = useCallback(async (
    q: string,
    lvl: string,
    evt: string,
    range: DateRangePreset,
    targetPage: number,
  ) => {
    setLoading(true);
    setExpandedIdx(null);
    try {
      const params = new URLSearchParams({
        limit:  String(PAGE_SIZE),
        offset: String(targetPage * PAGE_SIZE),
      });
      if (q)   params.set("q",     q);
      if (lvl) params.set("level", lvl);
      if (evt) params.set("event", evt);
      const fromIso = presetToFromIso(range);
      if (fromIso) params.set("from", fromIso);
      const r = await fetch(`/api/logs?${params}`, { headers: authHeaders() });
      const data = await r.json() as LogsResponse;
      setConfigured(data.configured);
      setEntries(data.entries ?? []);
      setTotal(data.total ?? 0);
      setPage(targetPage);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchLogs(query, level, eventFilter, dateRange, 0);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounce free-text search
  const handleQueryChange = (v: string) => {
    setQuery(v);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void fetchLogs(v, level, eventFilter, dateRange, 0), 300);
  };

  const handleLevelChange = (v: string) => {
    setLevel(v);
    void fetchLogs(query, v, eventFilter, dateRange, 0);
  };

  const handleEventFilterChange = (v: string) => {
    setEventFilter(v);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void fetchLogs(query, level, v, dateRange, 0), 300);
  };

  const handleDateRangeChange = (v: DateRangePreset) => {
    setDateRange(v);
    void fetchLogs(query, level, eventFilter, v, 0);
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // ── Live mode ─────────────────────────────────────────────────────────────
  const startLive = useCallback(() => {
    if (eventSrcRef.current) eventSrcRef.current.close();
    const es = new EventSource("/api/logs/stream");
    eventSrcRef.current = es;
    es.onmessage = (e) => {
      try {
        const entry = JSON.parse(e.data as string) as LogEntry;
        if (paused) {
          liveBufferRef.current.push(entry);
        } else {
          setEntries((prev) => [entry, ...prev.slice(0, 499)]);
          setTotal((t) => t + 1);
        }
      } catch { /* ignore */ }
    };
  }, [paused]);

  const stopLive = useCallback(() => {
    if (eventSrcRef.current) { eventSrcRef.current.close(); eventSrcRef.current = null; }
  }, []);

  useEffect(() => {
    if (liveMode) { startLive(); } else { stopLive(); }
    return stopLive;
  }, [liveMode, startLive, stopLive]);

  const handleResume = () => {
    setPaused(false);
    const buffered = liveBufferRef.current.splice(0);
    if (buffered.length > 0) {
      setEntries((prev) => [...buffered.reverse(), ...prev.slice(0, 500 - buffered.length)]);
    }
  };

  // ── Virtual list with dynamic height measurement ───────────────────────────
  const rowVirtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 42,
    measureElement: (el) => el.getBoundingClientRect().height,
    overscan: 10,
  });

  // ── Render ────────────────────────────────────────────────────────────────
  if (!configured) {
    return (
      <div className="placeholder">
        <h2>No logs yet</h2>
        <p>
          Logs are written to{" "}
          <code style={{ background: "var(--bg-input)", padding: "2px 6px", borderRadius: 4 }}>
            ~/.orager/orager.log
          </code>{" "}
          automatically. Run an agent to generate log entries.
        </p>
        <p style={{ marginTop: 8, fontSize: 12 }}>
          Override with:{" "}
          <code style={{ background: "var(--bg-input)", padding: "2px 6px", borderRadius: 4 }}>
            ORAGER_LOG_FILE=/path/to/file orager ui
          </code>
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 120px)", gap: 12 }}>
      {/* Controls row 1: search + level + date */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", flexShrink: 0 }}>
        <input
          type="text"
          placeholder="Search all fields…"
          value={query}
          onChange={(e) => handleQueryChange(e.target.value)}
          style={{ flex: 2, minWidth: 160 }}
        />
        <input
          type="text"
          placeholder="Filter by event name…"
          value={eventFilter}
          onChange={(e) => handleEventFilterChange(e.target.value)}
          style={{ flex: 1, minWidth: 160 }}
        />
        <select value={level} onChange={(e) => handleLevelChange(e.target.value)} style={{ width: 110 }}>
          <option value="">All levels</option>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
          <option value="debug">debug</option>
        </select>
        <select
          value={dateRange}
          onChange={(e) => handleDateRangeChange(e.target.value as DateRangePreset)}
          disabled={liveMode}
          style={{ width: 130 }}
        >
          {DATE_RANGE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-muted)", cursor: "pointer", whiteSpace: "nowrap" }}>
          <input type="checkbox" checked={liveMode} onChange={(e) => setLiveMode(e.target.checked)} style={{ accentColor: "var(--accent)" }} />
          Live
        </label>
        {liveMode && paused && (
          <button className="btn-primary" style={{ fontSize: 12, padding: "4px 10px" }} onClick={handleResume}>
            Resume ({liveBufferRef.current.length})
          </button>
        )}
        {liveMode && !paused && (
          <button className="btn-ghost" style={{ fontSize: 12, padding: "4px 10px" }} onClick={() => setPaused(true)}>
            Pause
          </button>
        )}
        {!liveMode && (
          <button className="btn-ghost" style={{ fontSize: 12, padding: "4px 10px" }} onClick={() => void fetchLogs(query, level, eventFilter, dateRange, page)}>
            Refresh
          </button>
        )}
      </div>

      {/* Virtual log list */}
      <div
        ref={parentRef}
        style={{
          flex: 1,
          overflow: "auto",
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
        }}
      >
        {entries.length === 0 ? (
          <div style={{ padding: "40px 16px", color: "var(--text-muted)", textAlign: "center", fontSize: 13 }}>
            {loading ? "Loading…" : "No log entries match your filters."}
          </div>
        ) : (
          <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
            {rowVirtualizer.getVirtualItems().map((virtualRow) => (
              <div
                key={virtualRow.key}
                data-index={virtualRow.index}
                ref={rowVirtualizer.measureElement}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 0,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                <LogRow
                  entry={entries[virtualRow.index]!}
                  expanded={expandedIdx === virtualRow.index}
                  onToggle={() =>
                    setExpandedIdx((prev) => prev === virtualRow.index ? null : virtualRow.index)
                  }
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Pagination footer */}
      {!liveMode && (
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0, fontSize: 12, color: "var(--text-muted)" }}>
          <button
            className="btn-ghost"
            style={{ fontSize: 12, padding: "4px 10px" }}
            disabled={page === 0 || loading}
            onClick={() => void fetchLogs(query, level, eventFilter, dateRange, page - 1)}
          >
            ← Prev
          </button>
          <span>
            {loading ? "Loading…" : `Page ${page + 1} of ${totalPages} · ${total} entries`}
          </span>
          <button
            className="btn-ghost"
            style={{ fontSize: 12, padding: "4px 10px" }}
            disabled={(page + 1) >= totalPages || loading}
            onClick={() => void fetchLogs(query, level, eventFilter, dateRange, page + 1)}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
