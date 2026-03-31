import React, { useCallback, useEffect, useRef, useState } from "react";
import { authHeaders } from "../api";

// ── API types ─────────────────────────────────────────────────────────────────

interface HealthCheck {
  status: "ok" | "degraded";
  checks?: Record<string, { ok: boolean; error?: string }>;
}

interface DaemonStatusResponse {
  running: boolean;
  port: number | null;
  pid: number | null;
  health: HealthCheck | null;
  error?: string;
}

interface ProviderHealth {
  provider: string;
  degraded: boolean;
  errorCount?: number;
  lastError?: string | null;
}

interface CircuitBreakerState {
  state: "closed" | "open" | "half-open";
  failures: number;
  lastFailureAt?: string | null;
}

interface MetricsResponse {
  running?: boolean;
  activeRuns?: number;
  maxConcurrent?: number;
  completedRuns?: number;
  errorRuns?: number;
  uptimeMs?: number;
  recentModels?: string[];
  providerHealth?: ProviderHealth[];
  circuitBreakersByAgent?: Record<string, CircuitBreakerState>;
  rateLimitState?: {
    requestsInWindow?: number;
    limitRpm?: number;
    windowResetAt?: string;
  };
}

interface Session {
  sessionId: string;
  model?: string;
  turnCount?: number;
  cumulativeCostUsd?: number;
  source?: string;
  updatedAt?: string;
}

interface SessionsResponse {
  running?: boolean;
  sessions?: Session[];
  total?: number;
}

async function fetchStatus(): Promise<DaemonStatusResponse> {
  const r = await fetch("/api/daemon/status", { headers: authHeaders(), signal: AbortSignal.timeout(4000) });
  return r.json() as Promise<DaemonStatusResponse>;
}

async function fetchMetrics(): Promise<MetricsResponse> {
  const r = await fetch("/api/daemon/metrics", { headers: authHeaders(), signal: AbortSignal.timeout(4000) });
  return r.json() as Promise<MetricsResponse>;
}

async function fetchSessions(limit = 20, offset = 0): Promise<SessionsResponse> {
  const r = await fetch(`/api/daemon/sessions?limit=${limit}&offset=${offset}`, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(4000),
  });
  return r.json() as Promise<SessionsResponse>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function Badge({ label, variant }: { label: string; variant: "green" | "red" | "yellow" | "blue" | "gray" }) {
  const colors: Record<string, React.CSSProperties> = {
    green:  { background: "rgba(62,207,142,0.15)", color: "var(--success)", border: "1px solid rgba(62,207,142,0.3)" },
    red:    { background: "rgba(248,113,113,0.15)", color: "var(--error)",   border: "1px solid rgba(248,113,113,0.3)" },
    yellow: { background: "rgba(245,158,11,0.15)",  color: "var(--warn)",    border: "1px solid rgba(245,158,11,0.3)" },
    blue:   { background: "var(--accent-glow)", color: "var(--accent)",  border: "1px solid rgba(124,138,255,0.3)" },
    gray:   { background: "rgba(124,127,154,0.15)", color: "var(--text-muted)", border: "1px solid rgba(124,127,154,0.3)" },
  };
  return (
    <span style={{
      ...colors[variant],
      padding: "2px 8px",
      borderRadius: 4,
      fontSize: 12,
      fontWeight: 600,
    }}>
      {label}
    </span>
  );
}

