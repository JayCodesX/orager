/**
 * Global Vitest setup — runs before every test file.
 *
 * Polyfill: vi.resetModules
 * ──────────────────────────────────────────────────────────────────────────────
 * Bun 1.3.x ships with Vitest 3.x but does not expose `vi.resetModules` as a
 * method on the `vi` object in all environments. This shim adds it back so
 * tests that call it don't throw.
 *
 * Note: vi.mocked() has been replaced project-wide with the typed `mocked()`
 * helper in tests/mock-helpers.ts, which works under both vitest and bun test.
 */
import { vi } from "vitest";

if (typeof vi.resetModules !== "function") {
  // vi.resetModules is similarly absent in some Bun/Vitest combinations.
  // Provide a no-op so tests that call it don't throw.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (vi as any).resetModules = () => {};
}
