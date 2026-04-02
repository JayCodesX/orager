/**
 * Bun test runner preload — polyfills for vi methods that bun's shim omits.
 *
 * Loaded via bunfig.toml [test] preload before any test file runs.
 * vitest loads tests/setup.ts via setupFiles instead (see vitest.config.ts).
 *
 * Bun 1.3.x vi shim exposes: fn, mock, spyOn, restoreAllMocks, resetAllMocks,
 * clearAllMocks, useFakeTimers, useRealTimers, advanceTimersByTime, runAllTimers,
 * getTimerCount, clearAllTimers, isFakeTimers.
 *
 * The following are missing and polyfilled here:
 *   vi.resetModules()    — vitest cache-bust; safe no-op under bun
 *   vi.stubGlobal()      — temporarily replace a global value
 *   vi.unstubAllGlobals() — restore all stubs created with stubGlobal
 *   vi.runAllTimersAsync() — bun has runAllTimers; wrap in a resolved Promise
 *   vi.hoisted()         — vitest compile-time lift; bun hoists vi.mock already,
 *                          so just call the callback immediately
 */
import { vi } from "bun:test";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";

// Redirect SQLite to a per-process temp directory so tests never share state
// and CI runners don't exhaust the WASM heap loading a stale ~/.orager/orager.db.
if (!process.env["ORAGER_DB_PATH"]) {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "orager-test-"));
  process.env["ORAGER_DB_PATH"] = path.join(tmpDir, "test.db");
}

// ── resetModules ──────────────────────────────────────────────────────────────
// Vitest clears the module registry so subsequent imports get fresh instances.
// Under bun test this is a no-op — bun re-evaluates modules per file anyway.
if (typeof vi.resetModules !== "function") {
  (vi as unknown as Record<string, unknown>).resetModules = (): void => {};
}

// ── stubGlobal / unstubAllGlobals ─────────────────────────────────────────────
// Tracks { name, original } so unstubAllGlobals() can restore them.
const _stubbedGlobals: Array<{ name: string; original: unknown }> = [];

if (typeof (vi as unknown as Record<string, unknown>).stubGlobal !== "function") {
  (vi as unknown as Record<string, unknown>).stubGlobal = (name: string, value: unknown): void => {
    _stubbedGlobals.push({ name, original: (globalThis as Record<string, unknown>)[name] });
    (globalThis as Record<string, unknown>)[name] = value;
  };
}

if (typeof (vi as unknown as Record<string, unknown>).unstubAllGlobals !== "function") {
  (vi as unknown as Record<string, unknown>).unstubAllGlobals = (): void => {
    // Restore in reverse order so nested stubs unwind correctly.
    for (let i = _stubbedGlobals.length - 1; i >= 0; i--) {
      const { name, original } = _stubbedGlobals[i]!;
      if (original === undefined) {
        delete (globalThis as Record<string, unknown>)[name];
      } else {
        (globalThis as Record<string, unknown>)[name] = original;
      }
    }
    _stubbedGlobals.length = 0;
  };
}

// ── runAllTimersAsync ─────────────────────────────────────────────────────────
// Vitest's runAllTimersAsync() fires timers AND drains the microtask queue
// between each firing — critical when timers are scheduled by async callbacks
// (e.g. retry loops: callFn → error → await sleep(delay) → next attempt).
//
// Algorithm: repeatedly drain microtasks, then fire pending timers, until
// no timers remain.  Microtask drains let async code run and schedule the
// next setTimeout before we check getTimerCount() again.
if (typeof (vi as unknown as Record<string, unknown>).runAllTimersAsync !== "function") {
  (vi as unknown as Record<string, unknown>).runAllTimersAsync = async (): Promise<void> => {
    const MICROTASK_DRAINS = 6; // ticks between timer batches
    const MAX_ROUNDS = 40;      // guard against infinite loops

    for (let round = 0; round < MAX_ROUNDS; round++) {
      // Drain microtask queue so pending async code can schedule timers.
      for (let i = 0; i < MICROTASK_DRAINS; i++) await Promise.resolve();

      if (vi.getTimerCount() === 0) break;

      // Fire only the timers that exist right now (not ones created during
      // the firing — those will be caught in the next round).
      vi.runOnlyPendingTimers();
    }

    // Final microtask drain to settle any remaining async continuations.
    for (let i = 0; i < MICROTASK_DRAINS; i++) await Promise.resolve();
  };
}

// ── hoisted ───────────────────────────────────────────────────────────────────
// In vitest, vi.hoisted() is a compile-time transform that lifts its callback
// above vi.mock() calls. Bun already hoists vi.mock() at the file level, so
// calling the callback immediately gives the same end-state.
if (typeof (vi as unknown as Record<string, unknown>).hoisted !== "function") {
  (vi as unknown as Record<string, unknown>).hoisted = <T>(fn: () => T): T => fn();
}
