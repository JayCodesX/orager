import React, { useCallback, useEffect, useRef, useState } from "react";
import { api, OragerSettings, OragerUserConfig } from "../api.ts";
import { useToast } from "../components/Toast.tsx";
import { ModelSelect, MultiModelSelect, ProviderMultiSelect, useCachedModels } from "../components/ModelSelect.tsx";

// ── Collapsible section card ──────────────────────────────────────────────────

function Section({
  title,
  children,
  defaultOpen = true,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="card">
      <div className="card-header" onClick={() => setOpen((o) => !o)}>
        <span className="card-title">{title}</span>
        <span className={`card-chevron${open ? " open" : ""}`}>▲</span>
      </div>
      {open && <div className="card-body">{children}</div>}
    </div>
  );
}

// ── Field helpers ─────────────────────────────────────────────────────────────

function TextField({
  label,
  value,
  onChange,
  placeholder,
  error,
  full,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  error?: string;
  full?: boolean;
}) {
  return (
    <div className={`field${full ? " field-full" : ""}`}>
      <label>{label}</label>
      <input
        type="text"
        className={error ? "error" : ""}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {error && <span className="field-error">{error}</span>}
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step,
  placeholder,
  error,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  error?: string;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      <input
        type="number"
        className={error ? "error" : ""}
        value={value}
        min={min}
        max={max}
        step={step ?? 1}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {error && <span className="field-error">{error}</span>}
    </div>
  );
}

function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T | undefined;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value as T)}>
        <option value="">(not set)</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function CheckboxField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  const id = useRef(`chk-${Math.random().toString(36).slice(2)}`);
  return (
    <div className="checkbox-row">
      <input
        type="checkbox"
        id={id.current}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <label htmlFor={id.current}>{label}</label>
    </div>
  );
}

function TagsField({
  label,
  value,
  onChange,
  placeholder,
  full,
}: {
  label: string;
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  full?: boolean;
}) {
  const raw = value.join(", ");
  return (
    <div className={`field${full ? " field-full" : ""}`}>
      <label>{label} <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>(comma-separated)</span></label>
      <input
        type="text"
        value={raw}
        placeholder={placeholder}
        onChange={(e) =>
          onChange(
            e.target.value
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          )
        }
      />
    </div>
  );
}

// ── Config → form state conversion ───────────────────────────────────────────

interface ConfigForm {
  model: string;
  models: string[];
  visionModel: string;
  maxTurns: string;
  maxRetries: string;
  timeoutSec: string;
  maxCostUsd: string;
  maxCostUsdSoft: string;
  temperature: string;
  top_p: string;
  top_k: string;
  frequency_penalty: string;
  presence_penalty: string;
  repetition_penalty: string;
  min_p: string;
  seed: string;
  reasoningEffort: OragerUserConfig["reasoningEffort"] | "";
  reasoningMaxTokens: string;
  reasoningExclude: boolean;
  providerOrder: string[];
  providerOnly: string[];
  providerIgnore: string[];
  sort: OragerUserConfig["sort"] | "";
  dataCollection: OragerUserConfig["dataCollection"] | "";
  zdr: boolean;
  summarizeAt: string;
  summarizeModel: string;
  summarizeKeepRecentTurns: string;
  memory: boolean;
  memoryKey: string;
  memoryMaxChars: string;
  memoryRetrieval: OragerUserConfig["memoryRetrieval"] | "";
  memoryEmbeddingModel: string;
  siteUrl: string;
  siteName: string;
  sandboxRoot: string;
  planMode: boolean;
  injectContext: boolean;
  tagToolOutputs: boolean;
  useFinishTool: boolean;
  enableBrowserTools: boolean;
  trackFileChanges: boolean;
  // Ollama
  ollamaEnabled: boolean;
  ollamaModel: string;
  ollamaBaseUrl: string;
  // OMLS
  omlsEnabled: boolean;
  omlsLocalEnabled: boolean;
  omlsLocalBackend: string;
  omlsBaseModel: string;
  profile: string;
  webhookUrl: string;
  webhookFormat: "" | "discord";
  requiredEnvVars: string[];
}

