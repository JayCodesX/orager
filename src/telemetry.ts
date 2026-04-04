/**
 * Optional OpenTelemetry tracing for orager.
 *
 * Activated when OTEL_EXPORTER_OTLP_ENDPOINT is set (standard OTEL env var).
 * Exports traces via OTLP/HTTP to any compatible collector
 * (Jaeger, Honeycomb, Datadog, Grafana Tempo, etc.).
 *
 * When OTEL is not configured, all helpers are no-ops so there is zero
 * overhead and no mandatory dependency on the SDK at runtime.
 *
 * A SpanBuffer ring buffer (max 2000 spans) is always populated by withSpan()
 * regardless of OTEL configuration. The orager UI server reads from it to
 * render the Telemetry tab without requiring an external collector.
 */
import crypto from "node:crypto";
import { trace, context as otelContext, SpanStatusCode, type Span, type Tracer } from "@opentelemetry/api";

export const TRACER_NAME = "orager";

// ── In-process span buffer (for UI telemetry tab) ─────────────────────────────

export interface BufferedSpan {
  traceId: string;
  spanId: string;
  /** Set when this span is a child of another span (e.g. sub-agent inside agent_loop). */
  parentSpanId?: string;
  name: string;
  startTimeMs: number;
  endTimeMs: number;
  durationMs: number;
  attributes: Record<string, string | number | boolean>;
  status: "ok" | "error" | "unset";
  errorMessage?: string;
}

const BUFFER_MAX = 2000;

class SpanBuffer {
  private readonly spans: BufferedSpan[] = [];

  push(span: BufferedSpan): void {
    if (this.spans.length >= BUFFER_MAX) this.spans.shift();
    this.spans.push(span);
  }

  getAll(): BufferedSpan[] { return [...this.spans]; }
  get size(): number { return this.spans.length; }
  get max(): number { return BUFFER_MAX; }
}

const _spanBuffer = new SpanBuffer();

export function getSpanBuffer(): SpanBuffer { return _spanBuffer; }

// ── Tracer ────────────────────────────────────────────────────────────────────

let _tracer: Tracer | null = null;
let _shutdownSdk: (() => Promise<void>) | null = null;
// Guard against multiple initTelemetry() calls (e.g. daemon restart loops)
let _sdkInitialized = false;

/**
 * Initialize the OTEL SDK. Call once at process start (CLI entry point / daemon start).
 *
 * Activation priority (first match wins):
 *   1. `telemetryConfig.enabled === false` → always disabled (explicit opt-out)
 *   2. `telemetryConfig.enabled === true` + `telemetryConfig.endpoint` → use that endpoint
 *   3. `OTEL_EXPORTER_OTLP_ENDPOINT` env var set → use env var (legacy / CI)
 *   4. No config and no env var → no-op
 *
 * Idempotent — safe to call more than once.
 */
