import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { authHeaders } from "../api";

// ── Types ────────────────────────────────────────────────────────────────────

export interface SlimModel {
  id: string;
  name: string;
  context_length: number;
  prompt_price: number;
  completion_price: number;
  supports_vision: boolean;
}

interface ModelsResponse {
  models: SlimModel[];
  providers: string[];
}

// ── Shared cache (avoids duplicate fetches across components) ────────────────

let cachedData: ModelsResponse | null = null;
let fetchPromise: Promise<ModelsResponse> | null = null;

export async function fetchModelsData(): Promise<ModelsResponse> {
  if (cachedData) return cachedData;
  if (fetchPromise) return fetchPromise;
  fetchPromise = (async () => {
    const r = await fetch("/api/models", { headers: authHeaders(), signal: AbortSignal.timeout(15_000) });
    const data = await r.json() as ModelsResponse;
    cachedData = data;
    fetchPromise = null;
    return data;
  })();
  return fetchPromise;
}

export function useCachedModels() {
  const [data, setData] = useState<ModelsResponse | null>(cachedData);
  const [loading, setLoading] = useState(!cachedData);

  useEffect(() => {
    if (cachedData) { setData(cachedData); setLoading(false); return; }
    void fetchModelsData().then((d) => { setData(d); setLoading(false); });
  }, []);

  return { models: data?.models ?? [], providers: data?.providers ?? [], loading };
}

// ── Searchable model select ──────────────────────────────────────────────────

function formatPrice(p: number): string {
  if (p === 0) return "free";
  // Price per 1M tokens
  const perMil = p * 1_000_000;
  return perMil < 0.01 ? `$${perMil.toFixed(4)}/M` : `$${perMil.toFixed(2)}/M`;
}

