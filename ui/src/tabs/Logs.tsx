import React, { useCallback, useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { authHeaders } from "../api";

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

// ── Log row (used in virtual list) ────────────────────────────────────────────

function LogRow({ entry, expanded, onToggle }: {
  entry: LogEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { ts, level, event, sessionId, model, ...rest } = entry;
  // Remove well-known display fields from the "extra" detail
  const extra = Object.entries(rest).filter(([k]) => !["agentId"].includes(k));

  return (
    <div
      style={{
        borderBottom: "1px solid var(--border)",
        padding: "6px 12px",
        cursor: extra.length > 0 ? "pointer" : "default",
        background: expanded ? "var(--accent-subtle)" : undefined,
      }}
      onClick={extra.length > 0 ? onToggle : undefined}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 11, color: "var(--text-muted)", minWidth: 140, flexShrink: 0 }}>
          {ts ? new Date(ts).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3 }) : "—"}
        </span>
        <LevelBadge level={level} />
        <span style={{ fontSize: 13, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {event ?? "(no event)"}
        </span>
        {sessionId && (
          <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "monospace", flexShrink: 0 }}>
            {String(sessionId).slice(0, 12)}
          </span>
        )}
        {model && (
          <span style={{ fontSize: 11, color: "var(--text-muted)", flexShrink: 0 }}>
            {model}
          </span>
        )}
        {extra.length > 0 && (
          <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{expanded ? "▲" : "▼"}</span>
        )}
      </div>
      {expanded && extra.length > 0 && (
        <pre style={{
          marginTop: 8,
          fontSize: 11,
          color: "var(--text-muted)",
          background: "var(--bg-input)",
          borderRadius: 4,
          padding: "8px 10px",
          overflowX: "auto",
          lineHeight: 1.5,
        }}>
          {JSON.stringify(Object.fromEntries(extra), null, 2)}
        </pre>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Logs() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState("");
  const [liveMode, setLiveMode] = useState(false);
  const [paused, setPaused] = useState(false);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  const debounceRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const eventSrcRef  = useRef<EventSource | null>(null);
  const liveBufferRef = useRef<LogEntry[]>([]);
  const parentRef    = useRef<HTMLDivElement>(null);

  // ── Fetch (non-live) ──────────────────────────────────────────────────────
  const fetchLogs = useCallback(async (q: string, lvl: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "200", offset: "0" });
      if (q)   params.set("q", q);
      if (lvl) params.set("level", lvl);
      const r = await fetch(`/api/logs?${params}`, { headers: authHeaders() });
      const data = await r.json() as LogsResponse;
      setConfigured(data.configured);
      setEntries(data.entries ?? []);
      setTotal(data.total ?? 0);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchLogs(query, level);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounce query changes
  const handleQueryChange = (v: string) => {
    setQuery(v);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { void fetchLogs(v, level); }, 300);
  };

  const handleLevelChange = (v: string) => {
    setLevel(v);
    void fetchLogs(query, v);
  };

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

  // ── Virtual list ──────────────────────────────────────────────────────────
  const rowVirtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => (expandedIdx === i ? 200 : 42),
    overscan: 10,
  });

  // ── Render ────────────────────────────────────────────────────────────────
  if (!configured) {
    return (
      <div className="placeholder">
        <h2>No logs yet</h2>
        <p>
          Logs are written to <code style={{ background: "var(--bg-input)", padding: "2px 6px", borderRadius: 4 }}>~/.orager/orager.log</code> automatically.
          Run an agent to generate log entries.
        </p>
        <p style={{ marginTop: 8, fontSize: 12 }}>
          Override with: <code style={{ background: "var(--bg-input)", padding: "2px 6px", borderRadius: 4 }}>ORAGER_LOG_FILE=/path/to/file orager ui</code>
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 120px)", gap: 12 }}>
      {/* Controls */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", flexShrink: 0 }}>
        <input
          type="text"
          placeholder="Search logs…"
          value={query}
          onChange={(e) => handleQueryChange(e.target.value)}
          style={{ flex: 1, minWidth: 200 }}
        />
        <select value={level} onChange={(e) => handleLevelChange(e.target.value)} style={{ width: 120 }}>
          <option value="">All levels</option>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
          <option value="debug">debug</option>
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
          <button className="btn-ghost" style={{ fontSize: 12, padding: "4px 10px" }} onClick={() => fetchLogs(query, level)}>
            Refresh
          </button>
        )}
        <span style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
          {loading ? "Loading…" : `${total} entries`}
        </span>
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
                key={virtualRow.index}
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
                    setExpandedIdx((prev) =>
                      prev === virtualRow.index ? null : virtualRow.index,
                    )
                  }
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
