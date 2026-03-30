/**
 * Global Vitest setup — runs before every test file.
 *
 * Polyfills: vi.mocked(fn) and vi.resetModules
 * ──────────────────────────────────────────────────────────────────────────────
 * Bun 1.3.x ships with Vitest 3.x but does not expose vi.mocked or
 * vi.resetModules in all environments. These shims add them back.
 */
import { vi } from "vitest";

if (typeof vi.mocked !== "function") {
  // Cast to any to bypass the readonly descriptor / type check
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (vi as any).mocked = <T>(fn: T): T => fn;
}

if (typeof vi.resetModules !== "function") {
  // vi.resetModules is similarly absent in some Bun/Vitest combinations.
  // Provide a no-op so tests that call it don't throw.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (vi as any).resetModules = () => {};
}