export async function initTelemetry(
  serviceName = "orager",
  telemetryConfig?: { enabled?: boolean; endpoint?: string },
): Promise<void> {
  // Explicit opt-out wins over everything
  if (telemetryConfig?.enabled === false) return;

  // Determine endpoint: settings file > env var
  const endpoint = telemetryConfig?.endpoint ?? process.env["OTEL_EXPORTER_OTLP_ENDPOINT"];

  // If enabled is not explicitly true, require an endpoint to be configured
  if (!telemetryConfig?.enabled && !endpoint) return;

  // If enabled=true but no endpoint, warn and bail
  if (telemetryConfig?.enabled && !endpoint) {
    process.stderr.write(
      `[orager] WARNING: telemetry.enabled=true but no endpoint configured.\n` +
      `[orager] Set telemetry.endpoint in settings.json or OTEL_EXPORTER_OTLP_ENDPOINT env var.\n`,
    );
    return;
  }

  if (_sdkInitialized) return; // prevent duplicate SDK + SIGTERM handler registration
  _sdkInitialized = true;

  try {
    // Dynamic import so the SDK is only loaded when OTEL is configured.
    const { NodeSDK } = await import("@opentelemetry/sdk-node");
    const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");

    // Build the NodeSDK config. Metrics export is wired up when the packages
    // are available (they are bundled with @opentelemetry/sdk-node).
    // Use a plain object cast rather than inferring from the constructor signature
    // (Parameters<typeof NodeSDK.prototype.constructor> resolves to `Function`
    // in some TS / SDK version combinations and causes a type error).
    // If endpoint comes from settings.json, set the env var so the OTLP exporter picks it up.
    // The OTLP exporter reads OTEL_EXPORTER_OTLP_ENDPOINT by convention.
    if (endpoint && !process.env["OTEL_EXPORTER_OTLP_ENDPOINT"]) {
      process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] = endpoint;
    }

    const sdkConfig: Record<string, unknown> = {
      traceExporter: new OTLPTraceExporter(),
      serviceName,
    };

    // Attempt to add a periodic OTLP metrics reader. The exporter and metric SDK
    // are bundled with sdk-node, so dynamic import should always succeed.
    try {
      const { OTLPMetricExporter } = await import("@opentelemetry/exporter-metrics-otlp-http");
      const { PeriodicExportingMetricReader } = await import("@opentelemetry/sdk-metrics");
      (sdkConfig as Record<string, unknown>)["metricReader"] = new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
        // Export every 30 seconds — balances freshness vs. request overhead.
        exportIntervalMillis: 10_000,
      });
    } catch {
      // Metrics exporter not available — traces still work.
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sdk = new NodeSDK(sdkConfig as any);
    sdk.start();
    _tracer = trace.getTracer(TRACER_NAME);
    // Flush both traces and metrics on clean exit.
    _shutdownSdk = async () => { try { await sdk.shutdown(); } catch { /* */ } };
    process.on("beforeExit", _shutdownSdk);
    // Note: SIGTERM shutdown is handled by the CLI entry point (index.ts) via
    // flushTelemetry(). No separate SIGTERM handler registered here to avoid
    // double process.exit() calls.
  } catch (err) {
    // OTEL init failure must never crash the agent
    console.error("[orager] OpenTelemetry init failed:", err);
  }
}

/**
 * Get the active tracer. Returns the no-op tracer if OTEL is not configured.
 */
export function getTracer(): Tracer {
  return _tracer ?? trace.getTracer(TRACER_NAME);
}

/**
 * Start a span and run `fn` inside it. Records exceptions automatically.
 * Returns fn's result. If OTEL is not configured, just runs fn.
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = getTracer();
  const startTimeMs = Date.now();

  // Capture the parent span ID before entering the new span's context.
  const parentSpanId = (() => {
    const parentCtx = trace.getSpanContext(otelContext.active());
    const isRealId = (id: string) => /^[1-9a-f][0-9a-f]*$/.test(id);
    return parentCtx && isRealId(parentCtx.spanId) ? parentCtx.spanId : undefined;
  })();

  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    let status: BufferedSpan["status"] = "unset";
    let errorMessage: string | undefined;
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      status = "ok";
      return result;
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      status = "error";
      errorMessage = String(err);
      throw err;
    } finally {
      span.end();
      const endTimeMs = Date.now();
      const ctx = span.spanContext();
      // Use real OTel IDs when available; fall back to random for no-op spans.
      const isRealId = (id: string) => /^[1-9a-f][0-9a-f]*$/.test(id);
      _spanBuffer.push({
        traceId:      isRealId(ctx.traceId) ? ctx.traceId : crypto.randomUUID().replace(/-/g, ""),
        spanId:       isRealId(ctx.spanId)  ? ctx.spanId  : crypto.randomBytes(8).toString("hex"),
        parentSpanId,
        name,
        startTimeMs,
        endTimeMs,
        durationMs:   endTimeMs - startTimeMs,
        attributes,
        status,
        errorMessage,
      });
    }
  });
}

/** Attach key-value attributes to the current active span (if any). */
export function spanSetAttributes(attrs: Record<string, string | number | boolean>): void {
  const span = trace.getActiveSpan();
  if (span) span.setAttributes(attrs);
}

/**
 * Flush pending OTel spans and metrics. Call before process.exit() to ensure
 * no telemetry is lost on SIGTERM or other clean shutdowns.
 * No-op when OTEL is not configured.
 */
export async function flushTelemetry(): Promise<void> {
  if (_shutdownSdk) await _shutdownSdk();
}