function configToForm(c: OragerUserConfig): ConfigForm {
  const s = (v: number | undefined) => (v !== undefined ? String(v) : "");
  return {
    model:                  c.model ?? "",
    models:                 c.models ?? [],
    visionModel:            c.visionModel ?? "",
    maxTurns:               s(c.maxTurns),
    maxRetries:             s(c.maxRetries),
    timeoutSec:             s(c.timeoutSec),
    maxCostUsd:             s(c.maxCostUsd),
    maxCostUsdSoft:         s(c.maxCostUsdSoft),
    temperature:            s(c.temperature),
    top_p:                  s(c.top_p),
    top_k:                  s(c.top_k),
    frequency_penalty:      s(c.frequency_penalty),
    presence_penalty:       s(c.presence_penalty),
    repetition_penalty:     s(c.repetition_penalty),
    min_p:                  s(c.min_p),
    seed:                   s(c.seed),
    reasoningEffort:        c.reasoningEffort ?? "",
    reasoningMaxTokens:     s(c.reasoningMaxTokens),
    reasoningExclude:       c.reasoningExclude ?? false,
    providerOrder:          c.providerOrder ?? [],
    providerOnly:           c.providerOnly ?? [],
    providerIgnore:         c.providerIgnore ?? [],
    sort:                   c.sort ?? "",
    dataCollection:         c.dataCollection ?? "",
    zdr:                    c.zdr ?? false,
    summarizeAt:            s(c.summarizeAt),
    summarizeModel:         c.summarizeModel ?? "",
    summarizeKeepRecentTurns: s(c.summarizeKeepRecentTurns),
    memory:                 c.memory ?? true,
    memoryKey:              c.memoryKey ?? "",
    memoryMaxChars:         s(c.memoryMaxChars),
    memoryRetrieval:        c.memoryRetrieval ?? "",
    memoryEmbeddingModel:   c.memoryEmbeddingModel ?? "",
    siteUrl:                c.siteUrl ?? "",
    siteName:               c.siteName ?? "",
    sandboxRoot:            c.sandboxRoot ?? "",
    planMode:               c.planMode ?? false,
    injectContext:          c.injectContext ?? true,
    tagToolOutputs:         c.tagToolOutputs ?? true,
    useFinishTool:          c.useFinishTool ?? false,
    enableBrowserTools:     c.enableBrowserTools ?? true,
    trackFileChanges:       c.trackFileChanges ?? true,
    ollamaEnabled:     c.ollama?.enabled ?? false,
    ollamaModel:       c.ollama?.model ?? "",
    ollamaBaseUrl:     c.ollama?.baseUrl ?? "",
    omlsEnabled:       c.omls?.enabled ?? false,
    omlsLocalEnabled:  c.omls?.localTraining?.enabled !== false,
    omlsLocalBackend:  c.omls?.localTraining?.backend ?? "auto",
    omlsBaseModel:     c.omls?.rl?.training?.baseModel ?? "",
    profile:                c.profile ?? "",
    webhookUrl:             c.webhookUrl ?? "",
    webhookFormat:          c.webhookFormat ?? "",
    requiredEnvVars:        c.requiredEnvVars ?? [],
  };
}