function StatCard({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div style={{
      background: "var(--bg-card)",
      border: "1px solid var(--border)",
      borderRadius: "var(--radius)",
      padding: "14px 18px",
      display: "flex",
      flexDirection: "column",
      gap: 4,
    }}>
      <span style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.5px" }}>{label}</span>
      <span style={{ fontSize: 22, fontWeight: 700, color: "var(--text)" }}>{value}</span>
      {sub && <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{sub}</span>}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Dashboard() {
  const [status, setStatus] = useState<DaemonStatusResponse | null>(null);
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionsTotal, setSessionsTotal] = useState(0);
  const [sessionsPage, setSessionsPage] = useState(0);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [loading, setLoading] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const PAGE_SIZE = 20;

  const refresh = useCallback(async () => {
    try {
      const [s, m] = await Promise.all([fetchStatus(), fetchMetrics()]);
      setStatus(s);
      setMetrics(m);
      setLastRefreshed(new Date());
    } catch {
      // network errors are non-fatal; keep showing stale data
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSessions = useCallback(async (page: number) => {
    try {
      const res = await fetchSessions(PAGE_SIZE, page * PAGE_SIZE);
      setSessions(res.sessions ?? []);
      setSessionsTotal(res.total ?? 0);
    } catch {
      // non-fatal
    }
  }, []);

  // Initial load + polling
  useEffect(() => {
    void refresh();
    void loadSessions(0);
  }, [refresh, loadSessions]);

  useEffect(() => {
    if (!autoRefresh) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }
    intervalRef.current = setInterval(() => { void refresh(); }, 5000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [autoRefresh, refresh]);

  // Pause polling when tab is hidden
  useEffect(() => {
    const handler = () => {
      if (document.hidden) {
        if (intervalRef.current) clearInterval(intervalRef.current);
      } else if (autoRefresh) {
        intervalRef.current = setInterval(() => { void refresh(); }, 5000);
        void refresh();
      }
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [autoRefresh, refresh]);

  // Reload sessions when page changes
  useEffect(() => {
    void loadSessions(sessionsPage);
  }, [sessionsPage, loadSessions]);

  if (loading) {
    return <div className="placeholder"><p>Loading…</p></div>;
  }

  const isRunning = status?.running ?? false;
  const totalPages = Math.ceil(sessionsTotal / PAGE_SIZE);

  return (
    <div>
      {/* ── Header bar ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        {isRunning
          ? <Badge label="Daemon running" variant="green" />
          : <Badge label="Daemon offline" variant="red" />}
        {status?.port && <span style={{ fontSize: 12, color: "var(--text-muted)" }}>port {status.port}</span>}
        {status?.pid  && <span style={{ fontSize: 12, color: "var(--text-muted)" }}>pid {status.pid}</span>}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
          {lastRefreshed && (
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
              refreshed {lastRefreshed.toLocaleTimeString()}
            </span>
          )}
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-muted)", cursor: "pointer" }}>
            <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} style={{ accentColor: "var(--accent)" }} />
            Auto-refresh
          </label>
          <button className="btn-ghost" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => { void refresh(); void loadSessions(sessionsPage); }}>
            Refresh
          </button>
        </div>
      </div>

      {!isRunning && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div style={{ padding: "20px 16px", color: "var(--text-muted)", fontSize: 13 }}>
            The daemon is not running. Start it with{" "}
            <code style={{ background: "var(--bg-input)", padding: "2px 6px", borderRadius: 4, color: "var(--text)" }}>
              orager --serve
            </code>{" "}
            then refresh.
            {status?.error && <div style={{ marginTop: 8, color: "var(--warn)" }}>{status.error}</div>}
          </div>
        </div>
      )}

      {/* ── Stat cards ── */}
      {isRunning && metrics && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 12, marginBottom: 20 }}>
            <StatCard
              label="Active runs"
              value={`${metrics.activeRuns ?? 0} / ${metrics.maxConcurrent ?? "–"}`}
            />
            <StatCard label="Completed" value={metrics.completedRuns ?? 0} />
            <StatCard label="Errors" value={metrics.errorRuns ?? 0} />
            <StatCard
              label="Uptime"
              value={metrics.uptimeMs !== undefined ? formatUptime(metrics.uptimeMs) : "–"}
            />
            {metrics.rateLimitState && (
              <StatCard
                label="Rate (rpm)"
                value={`${metrics.rateLimitState.requestsInWindow ?? 0} / ${metrics.rateLimitState.limitRpm ?? "–"}`}
              />
            )}
          </div>

          {/* Models */}
          {(metrics.recentModels?.length ?? 0) > 0 && (
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="card-header" style={{ cursor: "default" }}>
                <span className="card-title">Recent models</span>
              </div>
              <div style={{ padding: "10px 16px", display: "flex", flexWrap: "wrap", gap: 6 }}>
                {metrics.recentModels!.map((m) => (
                  <Badge key={m} label={m} variant="blue" />
                ))}
              </div>
            </div>
          )}

          {/* Provider health */}
          {(metrics.providerHealth?.length ?? 0) > 0 && (
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="card-header" style={{ cursor: "default" }}>
                <span className="card-title">Provider health</span>
              </div>
              <div style={{ padding: "10px 16px", display: "flex", flexWrap: "wrap", gap: 8 }}>
                {metrics.providerHealth!.map((p) => (
                  <Badge
                    key={p.provider}
                    label={p.provider}
                    variant={p.degraded ? "red" : "green"}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Circuit breakers */}
          {metrics.circuitBreakersByAgent && Object.keys(metrics.circuitBreakersByAgent).length > 0 && (
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="card-header" style={{ cursor: "default" }}>
                <span className="card-title">Circuit breakers</span>
              </div>
              <div style={{ padding: "0 0 4px" }}>
                <table className="perm-table">
                  <thead>
                    <tr>
                      <th>Agent</th>
                      <th>State</th>
                      <th>Failures</th>
                      <th>Last failure</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(metrics.circuitBreakersByAgent).map(([agent, cb]) => (
                      <tr key={agent}>
                        <td style={{ fontFamily: "monospace", fontSize: 12 }}>{agent}</td>
                        <td>
                          <Badge
                            label={cb.state}
                            variant={cb.state === "closed" ? "green" : cb.state === "open" ? "red" : "yellow"}
                          />
                        </td>
                        <td>{cb.failures}</td>
                        <td style={{ fontSize: 12, color: "var(--text-muted)" }}>
                          {cb.lastFailureAt ? new Date(cb.lastFailureAt).toLocaleString() : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Health checks */}
          {status?.health?.checks && (
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="card-header" style={{ cursor: "default" }}>
                <span className="card-title">Health checks</span>
              </div>
              <div style={{ padding: "0 0 4px" }}>
                <table className="perm-table">
                  <thead>
                    <tr><th>Check</th><th>Status</th><th>Detail</th></tr>
                  </thead>
                  <tbody>
                    {Object.entries(status.health.checks).map(([name, result]) => (
                      <tr key={name}>
                        <td>{name}</td>
                        <td><Badge label={result.ok ? "ok" : "fail"} variant={result.ok ? "green" : "red"} /></td>
                        <td style={{ fontSize: 12, color: "var(--text-muted)" }}>{result.error ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {/* ── Sessions ── */}
      <div className="card">
        <div className="card-header" style={{ cursor: "default" }}>
          <span className="card-title">Sessions {sessionsTotal > 0 ? `(${sessionsTotal})` : ""}</span>
        </div>
        {sessions.length === 0 ? (
          <div style={{ padding: "20px 16px", color: "var(--text-muted)", fontSize: 13 }}>
            {isRunning ? "No sessions found." : "Start the daemon to see sessions."}
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="perm-table">
              <thead>
                <tr>
                  <th>Session ID</th>
                  <th>Model</th>
                  <th>Turns</th>
                  <th>Cost</th>
                  <th>Source</th>
                  <th>Last updated</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.sessionId}>
                    <td style={{ fontFamily: "monospace", fontSize: 12 }}>{s.sessionId.slice(0, 20)}</td>
                    <td style={{ fontSize: 12 }}>{s.model ?? "—"}</td>
                    <td>{s.turnCount ?? 0}</td>
                    <td style={{ fontSize: 12 }}>
                      {s.cumulativeCostUsd !== undefined ? `$${s.cumulativeCostUsd.toFixed(4)}` : "—"}
                    </td>
                    <td>
                      {s.source ? <Badge label={s.source} variant="gray" /> : "—"}
                    </td>
                    <td style={{ fontSize: 12, color: "var(--text-muted)" }}>
                      {s.updatedAt ? new Date(s.updatedAt).toLocaleString() : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {totalPages > 1 && (
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", borderTop: "1px solid var(--border)" }}>
                <button className="btn-ghost" style={{ padding: "4px 10px", fontSize: 12 }} disabled={sessionsPage === 0} onClick={() => setSessionsPage((p) => p - 1)}>
                  ← Prev
                </button>
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  Page {sessionsPage + 1} of {totalPages}
                </span>
                <button className="btn-ghost" style={{ padding: "4px 10px", fontSize: 12 }} disabled={sessionsPage >= totalPages - 1} onClick={() => setSessionsPage((p) => p + 1)}>
                  Next →
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
