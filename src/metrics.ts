/**
 * OTel metrics for orager — 6 named instruments mirroring Claude Code's metric surface.
 *
 * All instruments are lazy-initialised on first use and are no-ops when no
 * MeterProvider has been registered (i.e. when OTEL_EXPORTER_OTLP_ENDPOINT
 * is not set). initTelemetry() registers a MeterProvider automatically when
 * OTEL is configured, so metrics are exported without additional setup.
 *
 * Instruments
 * ───────────
 * orager.tokens.input     Counter   — input tokens per LLM call   (attr: orager.model)
 * orager.tokens.output    Counter   — output tokens per LLM call  (attr: orager.model)
 * orager.tool_calls.total Counter   — total tool invocations      (attr: orager.tool)
 * orager.tool_calls.errors Counter  — error tool invocations      (attr: orager.tool)
 * orager.session.duration_ms Histogram — session wall-clock time  (attr: orager.session.subtype)
 * orager.session.turn_count  Histogram — turns per session        (attr: orager.session.subtype)
 */
import { metrics } from "@opentelemetry/api";
import type { Counter, Histogram } from "@opentelemetry/api";

const METER_NAME = "orager";
const METER_VERSION = "1.0.0";

// ── Lazy instrument handles ───────────────────────────────────────────────────

interface Instruments {
  tokensInput: Counter;
  tokensOutput: Counter;
  toolCalls: Counter;
  toolErrors: Counter;
  sessionDurationMs: Histogram;
  sessionTurnCount: Histogram;
}

let _instruments: Instruments | null = null;

function getInstruments(): Instruments {
  if (_instruments) return _instruments;
  const m = metrics.getMeter(METER_NAME, METER_VERSION);
  _instruments = {
    tokensInput: m.createCounter("orager.tokens.input", {
      description: "Cumulative input tokens consumed per LLM call",
      unit: "{token}",
    }),
    tokensOutput: m.createCounter("orager.tokens.output", {
      description: "Cumulative output tokens generated per LLM call",
      unit: "{token}",
    }),
    toolCalls: m.createCounter("orager.tool_calls.total", {
      description: "Total tool call invocations",
      unit: "{call}",
    }),
    toolErrors: m.createCounter("orager.tool_calls.errors", {
      description: "Tool call invocations that resulted in an error",
      unit: "{call}",
    }),
    sessionDurationMs: m.createHistogram("orager.session.duration_ms", {
      description: "Agent session wall-clock duration",
      unit: "ms",
    }),
    sessionTurnCount: m.createHistogram("orager.session.turn_count", {
      description: "Number of agent turns completed per session",
      unit: "{turn}",
    }),
  };
  return _instruments;
}

// ── Public recording functions ────────────────────────────────────────────────

/**
 * Record input and output token counts for one LLM call.
 * @param inputTokens  Prompt token count from the OpenRouter response.
 * @param outputTokens Completion token count from the OpenRouter response.
 * @param model        The model that generated the response (e.g. "openai/gpt-4o").
 */
export function recordTokens(inputTokens: number, outputTokens: number, model: string): void {
  const inst = getInstruments();
  const attrs = { "orager.model": model };
  inst.tokensInput.add(inputTokens, attrs);
  inst.tokensOutput.add(outputTokens, attrs);
}

/**
 * Record one tool call invocation, optionally marking it as an error.
 * @param toolName The name of the tool that was called.
 * @param isError  Whether the tool returned an error result.
 */
export function recordToolCall(toolName: string, isError: boolean): void {
  const inst = getInstruments();
  const attrs = { "orager.tool": toolName };
  inst.toolCalls.add(1, attrs);
  if (isError) inst.toolErrors.add(1, attrs);
}

/**
 * Record session-level metrics at run completion.
 * @param durationMs Wall-clock duration of the session in milliseconds.
 * @param turnCount  Number of agent turns completed.
 * @param subtype    Result subtype: "success", "error_max_turns", etc.
 */
export function recordSession(durationMs: number, turnCount: number, subtype: string): void {
  const inst = getInstruments();
  const attrs = { "orager.session.subtype": subtype };
  inst.sessionDurationMs.record(durationMs, attrs);
  inst.sessionTurnCount.record(turnCount, attrs);
}

/** @internal Reset cached instruments — for testing only. */
export function _resetInstrumentsForTesting(): void {
  _instruments = null;
}