function formToConfig(f: ConfigForm): OragerUserConfig {
  const n = (v: string) => (v.trim() !== "" ? Number(v) : undefined);
  const s = (v: string) => (v.trim() !== "" ? v.trim() : undefined);
  return {
    model:               s(f.model),
    models:              f.models.length > 0 ? f.models : undefined,
    visionModel:         s(f.visionModel),
    maxTurns:            n(f.maxTurns),
    maxRetries:          n(f.maxRetries),
    timeoutSec:          n(f.timeoutSec),
    maxCostUsd:          n(f.maxCostUsd),
    maxCostUsdSoft:      n(f.maxCostUsdSoft),
    temperature:         n(f.temperature),
    top_p:               n(f.top_p),
    top_k:               n(f.top_k),
    frequency_penalty:   n(f.frequency_penalty),
    presence_penalty:    n(f.presence_penalty),
    repetition_penalty:  n(f.repetition_penalty),
    min_p:               n(f.min_p),
    seed:                n(f.seed),
    reasoningEffort:     (f.reasoningEffort || undefined) as OragerUserConfig["reasoningEffort"],
    reasoningMaxTokens:  n(f.reasoningMaxTokens),
    reasoningExclude:    f.reasoningExclude || undefined,
    providerOrder:       f.providerOrder.length > 0 ? f.providerOrder : undefined,
    providerOnly:        f.providerOnly.length > 0 ? f.providerOnly : undefined,
    providerIgnore:      f.providerIgnore.length > 0 ? f.providerIgnore : undefined,
    sort:                (f.sort || undefined) as OragerUserConfig["sort"],
    dataCollection:      (f.dataCollection || undefined) as OragerUserConfig["dataCollection"],
    zdr:                 f.zdr || undefined,
    summarizeAt:         n(f.summarizeAt),
    summarizeModel:      s(f.summarizeModel),
    summarizeKeepRecentTurns: n(f.summarizeKeepRecentTurns),
    memory:              f.memory,
    memoryKey:           s(f.memoryKey),
    memoryMaxChars:      n(f.memoryMaxChars),
    memoryRetrieval:     (f.memoryRetrieval || undefined) as OragerUserConfig["memoryRetrieval"],
    memoryEmbeddingModel: s(f.memoryEmbeddingModel),
    siteUrl:             s(f.siteUrl),
    siteName:            s(f.siteName),
    sandboxRoot:         s(f.sandboxRoot),
    planMode:            f.planMode || undefined,
    injectContext:       f.injectContext,
    tagToolOutputs:      f.tagToolOutputs,
    useFinishTool:       f.useFinishTool || undefined,
    enableBrowserTools:  f.enableBrowserTools,
    trackFileChanges:    f.trackFileChanges,
    ollama: (f.ollamaEnabled || f.ollamaModel || f.ollamaBaseUrl) ? {
      enabled: f.ollamaEnabled || undefined,
      model: f.ollamaModel || undefined,
      baseUrl: f.ollamaBaseUrl || undefined,
    } : undefined,
    omls: (f.omlsEnabled || f.omlsBaseModel) ? {
      enabled: f.omlsEnabled || undefined,
      localTraining: {
        enabled: f.omlsLocalEnabled,
        backend: (f.omlsLocalBackend && f.omlsLocalBackend !== "auto") ? f.omlsLocalBackend as "mlx" | "llamacpp-cuda" | "llamacpp-cpu" : undefined,
      },
      rl: f.omlsBaseModel ? { training: { baseModel: f.omlsBaseModel } } : undefined,
    } : undefined,
    profile:             s(f.profile),
    webhookUrl:          s(f.webhookUrl),
    webhookFormat:       f.webhookFormat === "discord" ? "discord" : undefined,
    requiredEnvVars:     f.requiredEnvVars.length > 0 ? f.requiredEnvVars : undefined,
  };
}

// ── Summarize-at hint (auto-suggest based on model context) ──────────────────

function SummarizeAtHint({
  model,
  currentValue,
  onApply,
}: {
  model: string;
  currentValue: string;
  onApply: (v: string) => void;
}) {
  const { models } = useCachedModels();
  const match = models.find((m) => m.id === model);
  if (!match || match.context_length <= 0) return null;

  const suggested = Math.round(match.context_length * 0.8);
  const current = parseInt(currentValue, 10);
  if (current === suggested) return null;

  return (
    <div style={{ fontSize: 11, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6, marginTop: -4 }}>
      <span>
        {match.id} has {(match.context_length / 1000).toFixed(0)}k context — suggested summarize at: <strong style={{ color: "var(--text-secondary)" }}>{suggested.toLocaleString()}</strong>
      </span>
      <button
        type="button"
        className="btn-ghost"
        style={{ fontSize: 11, padding: "1px 6px" }}
        onClick={() => onApply(String(suggested))}
      >
        Apply
      </button>
    </div>
  );
}

// ── Validation ────────────────────────────────────────────────────────────────

interface FormErrors {
  maxTurns?: string;
  maxRetries?: string;
  timeoutSec?: string;
  maxCostUsd?: string;
  maxCostUsdSoft?: string;
  temperature?: string;
  top_p?: string;
  min_p?: string;
}