export function ModelSelect({
  label,
  value,
  onChange,
  placeholder,
  visionOnly,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  visionOnly?: boolean;
}) {
  const { models, loading } = useCachedModels();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const filtered = useMemo(() => {
    let list = visionOnly ? models.filter((m) => m.supports_vision) : models;
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
    }
    return list.slice(0, 50);
  }, [models, query, visionOnly]);

  const handleSelect = useCallback((id: string) => {
    onChange(id);
    setQuery("");
    setOpen(false);
  }, [onChange]);

  return (
    <div className="field" ref={ref} style={{ position: "relative" }}>
      <label>{label}</label>
      <input
        type="text"
        value={open ? query : value}
        placeholder={loading ? "Loading models…" : placeholder}
        onFocus={() => { setOpen(true); setQuery(""); }}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
      />
      {value && !open && (
        <button
          type="button"
          onClick={() => { onChange(""); setOpen(true); }}
          style={{
            position: "absolute", right: 8, top: 28,
            background: "none", border: "none", color: "var(--text-muted)",
            cursor: "pointer", fontSize: 14, padding: "2px 4px",
          }}
        >
          ×
        </button>
      )}
      {open && (
        <div style={{
          position: "absolute", top: "100%", left: 0, right: 0,
          maxHeight: 260, overflowY: "auto", zIndex: 50,
          background: "var(--bg-elevated)", border: "1px solid var(--border)",
          borderRadius: "var(--radius)", marginTop: 2,
          boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
        }}>
          {filtered.length === 0 ? (
            <div style={{ padding: "10px 12px", color: "var(--text-muted)", fontSize: 12 }}>
              {loading ? "Loading…" : "No models found"}
            </div>
          ) : (
            filtered.map((m) => (
              <div
                key={m.id}
                onClick={() => handleSelect(m.id)}
                style={{
                  padding: "6px 12px", cursor: "pointer", fontSize: 12,
                  background: m.id === value ? "var(--accent-subtle)" : undefined,
                  borderBottom: "1px solid var(--border)",
                }}
                onMouseEnter={(e) => { (e.target as HTMLElement).style.background = "var(--accent-glow)"; }}
                onMouseLeave={(e) => { (e.target as HTMLElement).style.background = m.id === value ? "var(--accent-subtle)" : ""; }}
              >
                <div style={{ fontWeight: 500 }}>{m.id}</div>
                <div style={{ color: "var(--text-muted)", fontSize: 11, display: "flex", gap: 10, marginTop: 1 }}>
                  <span>{m.context_length > 0 ? `${(m.context_length / 1000).toFixed(0)}k ctx` : ""}</span>
                  <span>in: {formatPrice(m.prompt_price)}</span>
                  <span>out: {formatPrice(m.completion_price)}</span>
                  {m.supports_vision && <span style={{ color: "var(--accent)" }}>vision</span>}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ── Multi-model select (for fallback models) ─────────────────────────────────

export function MultiModelSelect({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}) {
  const { models, loading } = useCachedModels();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const filtered = useMemo(() => {
    let list = models;
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
    }
    return list.slice(0, 50);
  }, [models, query]);

  const toggle = useCallback((id: string) => {
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  }, [value, onChange]);

  return (
    <div className="field" ref={ref} style={{ position: "relative" }}>
      <label>{label}</label>
      {value.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 4 }}>
          {value.map((id) => (
            <span key={id} style={{
              background: "var(--accent-glow)", color: "var(--accent)",
              border: "1px solid rgba(124,138,255,0.3)",
              padding: "1px 6px", borderRadius: 4, fontSize: 11, fontWeight: 500,
              display: "inline-flex", alignItems: "center", gap: 4,
            }}>
              {id}
              <button type="button" onClick={() => toggle(id)} style={{
                background: "none", border: "none", color: "var(--text-muted)",
                cursor: "pointer", fontSize: 12, padding: 0, lineHeight: 1,
              }}>×</button>
            </span>
          ))}
        </div>
      )}
      <input
        type="text"
        value={query}
        placeholder={loading ? "Loading models…" : placeholder ?? "Search to add models…"}
        onFocus={() => setOpen(true)}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
      />
      {open && (
        <div style={{
          position: "absolute", top: "100%", left: 0, right: 0,
          maxHeight: 260, overflowY: "auto", zIndex: 50,
          background: "var(--bg-elevated)", border: "1px solid var(--border)",
          borderRadius: "var(--radius)", marginTop: 2,
          boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
        }}>
          {filtered.length === 0 ? (
            <div style={{ padding: "10px 12px", color: "var(--text-muted)", fontSize: 12 }}>
              {loading ? "Loading…" : "No models found"}
            </div>
          ) : (
            filtered.map((m) => {
              const selected = value.includes(m.id);
              return (
                <div
                  key={m.id}
                  onClick={() => toggle(m.id)}
                  style={{
                    padding: "6px 12px", cursor: "pointer", fontSize: 12,
                    background: selected ? "var(--accent-subtle)" : undefined,
                    borderBottom: "1px solid var(--border)",
                    display: "flex", alignItems: "center", gap: 8,
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--accent-glow)"; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = selected ? "var(--accent-subtle)" : ""; }}
                >
                  <input type="checkbox" checked={selected} readOnly style={{ accentColor: "var(--accent)", pointerEvents: "none" }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 500 }}>{m.id}</div>
                    <div style={{ color: "var(--text-muted)", fontSize: 11, display: "flex", gap: 10, marginTop: 1 }}>
                      <span>{m.context_length > 0 ? `${(m.context_length / 1000).toFixed(0)}k ctx` : ""}</span>
                      <span>in: {formatPrice(m.prompt_price)}</span>
                      <span>out: {formatPrice(m.completion_price)}</span>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

// ── Multi-checkbox dropdown for providers ────────────────────────────────────

export function ProviderMultiSelect({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}) {
  const { providers, loading } = useCachedModels();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const filtered = useMemo(() => {
    if (!filter.trim()) return providers;
    const q = filter.toLowerCase();
    return providers.filter((p) => p.toLowerCase().includes(q));
  }, [providers, filter]);

  const toggle = useCallback((p: string) => {
    onChange(value.includes(p) ? value.filter((v) => v !== p) : [...value, p]);
  }, [value, onChange]);

  return (
    <div className="field" ref={ref} style={{ position: "relative" }}>
      <label>{label}</label>
      <div
        onClick={() => setOpen(!open)}
        style={{
          background: "var(--bg-input)", border: "1px solid var(--border)",
          borderRadius: "var(--radius)", padding: "6px 10px",
          cursor: "pointer", fontSize: 13, minHeight: 34,
          display: "flex", alignItems: "center", flexWrap: "wrap", gap: 4,
        }}
      >
        {value.length === 0 ? (
          <span style={{ color: "var(--text-muted)" }}>{placeholder ?? "Select providers…"}</span>
        ) : (
          value.map((p) => (
            <span key={p} style={{
              background: "var(--accent-glow)", color: "var(--accent)",
              border: "1px solid rgba(124,138,255,0.3)",
              padding: "1px 6px", borderRadius: 4, fontSize: 11, fontWeight: 500,
              display: "inline-flex", alignItems: "center", gap: 4,
            }}>
              {p}
              <button type="button" onClick={(e) => { e.stopPropagation(); toggle(p); }} style={{
                background: "none", border: "none", color: "var(--text-muted)",
                cursor: "pointer", fontSize: 12, padding: 0, lineHeight: 1,
              }}>×</button>
            </span>
          ))
        )}
      </div>
      {open && (
        <div style={{
          position: "absolute", top: "100%", left: 0, right: 0,
          maxHeight: 280, overflowY: "auto", zIndex: 50,
          background: "var(--bg-elevated)", border: "1px solid var(--border)",
          borderRadius: "var(--radius)", marginTop: 2,
          boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
        }}>
          <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)", position: "sticky", top: 0, background: "var(--bg-elevated)" }}>
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter providers…"
              style={{ width: "100%", fontSize: 12, padding: "4px 8px" }}
              onClick={(e) => e.stopPropagation()}
            />
          </div>
          {loading ? (
            <div style={{ padding: "10px 12px", color: "var(--text-muted)", fontSize: 12 }}>Loading…</div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: "10px 12px", color: "var(--text-muted)", fontSize: 12 }}>No providers found</div>
          ) : (
            filtered.map((p) => {
              const selected = value.includes(p);
              return (
                <div
                  key={p}
                  onClick={() => toggle(p)}
                  style={{
                    padding: "6px 12px", cursor: "pointer", fontSize: 12,
                    display: "flex", alignItems: "center", gap: 8,
                    background: selected ? "var(--accent-subtle)" : undefined,
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--accent-glow)"; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = selected ? "var(--accent-subtle)" : ""; }}
                >
                  <input type="checkbox" checked={selected} readOnly style={{ accentColor: "var(--accent)", pointerEvents: "none" }} />
                  <span style={{ fontWeight: selected ? 600 : 400 }}>{p}</span>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
