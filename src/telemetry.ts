/**
 * Optional OpenTelemetry tracing for orager.
 *
 * Activated when OTEL_EXPORTER_OTLP_ENDPOINT is set (standard OTEL env var).
 * Exports traces via OTLP/HTTP to any compatible collector
 * (Jaeger, Honeycomb, Datadog, Grafana Tempo, etc.).
 *
 * When OTEL is not configured, all helpers are no-ops so there is zero
 * overhead and no mandatory dependency on the SDK at runtime.
 */
import { trace, SpanStatusCode, type Span, type Tracer } from "@opentelemetry/api";

export const TRACER_NAME = "orager";

let _tracer: Tracer | null = null;

/**
 * Initialize the OTEL SDK. Call once at process start (CLI entry point / daemon start).
 * No-op if OTEL_EXPORTER_OTLP_ENDPOINT is not set.
 */
export async function initTelemetry(serviceName = "orager"): Promise<void> {
  if (!process.env["OTEL_EXPORTER_OTLP_ENDPOINT"]) return;

  try {
    // Dynamic import so the SDK is only loaded when OTEL is configured
    const { NodeSDK } = await import("@opentelemetry/sdk-node");
    const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");

    const sdk = new NodeSDK({
      traceExporter: new OTLPTraceExporter(),
      serviceName,
    });
    sdk.start();
    _tracer = trace.getTracer(TRACER_NAME);
    // Flush traces on clean exit
    process.on("beforeExit", async () => { try { await sdk.shutdown(); } catch { /* */ } });
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
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      span.end();
    }
  });
}

/** Attach key-value attributes to the current active span (if any). */
export function spanSetAttributes(attrs: Record<string, string | number | boolean>): void {
  const span = trace.getActiveSpan();
  if (span) span.setAttributes(attrs);
}