function validateForm(f: ConfigForm): FormErrors {
  const errs: FormErrors = {};
  const posInt = (v: string, key: keyof FormErrors, label: string) => {
    if (v && (isNaN(Number(v)) || Number(v) < 0))
      (errs[key] as string) = `${label} must be a non-negative number`;
  };
  posInt(f.maxTurns, "maxTurns", "Max turns");
  posInt(f.maxRetries, "maxRetries", "Max retries");
  posInt(f.timeoutSec, "timeoutSec", "Timeout");
  posInt(f.maxCostUsd, "maxCostUsd", "Hard cost cap");
  posInt(f.maxCostUsdSoft, "maxCostUsdSoft", "Soft cost cap");
  if (f.temperature && (isNaN(Number(f.temperature)) || Number(f.temperature) < 0 || Number(f.temperature) > 2))
    errs.temperature = "Temperature must be 0–2";
  if (f.top_p && (isNaN(Number(f.top_p)) || Number(f.top_p) < 0 || Number(f.top_p) > 1))
    errs.top_p = "top_p must be 0–1";
  if (f.min_p && (isNaN(Number(f.min_p)) || Number(f.min_p) < 0 || Number(f.min_p) > 1))
    errs.min_p = "min_p must be 0–1";
  return errs;
}

// ── Settings form state ───────────────────────────────────────────────────────

const DEFAULT_TOOLS = ["bash", "web_fetch", "browser_navigate", "edit", "read", "write"];

interface SettingsForm {
  permissions: Record<string, "allow" | "deny" | "ask">;
  blockedCommands: string;
  isolateEnv: boolean;
  allowedEnvVars: string;
  denyEnvVars: string;
  preToolCall: string;
  postToolCall: string;
  preTurn: string;
  postTurn: string;
  hooksEnabled: boolean;
}

function settingsToForm(s: OragerSettings): SettingsForm {
  const perms: Record<string, "allow" | "deny" | "ask"> = {};
  for (const tool of DEFAULT_TOOLS) {
    perms[tool] = s.permissions?.[tool] ?? "ask";
  }
  // Include any additional tool permissions already in the file
  for (const [tool, val] of Object.entries(s.permissions ?? {})) {
    if (!DEFAULT_TOOLS.includes(tool)) perms[tool] = val;
  }
  return {
    permissions: perms,
    blockedCommands: (s.bashPolicy?.blockedCommands ?? []).join("\n"),
    isolateEnv: s.bashPolicy?.isolateEnv ?? false,
    allowedEnvVars: (s.bashPolicy?.allowedEnvVars ?? []).join(", "),
    denyEnvVars: (s.bashPolicy?.denyEnvVars ?? []).join(", "),
    preToolCall: s.hooks?.PreToolCall ?? "",
    postToolCall: s.hooks?.PostToolCall ?? "",
    preTurn: s.hooks?.PreTurn ?? "",
    postTurn: s.hooks?.PostTurn ?? "",
    hooksEnabled: s.hooksEnabled ?? true,
  };
}

