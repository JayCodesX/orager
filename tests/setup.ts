/**
 * Global Vitest setup — runs before every test file.
 *
 * Polyfill: vi.mocked(fn) → fn
 * ──────────────────────────────────────────────────────────────────────────────
 * Bun 1.3.x ships with Vitest 3.x but does not expose `vi.mocked` as a method
 * on the `vi` object (it's typed in @types/vitest but the runtime shim omits
 * it). `vi.mocked(fn)` is a pure TypeScript cast helper — it returns the same
 * value it receives, typed as a `MockedFunction`. At runtime its only job is
 * to satisfy type-checkers; the underlying mock was already created by vi.fn().
 *
 * This shim adds the method back so all existing tests that call
 * `vi.mocked(someImport).mockResolvedValueOnce(...)` continue to work
 * without modifying any individual test file.
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
