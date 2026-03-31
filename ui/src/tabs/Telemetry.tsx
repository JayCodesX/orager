import React, { useCallback, useEffect, useMemo, useState } from "react";
import { authHeaders } from "../api";
import { type DateRangePreset, presetToFromIso, DATE_RANGE_OPTIONS } from "../dateRange";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  AreaChart,
  Area,
  CartesianGrid,
} from "recharts";

// ── Types ─────────────────────────────────────────────────────────────────────

interface BufferedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeMs: number;
  endTimeMs: number;
  durationMs: number;
  attributes: Record<string, string | number | boolean>;
  status: "ok" | "error" | "unset";
  errorMessage?: string;
}

interface SpansResponse {
  spans: BufferedSpan[];
  total: number;
  bufferSize: number;
  bufferMax: number;
  configured: boolean;
}

interface TraceSummary {
  traceId: string;
  rootSpanName: string;
  startTimeMs: number;
  totalDurationMs: number;
  spanCount: number;
  errorCount: number;
}

interface TracesResponse {
  traces: TraceSummary[];
  total: number;
  configured: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

const DURATION_BUCKETS = [
  { label: "0–50ms",   min: 0,    max: 50 },
  { label: "50–200ms", min: 50,   max: 200 },
  { label: "200–500ms",min: 200,  max: 500 },
  { label: "500ms–1s", min: 500,  max: 1000 },
  { label: "1–5s",     min: 1000, max: 5000 },
  { label: ">5s",      min: 5000, max: Infinity },
];

function buildHistogram(spans: BufferedSpan[]) {
  return DURATION_BUCKETS.map(({ label, min, max }) => ({
    label,
    count: spans.filter((s) => s.durationMs >= min && s.durationMs < max).length,
  }));
}

function buildTimeline(spans: BufferedSpan[]) {
  if (spans.length === 0) return [];
  const now = Date.now();
  const windowMs = 30 * 60 * 1000;
  const bucketMs = 60 * 1000; // 1-minute buckets
  const buckets: Record<number, number> = {};
  for (let t = now - windowMs; t <= now; t += bucketMs) {
    buckets[Math.floor(t / bucketMs)] = 0;
  }
  for (const s of spans) {
    if (s.startTimeMs < now - windowMs) continue;
    const bucket = Math.floor(s.startTimeMs / bucketMs);
    buckets[bucket] = (buckets[bucket] ?? 0) + 1;
  }
  return Object.entries(buckets)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([bucket, count]) => ({
      time: new Date(Number(bucket) * bucketMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      count,
    }));
}

// ── Waterfall drawer ──────────────────────────────────────────────────────────

function WaterfallDrawer({
  traceId,
  spans,
  onClose,
}: {
  traceId: string;
  spans: BufferedSpan[];
  onClose: () => void;
}) {
  const traceSpans = spans.filter((s) => s.traceId === traceId)
    .sort((a, b) => a.startTimeMs - b.startTimeMs);

  if (traceSpans.length === 0) {
    return null;
  }

  const traceStart = Math.min(...traceSpans.map((s) => s.startTimeMs));
  const traceEnd   = Math.max(...traceSpans.map((s) => s.endTimeMs));
  const totalMs    = Math.max(traceEnd - traceStart, 1);

  return (
    <div style={{
      position: "fixed",
      right: 0, top: 0, bottom: 0,
      width: 520,
      background: "var(--bg-card)",
      borderLeft: "1px solid var(--border)",
      display: "flex",
      flexDirection: "column",
      zIndex: 100,
      boxShadow: "-4px 0 16px rgba(0,0,0,0.4)",
    }}>
      <div style={{
        display: "flex",
        alignItems: "center",
        padding: "12px 16px",
        borderBottom: "1px solid var(--border)",
        gap: 10,
      }}>
        <span style={{ fontWeight: 600, fontSize: 13, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          Trace: {traceId.slice(0, 16)}…
        </span>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
          {traceSpans.length} spans · {totalMs}ms
        </span>
        <button className="btn-ghost" style={{ padding: "4px 10px", fontSize: 12 }} onClick={onClose}>✕</button>
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: "12px 16px" }}>
        {traceSpans.map((span) => {
          const left  = ((span.startTimeMs - traceStart) / totalMs) * 100;
          const width = Math.max((span.durationMs / totalMs) * 100, 0.5);
          const isError = span.status === "error";
          return (
            <div key={span.spanId} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {span.name}
                {isError && <span style={{ color: "var(--error)", marginLeft: 6 }}>✕ error</span>}
                <span style={{ marginLeft: 8 }}>{span.durationMs}ms</span>
              </div>
              <div style={{ background: "var(--bg-input)", borderRadius: 3, height: 10, position: "relative" }}>
                <div style={{
                  position: "absolute",
                  left: `${left}%`,
                  width: `${width}%`,
                  height: "100%",
                  background: isError ? "var(--error)" : "var(--accent)",
                  borderRadius: 3,
                  opacity: 0.85,
                }} />
              </div>
              {span.attributes && Object.keys(span.attributes).length > 0 && (
                <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 2, paddingLeft: 4 }}>
                  {Object.entries(span.attributes).slice(0, 3).map(([k, v]) => (
                    <span key={k} style={{ marginRight: 10 }}>{k}={String(v)}</span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Telemetry() {
  const [spansData, setSpansData] = useState<SpansResponse | null>(null);
  const [tracesData, setTracesData] = useState<TracesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedTrace, setSelectedTrace] = useState<string | null>(null);
  const [dateRange, setDateRange] = useState<DateRangePreset>("today");

  const fetchAll = useCallback(async () => {
    try {
      const hdrs = authHeaders();
      const [sr, tr] = await Promise.all([
        fetch("/api/telemetry/spans?limit=500", { headers: hdrs }).then((r) => r.json()) as Promise<SpansResponse>,
        fetch("/api/telemetry/traces", { headers: hdrs }).then((r) => r.json()) as Promise<TracesResponse>,
      ]);
      setSpansData(sr);
      setTracesData(tr);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchAll(); }, [fetchAll]);

  const allSpans  = spansData?.spans ?? [];
  const allTraces = tracesData?.traces ?? [];

  const { spans, traces } = useMemo(() => {
    const fromIso = presetToFromIso(dateRange);
    if (!fromIso) return { spans: allSpans, traces: allTraces };
    const fromMs = new Date(fromIso).getTime();
    return {
      spans: allSpans.filter((s) => s.startTimeMs >= fromMs),
      traces: allTraces.filter((t) => t.startTimeMs >= fromMs),
    };
  }, [allSpans, allTraces, dateRange]);

  if (loading) return <div className="placeholder"><p>Loading…</p></div>;

  // Summary stats
  const durations  = [...spans].map((s) => s.durationMs).sort((a, b) => a - b);
  const p50 = percentile(durations, 50);
  const p95 = percentile(durations, 95);
  const errRate = spans.length > 0
    ? ((spans.filter((s) => s.status === "error").length / spans.length) * 100).toFixed(1)
    : "0.0";

  const histogram = buildHistogram(spans);
  const timeline  = buildTimeline(spans);

  const noData = allSpans.length === 0;

  if (noData) {
    return (
      <div className="placeholder">
        <h2>No telemetry data yet</h2>
        <p>
          Telemetry is collected automatically while <code style={{ background: "var(--bg-input)", padding: "2px 6px", borderRadius: 4 }}>orager ui</code> is running.
          Spans are captured from agent runs and stored in an in-process ring buffer (2000 spans max).
        </p>
        <p style={{ marginTop: 8 }}>
          To also export to an external collector (Jaeger, Grafana Tempo, etc.), set{" "}
          <code style={{ background: "var(--bg-input)", padding: "2px 6px", borderRadius: 4 }}>OTEL_EXPORTER_OTLP_ENDPOINT</code>.
        </p>
      </div>
    );
  }

  return (
    <div style={{ position: "relative" }}>
      {selectedTrace && (
        <WaterfallDrawer
          traceId={selectedTrace}
          spans={spans}
          onClose={() => setSelectedTrace(null)}
        />
      )}

      {/* Filter bar */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 16, flexShrink: 0 }}>
        <select value={dateRange} onChange={(e) => setDateRange(e.target.value as DateRangePreset)} style={{ width: 130 }}>
          {DATE_RANGE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <button className="btn-ghost" style={{ fontSize: 12, padding: "4px 10px" }} onClick={() => { setLoading(true); void fetchAll(); }}>
          Refresh
        </button>
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
          {spans.length} spans · {traces.length} traces
        </span>
      </div>

      {/* Summary bar */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 12, marginBottom: 20 }}>
        {[
          { label: "Total traces",  value: traces.length },
          { label: "Total spans",   value: spansData?.bufferSize ?? 0, sub: `/ ${spansData?.bufferMax ?? 2000} max` },
          { label: "p50 duration",  value: `${p50}ms` },
          { label: "p95 duration",  value: `${p95}ms` },
          { label: "Error rate",    value: `${errRate}%` },
        ].map(({ label, value, sub }) => (
          <div key={label} style={{
            background: "var(--bg-card)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            padding: "12px 16px",
          }}>
            <div style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.5px" }}>{label}</div>
            <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>{value}</div>
            {sub && <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{sub}</div>}
          </div>
        ))}
      </div>

      {/* Charts row */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }}>
        {/* Duration histogram */}
        <div className="card">
          <div className="card-header" style={{ cursor: "default" }}>
            <span className="card-title">Duration distribution</span>
          </div>
          <div style={{ padding: "16px 8px 8px" }}>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={histogram} margin={{ top: 0, right: 8, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: "var(--text-muted)" }} />
                <YAxis tick={{ fontSize: 10, fill: "var(--text-muted)" }} />
                <Tooltip
                  contentStyle={{ background: "var(--bg-card)", border: "1px solid var(--border)", fontSize: 12 }}
                  labelStyle={{ color: "var(--text)" }}
                  itemStyle={{ color: "var(--accent)" }}
                />
                <Bar dataKey="count" fill="var(--accent)" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Span rate timeline */}
        <div className="card">
          <div className="card-header" style={{ cursor: "default" }}>
            <span className="card-title">Spans / min (last 30 min)</span>
          </div>
          <div style={{ padding: "16px 8px 8px" }}>
            <ResponsiveContainer width="100%" height={180}>
              <AreaChart data={timeline} margin={{ top: 0, right: 8, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="spanGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="var(--accent)" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="var(--accent)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="time" tick={{ fontSize: 10, fill: "var(--text-muted)" }} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 10, fill: "var(--text-muted)" }} />
                <Tooltip
                  contentStyle={{ background: "var(--bg-card)", border: "1px solid var(--border)", fontSize: 12 }}
                  labelStyle={{ color: "var(--text)" }}
                  itemStyle={{ color: "var(--accent)" }}
                />
                <Area type="monotone" dataKey="count" stroke="var(--accent)" fill="url(#spanGradient)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Trace list */}
      <div className="card">
        <div className="card-header" style={{ cursor: "default" }}>
          <span className="card-title">Traces ({traces.length})</span>
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>click a row to open waterfall</span>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table className="perm-table">
            <thead>
              <tr>
                <th>Trace ID</th>
                <th>Root span</th>
                <th>Started</th>
                <th>Duration</th>
                <th>Spans</th>
                <th>Errors</th>
              </tr>
            </thead>
            <tbody>
              {traces.slice(0, 100).map((t) => (
                <tr
                  key={t.traceId}
                  style={{ cursor: "pointer" }}
                  onClick={() => setSelectedTrace((prev) => prev === t.traceId ? null : t.traceId)}
                >
                  <td style={{ fontFamily: "monospace", fontSize: 11 }}>{t.traceId.slice(0, 12)}…</td>
                  <td style={{ fontSize: 12 }}>{t.rootSpanName}</td>
                  <td style={{ fontSize: 12, color: "var(--text-muted)" }}>
                    {new Date(t.startTimeMs).toLocaleTimeString()}
                  </td>
                  <td style={{ fontSize: 12 }}>{t.totalDurationMs}ms</td>
                  <td>{t.spanCount}</td>
                  <td>
                    {t.errorCount > 0
                      ? <span style={{ color: "var(--error)", fontWeight: 600 }}>{t.errorCount}</span>
                      : <span style={{ color: "var(--text-muted)" }}>—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
