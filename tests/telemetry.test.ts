/**
 * Unit tests for telemetry.ts — initTelemetry.
 *
 * These tests verify the module loads and initialises without throwing
 * when OTEL environment variables are absent. We do NOT test the actual
 * OTEL SDK behaviour (that's the SDK's responsibility).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

describe("initTelemetry", () => {
  const OTEL_VARS = [
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_SERVICE_NAME",
    "OTEL_RESOURCE_ATTRIBUTES",
    "OTEL_SDK_DISABLED",
  ];

  let savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Save and clear all OTEL env vars
    for (const key of OTEL_VARS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    // Restore
    for (const key of OTEL_VARS) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  it("initTelemetry is a function that can be imported", async () => {
    const mod = await import("../src/telemetry.js");
    expect(typeof mod.initTelemetry).toBe("function");
  });

  it("initTelemetry does not throw when no OTEL vars are set", async () => {
    const { initTelemetry } = await import("../src/telemetry.js");
    await initTelemetry();
  });

  it("initTelemetry does not throw when OTEL_SDK_DISABLED=true", async () => {
    process.env.OTEL_SDK_DISABLED = "true";
    const { initTelemetry } = await import("../src/telemetry.js");
    await initTelemetry();
  });
});
