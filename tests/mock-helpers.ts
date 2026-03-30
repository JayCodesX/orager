import type { MockedFunction } from "vitest";

/**
 * Typed identity cast: re-types an imported mock as MockedFunction<T>.
 *
 * Semantically identical to vi.mocked() but works under both vitest and
 * bun's test runner (which omits vi.mocked from its vi shim at runtime).
 *
 * Usage: mocked(someImportedFn).mockResolvedValue(...)
 */
export function mocked<T extends (...args: never[]) => unknown>(fn: T): MockedFunction<T> {
  return fn as unknown as MockedFunction<T>;
}
