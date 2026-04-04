/**
 * Centralised shutdown-request flag.
 *
 * Both the CLI entry point (index.ts) and the agent loop (loop.ts) import
 * this module. Keeping it separate avoids circular-dependency issues that
 * would arise if loop.ts imported from index.ts or vice versa.
 *
 * Usage:
 *   - index.ts calls requestShutdown() from its SIGINT/SIGTERM handler.
 *   - loop.ts calls isShutdownRequested() at the top of each turn iteration
 *     and breaks cleanly, allowing the finally block to save session state.
 */

let _requested = false;

/** Mark that a graceful shutdown has been requested. */
export function requestShutdown(): void {
  _requested = true;
}

/** Returns true once requestShutdown() has been called. */
export function isShutdownRequested(): boolean {
  return _requested;
}

/** Reset — for testing only. */
export function _resetShutdownForTesting(): void {
  _requested = false;
}
