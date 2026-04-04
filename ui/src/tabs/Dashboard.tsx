import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { authHeaders, api } from "../api";
import { type DateRangePreset, presetToFromIso, DATE_RANGE_OPTIONS } from "../dateRange";

// ── API types ─────────────────────────────────────────────────────────────────

interface Session {
  sessionId: string;
  model?: string;
  turnCount?: number;
  cumulativeCostUsd?: number;
  source?: string;
  updatedAt?: string;
}

interface SessionsResponse {
  sessions?: Session[];
  total?: number;
}

interface ConfigResponse {
  model?: string;
  models?: string[];
  visionModel?: string;
  maxCostUsd?: number;
  maxCostUsdSoft?: number;
}

type OmlsStatusResponse = {
  localAdapter: {
    version: number;
    backend: string;
    baseModel: string;
    trainedAt: string;
    trajectoryCount: number;
  } | null;
  cloudEndpoint: string | null;
  bufferSize: number;
  skillGen: number;
} | null

interface CreditsResponse {
  configured?: boolean;
  usage?: number;
  usage_daily?: number;
  usage_weekly?: number;
  usage_monthly?: number;
  limit?: number | null;
  limit_remaining?: number | null;
  is_free_tier?: boolean;
}

async function fetchSessions(limit = 500, offset = 0): Promise<SessionsResponse> {
  const r = await fetch(`/api/sessions?limit=${limit}&offset=${offset}`, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(4000),
  });
  return r.json() as Promise<SessionsResponse>;
}

async function fetchConfig(): Promise<ConfigResponse> {
  const r = await fetch("/api/config", { headers: authHeaders(), signal: AbortSignal.timeout(4000) });
  return r.json() as Promise<ConfigResponse>;
}

