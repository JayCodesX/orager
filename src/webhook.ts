/**
 * webhook.ts — Outbound webhook delivery with Discord embed formatting.
 *
 * Extracted from loop-helpers.ts (Sprint 9).
 *
 * Handles:
 *  - Discord embed payload construction from EmitResultEvent
 *  - Retry-with-backoff POST delivery (3 attempts: 0ms, 1s, 3s)
 *  - Optional HMAC-SHA256 request signing via X-Orager-Signature header
 */

import type { EmitResultEvent } from "./types.js";

// ── Discord embed constants ───────────────────────────────────────────────────

const DISCORD_COLOR_SUCCESS     = 5763719;   // 0x57F287 green
const DISCORD_COLOR_ERROR       = 15548997;  // 0xED4245 red
const DISCORD_COLOR_INTERRUPTED = 15105570;  // 0xE67E22 orange

const DISCORD_SUBTYPE_TITLES: Record<EmitResultEvent["subtype"], string> = {
  success:           "✅ orager run complete",
  error_max_turns:   "⏱️ orager: max turns reached",
  error_max_cost:    "💸 orager: cost limit reached",
  error:             "❌ orager run failed",
  error_circuit_open:"⚡ orager: circuit breaker open",
  interrupted:       "⏸️ orager run interrupted",
  error_cancelled:   "🚫 orager run cancelled",
  error_tool_budget: "🛑 orager: tool error budget exceeded",
  error_loop_abort:  "❌ orager: loop aborted",
};

const DISCORD_SUBTYPE_COLORS: Record<EmitResultEvent["subtype"], number> = {
  success:           DISCORD_COLOR_SUCCESS,
  error_max_turns:   DISCORD_COLOR_INTERRUPTED,
  error_max_cost:    DISCORD_COLOR_INTERRUPTED,
  error:             DISCORD_COLOR_ERROR,
  error_circuit_open:DISCORD_COLOR_ERROR,
  interrupted:       DISCORD_COLOR_INTERRUPTED,
  error_cancelled:   DISCORD_COLOR_INTERRUPTED,
  error_tool_budget: DISCORD_COLOR_ERROR,
  error_loop_abort:  DISCORD_COLOR_ERROR,
};

export function formatDiscordPayload(event: EmitResultEvent): unknown {
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    { name: "Status",     value: event.subtype,                           inline: true },
    { name: "Cost",       value: `$${event.total_cost_usd.toFixed(4)}`,   inline: true },
  ];
  if (event.turnCount !== undefined) {
    fields.push({ name: "Turns", value: String(event.turnCount), inline: true });
  }
  fields.push({ name: "Session", value: event.session_id.slice(0, 16) + "…", inline: true });
  if (event.result) {
    fields.push({ name: "Result", value: event.result.slice(0, 1024) });
  }
  if (event.filesChanged && event.filesChanged.length > 0) {
    fields.push({ name: "Files Changed", value: event.filesChanged.slice(0, 10).join("\n") });
  }
  return {
    embeds: [{
      title:     DISCORD_SUBTYPE_TITLES[event.subtype] ?? "orager result",
      color:     DISCORD_SUBTYPE_COLORS[event.subtype] ?? DISCORD_COLOR_INTERRUPTED,
      fields,
      footer:    { text: "orager" },
      timestamp: new Date().toISOString(),
    }],
  };
}

/**
 * Post a webhook payload, retrying on 5xx/429. Returns null on success, or an
 * error message string if delivery permanently failed (all retries exhausted or
 * a non-retriable 4xx). Callers should emit a warn event on non-null returns so
 * the failure is visible in the event stream, not only on stderr.
 *
 * When `secret` is provided, adds an `X-Orager-Signature: sha256=<hex>` header
 * computed as HMAC-SHA256(secret, rawBody). Receivers should verify this to
 * confirm the payload originated from orager and was not tampered with.
 */
export async function postWebhook(url: string, payload: unknown, format?: "discord", secret?: string): Promise<string | null> {
  const body = format === "discord" && payload !== null && typeof payload === "object" && "type" in (payload as object) && (payload as { type: string }).type === "result"
    ? formatDiscordPayload(payload as EmitResultEvent)
    : payload;
  const bodyStr = JSON.stringify(body);

  // Compute HMAC-SHA256 signature when a secret is configured
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret) {
    const { createHmac } = await import("node:crypto");
    const sig = createHmac("sha256", secret).update(bodyStr, "utf8").digest("hex");
    headers["X-Orager-Signature"] = `sha256=${sig}`;
  }

  // Retry up to 3 attempts with delays: 0ms, 1000ms, 3000ms
  const delays = [0, 1000, 3000];
  let lastErr: unknown;
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt]! > 0) {
      await new Promise<void>((r) => setTimeout(r, delays[attempt]));
    }
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: bodyStr,
        signal: AbortSignal.timeout(10_000),
      });
      // Do not retry on 4xx (except 429) — these are permanent failures
      if (res.ok) return null;
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        continue; // retry
      }
      // 4xx other than 429 — permanent failure, no retry
      return `webhook returned HTTP ${res.status}`;
    } catch (err) {
      lastErr = err; // network error — retry
    }
  }
  // All retries exhausted
  const msg = `webhook delivery failed after ${delays.length} attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`;
  process.stderr.write(`[orager] WARNING: ${msg} (url: ${url})\n`);
  return msg;
}