function formToSettings(f: SettingsForm): OragerSettings {
  const lines = (v: string) => v.split("\n").map((l) => l.trim()).filter(Boolean);
  const csv   = (v: string) => v.split(",").map((l) => l.trim()).filter(Boolean);
  return {
    permissions: f.permissions,
    bashPolicy: {
      blockedCommands: lines(f.blockedCommands),
      isolateEnv: f.isolateEnv,
      allowedEnvVars: csv(f.allowedEnvVars),
      denyEnvVars: csv(f.denyEnvVars),
    },
    hooks: {
      PreToolCall:  f.preToolCall  || undefined,
      PostToolCall: f.postToolCall || undefined,
      PreTurn:      f.preTurn      || undefined,
      PostTurn:     f.postTurn     || undefined,
    },
    hooksEnabled: f.hooksEnabled,
  };
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Configuration() {
  const { showToast } = useToast();
  const { models: allModels } = useCachedModels();

  // Config state
  const [cfgForm, setCfgForm] = useState<ConfigForm | null>(null);
  const [cfgErrors, setCfgErrors] = useState<FormErrors>({});
  const [cfgSaving, setCfgSaving] = useState(false);

  // Settings state
  const [setForm, setSetForm] = useState<SettingsForm | null>(null);
  const [setsSaving, setSetsSaving] = useState(false);

  // Webhook test state
  const [webhookTesting, setWebhookTesting] = useState(false);
  const [webhookTestResult, setWebhookTestResult] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"config" | "settings">("config");

  // Load both on mount
  useEffect(() => {
    Promise.all([api.getConfig(), api.getSettings()])
      .then(([cfg, settings]) => {
        setCfgForm(configToForm(cfg ?? {} as OragerUserConfig));
        setSetForm(settingsToForm(settings ?? {} as OragerSettings));
      })
      .catch((err: Error) => showToast(`Failed to load config: ${err.message}`, "error"))
      .finally(() => setLoading(false));
  }, [showToast]);

  // Config save
  const handleSaveConfig = useCallback(async () => {
    if (!cfgForm) return;
    const errs = validateForm(cfgForm);
    setCfgErrors(errs);
    if (Object.keys(errs).length > 0) {
      showToast("Fix validation errors before saving", "error");
      return;
    }
    setCfgSaving(true);
    try {
      const saved = await api.saveConfig(formToConfig(cfgForm));
      setCfgForm(configToForm(saved));
      showToast("Config saved", "success");
    } catch (err) {
      showToast(`Save failed: ${(err as Error).message}`, "error");
    } finally {
      setCfgSaving(false);
    }
  }, [cfgForm, showToast]);

  // Config reset to defaults
  const handleResetConfig = useCallback(async () => {
    try {
      const defaults = await api.getConfigDefaults();
      setCfgForm(configToForm(defaults));
      setCfgErrors({});
      showToast("Form reset to defaults (not saved)", "info");
    } catch (err) {
      showToast(`Failed to load defaults: ${(err as Error).message}`, "error");
    }
  }, [showToast]);

  // Settings save
  const handleSaveSettings = useCallback(async () => {
    if (!setForm) return;
    setSetsSaving(true);
    try {
      const saved = await api.saveSettings(formToSettings(setForm));
      setSetForm(settingsToForm(saved));
      showToast("Settings saved", "success");
    } catch (err) {
      showToast(`Save failed: ${(err as Error).message}`, "error");
    } finally {
      setSetsSaving(false);
    }
  }, [setForm, showToast]);

  const handleWebhookTest = useCallback(async () => {
    if (!cfgForm?.webhookUrl) return;
    setWebhookTesting(true);
    setWebhookTestResult(null);
    try {
      const r = await api.testWebhook(cfgForm.webhookUrl, cfgForm.webhookFormat === "discord" ? "discord" : undefined);
      setWebhookTestResult(r.ok ? `✓ Delivered (HTTP ${r.status})` : `✗ Failed${r.error ? `: ${r.error}` : r.status ? ` (HTTP ${r.status})` : ""}`);
    } catch (err) {
      setWebhookTestResult(`✗ Error: ${(err as Error).message}`);
    } finally {
      setWebhookTesting(false);
    }
  }, [cfgForm?.webhookUrl, cfgForm?.webhookFormat]);

  if (loading) {
    return <div className="placeholder"><p>Loading configuration…</p></div>;
  }

  const f = cfgForm!;
  const upd = <K extends keyof ConfigForm>(key: K) =>
    (val: ConfigForm[K]) => setCfgForm((prev) => prev ? { ...prev, [key]: val } : prev);

  const selectedModelSupportsReasoning =
    allModels.find((m) => m.id === f.model)?.supports_reasoning ?? false;

  const sf = setForm!;
  const updS = <K extends keyof SettingsForm>(key: K) =>
    (val: SettingsForm[K]) => setSetForm((prev) => prev ? { ...prev, [key]: val } : prev);

  return (
    <div>
      {/* Sub-tab bar */}
      <div style={{ display: "flex", gap: 2, marginBottom: 20 }}>
        {(["config", "settings"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setActiveTab(t)}
            className={activeTab === t ? "btn-primary" : "btn-ghost"}
            style={{ textTransform: "capitalize" }}
          >
            {t === "config" ? "Config (~/.orager/config.json)" : "Settings (~/.orager/settings.json)"}
          </button>
        ))}
      </div>

      {/* ── Config form ── */}
      {activeTab === "config" && (
        <>
          <Section title="Models">
            <ModelSelect label="Primary model" value={f.model} onChange={upd("model")} placeholder="Search models…" />
            <MultiModelSelect label="Fallback models" value={f.models} onChange={upd("models")} placeholder="Search to add fallback models…" />
            <ModelSelect label="Vision model" value={f.visionModel} onChange={upd("visionModel")} placeholder="Search vision models…" visionOnly />
          </Section>

          <Section title="Agent Loop">
            <NumberField label="Max turns" value={f.maxTurns} onChange={upd("maxTurns")} min={1} max={200} error={cfgErrors.maxTurns} />
            <NumberField label="Max retries" value={f.maxRetries} onChange={upd("maxRetries")} min={0} max={20} error={cfgErrors.maxRetries} />
            <NumberField label="Timeout (seconds)" value={f.timeoutSec} onChange={upd("timeoutSec")} min={0} error={cfgErrors.timeoutSec} />
          </Section>

          <Section title="Cost Limits">
            <NumberField label="Hard cap (USD)" value={f.maxCostUsd} onChange={upd("maxCostUsd")} min={0} step={0.01} placeholder="0 = unlimited" error={cfgErrors.maxCostUsd} />
            <NumberField label="Soft cap (USD, warns only)" value={f.maxCostUsdSoft} onChange={upd("maxCostUsdSoft")} min={0} step={0.01} error={cfgErrors.maxCostUsdSoft} />
          </Section>

          <Section title="Sampling" defaultOpen={false}>
            <NumberField label="Temperature" value={f.temperature} onChange={upd("temperature")} min={0} max={2} step={0.05} error={cfgErrors.temperature} />
            <NumberField label="top_p" value={f.top_p} onChange={upd("top_p")} min={0} max={1} step={0.05} error={cfgErrors.top_p} />
            <NumberField label="top_k" value={f.top_k} onChange={upd("top_k")} min={0} />
            <NumberField label="frequency_penalty" value={f.frequency_penalty} onChange={upd("frequency_penalty")} min={-2} max={2} step={0.1} />
            <NumberField label="presence_penalty" value={f.presence_penalty} onChange={upd("presence_penalty")} min={-2} max={2} step={0.1} />
            <NumberField label="repetition_penalty" value={f.repetition_penalty} onChange={upd("repetition_penalty")} min={0} max={2} step={0.1} />
            <NumberField label="min_p" value={f.min_p} onChange={upd("min_p")} min={0} max={1} step={0.01} error={cfgErrors.min_p} />
            <NumberField label="Seed (blank = random)" value={f.seed} onChange={upd("seed")} min={0} />
          </Section>

          {selectedModelSupportsReasoning && (
          <Section title="Reasoning" defaultOpen={false}>
            <SelectField
              label="Reasoning effort"
              value={f.reasoningEffort}
              options={[
                { value: "xhigh", label: "xhigh" },
                { value: "high", label: "high" },
                { value: "medium", label: "medium" },
                { value: "low", label: "low" },
                { value: "minimal", label: "minimal" },
                { value: "none", label: "none" },
              ]}
              onChange={upd("reasoningEffort")}
            />
            <NumberField label="Reasoning max tokens" value={f.reasoningMaxTokens} onChange={upd("reasoningMaxTokens")} min={0} />
            <CheckboxField label="Exclude reasoning from context" checked={f.reasoningExclude} onChange={upd("reasoningExclude")} />
          </Section>
          )}

          <Section title="Provider Routing" defaultOpen={false}>
            <ProviderMultiSelect label="Provider order" value={f.providerOrder} onChange={upd("providerOrder")} placeholder="Select preferred providers…" />
            <ProviderMultiSelect label="Provider only" value={f.providerOnly} onChange={upd("providerOnly")} placeholder="Restrict to these providers…" />
            <ProviderMultiSelect label="Provider ignore" value={f.providerIgnore} onChange={upd("providerIgnore")} placeholder="Skip these providers…" />
            <SelectField
              label="Sort strategy"
              value={f.sort}
              options={[
                { value: "price", label: "Price (cheapest first)" },
                { value: "throughput", label: "Throughput (fastest first)" },
                { value: "latency", label: "Latency (lowest first)" },
              ]}
              onChange={upd("sort")}
            />
            <SelectField
              label="Data collection"
              value={f.dataCollection}
              options={[
                { value: "allow", label: "Allow" },
                { value: "deny", label: "Deny" },
              ]}
              onChange={upd("dataCollection")}
            />
            <CheckboxField label="Zero-data retention (ZDR) providers only" checked={f.zdr} onChange={upd("zdr")} />
          </Section>

          <Section title="Context & Summarization" defaultOpen={false}>
            <NumberField label="Summarize at (tokens)" value={f.summarizeAt} onChange={upd("summarizeAt")} min={0} />
            <SummarizeAtHint model={f.model} currentValue={f.summarizeAt} onApply={upd("summarizeAt")} />
            <ModelSelect label="Summarize model" value={f.summarizeModel} onChange={upd("summarizeModel")} placeholder="Leave blank to use primary model" />
            <span style={{ fontSize: 11, color: "var(--text-muted)", marginTop: -4, display: "block" }}>
              A cheaper, fast model (e.g. gemini-flash) is recommended for summarization.
            </span>
            <NumberField label="Keep recent turns after summarize" value={f.summarizeKeepRecentTurns} onChange={upd("summarizeKeepRecentTurns")} min={0} />
          </Section>

          <Section title="Memory" defaultOpen={false}>
            <CheckboxField label="Enable memory" checked={f.memory} onChange={upd("memory")} />
            <TextField label="Memory key" value={f.memoryKey} onChange={upd("memoryKey")} placeholder="agent-id or project name" />
            <NumberField label="Max chars" value={f.memoryMaxChars} onChange={upd("memoryMaxChars")} min={0} />
            <SelectField
              label="Retrieval mode"
              value={f.memoryRetrieval}
              options={[
                { value: "local", label: "Local (FTS)" },
                { value: "embedding", label: "Embedding (cosine)" },
              ]}
              onChange={upd("memoryRetrieval")}
            />
            <ModelSelect label="Embedding model" value={f.memoryEmbeddingModel} onChange={upd("memoryEmbeddingModel")} placeholder="Search embedding models…" />
          </Section>

          <Section title="Ollama (local inference)" defaultOpen={false}>
            <CheckboxField label="Enable Ollama" checked={f.ollamaEnabled} onChange={upd("ollamaEnabled")} />
            <TextField label="Model" value={f.ollamaModel} onChange={upd("ollamaModel")} placeholder="llama3.2" />
            <TextField label="Server URL" value={f.ollamaBaseUrl} onChange={upd("ollamaBaseUrl")} placeholder="http://localhost:11434" full />
          </Section>

          <Section title="OMLS (local RL training)" defaultOpen={false}>
            <CheckboxField label="Enable OMLS" checked={f.omlsEnabled} onChange={upd("omlsEnabled")} />
            <CheckboxField label="Prefer local training" checked={f.omlsLocalEnabled} onChange={upd("omlsLocalEnabled")} />
            <SelectField
              label="Local backend"
              value={f.omlsLocalBackend}
              onChange={upd("omlsLocalBackend")}
              options={[
                { value: "auto", label: "Auto-detect" },
                { value: "mlx", label: "MLX (Apple Silicon)" },
                { value: "llamacpp-cuda", label: "llama.cpp CUDA (NVIDIA)" },
                { value: "llamacpp-cpu", label: "llama.cpp CPU (any hardware)" },
              ]}
            />
            <TextField label="Base model (HuggingFace ID)" value={f.omlsBaseModel} onChange={upd("omlsBaseModel")} placeholder="unsloth/Meta-Llama-3.1-8B-Instruct" full />
          </Section>

          <Section title="Webhooks" defaultOpen={false}>
            <TextField
              label="Webhook URL"
              value={f.webhookUrl}
              onChange={upd("webhookUrl")}
              placeholder="https://discord.com/api/webhooks/…"
            />
            <div style={{ marginTop: 8 }}>
              <label style={{ fontSize: 12, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
                Payload format
              </label>
              <select
                value={f.webhookFormat}
                onChange={(e) => upd("webhookFormat")(e.target.value as "" | "discord")}
                style={{ width: "100%", maxWidth: 220 }}
              >
                <option value="">Raw JSON (default)</option>
                <option value="discord">Discord embed</option>
              </select>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
                {f.webhookFormat === "discord"
                  ? "Shapes the payload as a Discord embed — paste a Discord webhook URL above."
                  : "Posts the raw orager result event JSON to the URL."}
              </div>
            </div>
            {f.webhookUrl && (
              <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 12 }}>
                <button
                  className="btn-ghost"
                  style={{ fontSize: 12, padding: "4px 12px" }}
                  disabled={webhookTesting}
                  onClick={handleWebhookTest}
                >
                  {webhookTesting ? "Sending…" : "Send test payload"}
                </button>
                {webhookTestResult && (
                  <span style={{
                    fontSize: 12,
                    color: webhookTestResult.startsWith("✓") ? "var(--accent)" : "var(--error)",
                  }}>
                    {webhookTestResult}
                  </span>
                )}
              </div>
            )}
          </Section>

          <Section title="Misc" defaultOpen={false}>
            <TextField label="Profile" value={f.profile} onChange={upd("profile")} placeholder="code-review, bug-fix…" />
            <TextField label="Site URL" value={f.siteUrl} onChange={upd("siteUrl")} />
            <TextField label="Site name" value={f.siteName} onChange={upd("siteName")} />
            <TextField label="Sandbox root" value={f.sandboxRoot} onChange={upd("sandboxRoot")} placeholder="/tmp/sandbox" />
            <TagsField label="Required env vars" value={f.requiredEnvVars} onChange={upd("requiredEnvVars")} />
            <CheckboxField label="Plan mode" checked={f.planMode} onChange={upd("planMode")} />
            <CheckboxField label="Inject context" checked={f.injectContext} onChange={upd("injectContext")} />
            <CheckboxField label="Tag tool outputs" checked={f.tagToolOutputs} onChange={upd("tagToolOutputs")} />
            <CheckboxField label="Use finish tool" checked={f.useFinishTool} onChange={upd("useFinishTool")} />
            <CheckboxField label="Enable browser tools" checked={f.enableBrowserTools} onChange={upd("enableBrowserTools")} />
            <CheckboxField label="Track file changes" checked={f.trackFileChanges} onChange={upd("trackFileChanges")} />
          </Section>

          <div className="btn-row">
            <button className="btn-primary" onClick={handleSaveConfig} disabled={cfgSaving}>
              {cfgSaving ? "Saving…" : "Save config.json"}
            </button>
            <button className="btn-ghost" onClick={handleResetConfig} disabled={cfgSaving}>
              Reset to defaults
            </button>
          </div>
        </>
      )}

      {/* ── Settings form ── */}
      {activeTab === "settings" && (
        <>
          <Section title="Tool Permissions">
            <div className="field-full" style={{ overflowX: "auto" }}>
              <table className="perm-table">
                <thead>
                  <tr>
                    <th>Tool</th>
                    <th>Permission</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(sf.permissions).map(([tool, perm]) => (
                    <tr key={tool}>
                      <td>{tool}</td>
                      <td>
                        <select
                          value={perm}
                          onChange={(e) =>
                            updS("permissions")({
                              ...sf.permissions,
                              [tool]: e.target.value as "allow" | "deny" | "ask",
                            })
                          }
                        >
                          <option value="allow">allow</option>
                          <option value="ask">ask</option>
                          <option value="deny">deny</option>
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section title="Bash Policy" defaultOpen={false}>
            <div className="field field-full">
              <label>Blocked commands <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>(one per line)</span></label>
              <textarea
                value={sf.blockedCommands}
                rows={4}
                onChange={(e) => updS("blockedCommands")(e.target.value)}
                placeholder="rm -rf /&#10;dd if=/dev/zero"
              />
            </div>
            <TextField label="Allowed env vars (comma-separated)" value={sf.allowedEnvVars} onChange={updS("allowedEnvVars")} placeholder="PATH, HOME, USER" full />
            <TextField label="Denied env vars (comma-separated)" value={sf.denyEnvVars} onChange={updS("denyEnvVars")} placeholder="AWS_SECRET_ACCESS_KEY" full />
            <CheckboxField label="Isolate environment (strip all env vars not in allowlist)" checked={sf.isolateEnv} onChange={updS("isolateEnv")} />
          </Section>

          <Section title="Lifecycle Hooks" defaultOpen={false}>
            <CheckboxField label="Hooks enabled" checked={sf.hooksEnabled} onChange={updS("hooksEnabled")} />
            <TextField label="PreToolCall" value={sf.preToolCall} onChange={updS("preToolCall")} placeholder="bash /path/to/hook.sh" full />
            <TextField label="PostToolCall" value={sf.postToolCall} onChange={updS("postToolCall")} placeholder="bash /path/to/hook.sh" full />
            <TextField label="PreTurn" value={sf.preTurn} onChange={updS("preTurn")} placeholder="bash /path/to/hook.sh" full />
            <TextField label="PostTurn" value={sf.postTurn} onChange={updS("postTurn")} placeholder="bash /path/to/hook.sh" full />
          </Section>

          <div className="btn-row">
            <button className="btn-primary" onClick={handleSaveSettings} disabled={setsSaving}>
              {setsSaving ? "Saving…" : "Save settings.json"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