async function fetchCredits(): Promise<CreditsResponse> {
  const r = await fetch("/api/credits", { headers: authHeaders(), signal: AbortSignal.timeout(8000) });
  return r.json() as Promise<CreditsResponse>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [credits, setCredits] = useState<CreditsResponse | null>(null);
  const [omlsStatus, setOmlsStatus] = useState<OmlsStatusResponse>(null);
  const [allSessions, setAllSessions] = useState<Session[]>([]);
  const [sessionsPage, setSessionsPage] = useState(0);
  const [dateRange, setDateRange] = useState<DateRangePreset>("7d");
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [loading, setLoading] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const PAGE_SIZE = 20;

  const filteredSessions = useMemo(() => {
    const fromIso = presetToFromIso(dateRange);
    if (!fromIso) return allSessions;
    return allSessions.filter((s) => s.updatedAt && s.updatedAt >= fromIso);
  }, [allSessions, dateRange]);

  const sessionsTotal = filteredSessions.length;
  const sessions = filteredSessions.slice(sessionsPage * PAGE_SIZE, (sessionsPage + 1) * PAGE_SIZE);

  const totalCost = useMemo(() => {
    return filteredSessions.reduce((sum, s) => sum + (s.cumulativeCostUsd ?? 0), 0);
  }, [filteredSessions]);

  const loadSessions = useCallback(async () => {
    try {
      const res = await fetchSessions(500, 0);
      setAllSessions(res.sessions ?? []);
    } catch {
      // non-fatal
    }
  }, []);

  const loadConfig = useCallback(async () => {
    try {
      setConfig(await fetchConfig());
    } catch {
      // non-fatal
    }
  }, []);

  const loadOmlsStatus = useCallback(async () => {
    try {
      setOmlsStatus(await api.getOmlsStatus());
    } catch {
      // non-fatal
    }
  }, []);

  const loadCredits = useCallback(async () => {
    try {
      setCredits(await fetchCredits());
    } catch {
      // non-fatal
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      await Promise.all([loadSessions(), loadConfig(), loadCredits(), loadOmlsStatus()]);
      setLastRefreshed(new Date());
    } catch {
      // non-fatal
    } finally {
      setLoading(false);
    }
  }, [loadSessions, loadConfig, loadCredits, loadOmlsStatus]);

  // Initial load
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Polling
  useEffect(() => {
    if (!autoRefresh) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }
    intervalRef.current = setInterval(() => { void refresh(); }, 15000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [autoRefresh, refresh]);

  // Pause polling when tab is hidden
  useEffect(() => {
    const handler = () => {
      if (document.hidden) {
        if (intervalRef.current) clearInterval(intervalRef.current);
      } else if (autoRefresh) {
        intervalRef.current = setInterval(() => { void refresh(); }, 15000);
        void refresh();
      }
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [autoRefresh, refresh]);

  // Count unique models from sessions
  const recentModels = useMemo(() => {
    const models = new Set<string>();
    for (const s of filteredSessions) {
      if (s.model) models.add(s.model);
    }
    return [...models];
  }, [filteredSessions]);

  // Reset page when date range changes
  useEffect(() => { setSessionsPage(0); }, [dateRange]);

  if (loading) {
    return <div className="placeholder"><p>Loading...</p></div>;
  }

  const totalPages = Math.ceil(sessionsTotal / PAGE_SIZE);

  return (
    <div>
      {/* ── Header bar ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <Badge label="orager" variant="blue" />
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
          <button className="btn-ghost" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => { void refresh(); }}>
            Refresh
          </button>
        </div>
      </div>

      {/* ── Stat cards ── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 12, marginBottom: 20 }}>
        <StatCard label="Sessions" value={sessionsTotal} />
        <StatCard
          label="Total cost"
          value={`$${totalCost.toFixed(4)}`}
          sub={config?.maxCostUsd ? `limit $${config.maxCostUsd}` : undefined}
        />
        <StatCard label="Models used" value={recentModels.length} />
      </div>

      {/* ── Configured models ── */}
      {config && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-header" style={{ cursor: "default" }}>
            <span className="card-title">Configured models</span>
          </div>
          <div style={{ padding: "10px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", minWidth: 60 }}>Primary</span>
              <Badge label={config.model || "not set"} variant={config.model ? "blue" : "gray"} />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", minWidth: 60 }}>Fallback</span>
              {(config.models?.length ?? 0) > 0
                ? config.models!.map((m) => <Badge key={m} label={m} variant="blue" />)
                : <span style={{ fontSize: 12, color: "var(--text-muted)" }}>none</span>}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", minWidth: 60 }}>Vision</span>
              {config.visionModel
                ? <Badge label={config.visionModel} variant="blue" />
                : <span style={{ fontSize: 12, color: "var(--text-muted)" }}>none</span>}
            </div>
          </div>
        </div>
      )}

      {/* ── OMLS / RL training status ── */}
      {omlsStatus !== null && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-header" style={{ cursor: "default" }}>
            <span className="card-title">OMLS / RL training</span>
            <Badge
              label={omlsStatus?.localAdapter ? `v${omlsStatus.localAdapter.version} local` : omlsStatus?.cloudEndpoint ? "cloud" : "no adapter"}
              variant={omlsStatus?.localAdapter ? "green" : omlsStatus?.cloudEndpoint ? "blue" : "gray"}
            />
          </div>
          <div style={{ padding: "10px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
            {omlsStatus?.localAdapter ? (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", minWidth: 80 }}>Local adapter</span>
                  <Badge label={omlsStatus.localAdapter.backend} variant="green" />
                  <span style={{ fontSize: 12, color: "var(--text-muted)" }}>trained {new Date(omlsStatus.localAdapter.trainedAt).toLocaleDateString()}</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", minWidth: 80 }}>Base model</span>
                  <span style={{ fontSize: 12, fontFamily: "monospace" }}>{omlsStatus.localAdapter.baseModel}</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", minWidth: 80 }}>Trajectories</span>
                  <span style={{ fontSize: 12 }}>{omlsStatus.localAdapter.trajectoryCount} trained</span>
                </div>
              </>
            ) : omlsStatus?.cloudEndpoint ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", minWidth: 80 }}>Cloud endpoint</span>
                <span style={{ fontSize: 12, fontFamily: "monospace", color: "var(--text-muted)" }}>{omlsStatus.cloudEndpoint}</span>
              </div>
            ) : (
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                No adapter trained yet. Run <code style={{ background: "var(--bg-input)", padding: "2px 6px", borderRadius: 4 }}>orager skill-train --rl</code> to start.
              </div>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 8, paddingTop: 4, borderTop: "1px solid var(--border)" }}>
              <span style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", minWidth: 80 }}>Buffer</span>
              <span style={{ fontSize: 12 }}>
                {omlsStatus?.bufferSize ?? 0} trajectories
                {(omlsStatus?.bufferSize ?? 0) < 32 && (omlsStatus?.bufferSize ?? 0) > 0 && (
                  <span style={{ color: "var(--warn)", marginLeft: 6 }}>({32 - (omlsStatus?.bufferSize ?? 0)} more needed)</span>
                )}
                {(omlsStatus?.bufferSize ?? 0) >= 32 && (
                  <span style={{ color: "var(--success)", marginLeft: 6 }}>ready to train</span>
                )}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* ── API credits ── */}
      {credits?.configured && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-header" style={{ cursor: "default" }}>
            <span className="card-title">API credits</span>
            {credits.is_free_tier && <Badge label="Free tier" variant="yellow" />}
          </div>
          <div style={{ padding: "10px 16px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))", gap: 10 }}>
              {credits.limit != null && (
                <div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase" }}>Remaining</div>
                  <div style={{ fontSize: 18, fontWeight: 700 }}>${(credits.limit_remaining ?? 0).toFixed(2)}</div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)" }}>of ${credits.limit.toFixed(2)} limit</div>
                </div>
              )}
              <div>
                <div style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase" }}>Total usage</div>
                <div style={{ fontSize: 18, fontWeight: 700 }}>${(credits.usage ?? 0).toFixed(4)}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase" }}>Today</div>
                <div style={{ fontSize: 16, fontWeight: 600 }}>${(credits.usage_daily ?? 0).toFixed(4)}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase" }}>This week</div>
                <div style={{ fontSize: 16, fontWeight: 600 }}>${(credits.usage_weekly ?? 0).toFixed(4)}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase" }}>This month</div>
                <div style={{ fontSize: 16, fontWeight: 600 }}>${(credits.usage_monthly ?? 0).toFixed(4)}</div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Recent models ── */}
      {recentModels.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-header" style={{ cursor: "default" }}>
            <span className="card-title">Models used</span>
          </div>
          <div style={{ padding: "10px 16px", display: "flex", flexWrap: "wrap", gap: 6 }}>
            {recentModels.map((m) => (
              <Badge key={m} label={m} variant="blue" />
            ))}
          </div>
        </div>
      )}

      {/* ── Sessions ── */}
      <div className="card">
        <div className="card-header" style={{ cursor: "default" }}>
          <span className="card-title">Sessions {sessionsTotal > 0 ? `(${sessionsTotal})` : ""}</span>
          <select
            value={dateRange}
            onChange={(e) => setDateRange(e.target.value as DateRangePreset)}
            style={{ marginLeft: "auto", width: 130, padding: "4px 8px", fontSize: 12 }}
          >
            {DATE_RANGE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        {sessions.length === 0 ? (
          <div style={{ padding: "20px 16px", color: "var(--text-muted)", fontSize: 13 }}>
            No sessions found. Run <code style={{ background: "var(--bg-input)", padding: "2px 6px", borderRadius: 4, color: "var(--text)" }}>orager run "prompt"</code> or <code style={{ background: "var(--bg-input)", padding: "2px 6px", borderRadius: 4, color: "var(--text)" }}>orager chat</code> to create one.
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
                  Prev
                </button>
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  Page {sessionsPage + 1} of {totalPages}
                </span>
                <button className="btn-ghost" style={{ padding: "4px 10px", fontSize: 12 }} disabled={sessionsPage >= totalPages - 1} onClick={() => setSessionsPage((p) => p + 1)}>
                  Next
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
