/**
 * Graceful shutdown: abort in-flight runs, wait for them to complete,
 * flush SQLite WAL, close the HTTP server, then exit.
 */
import http from "node:http";
import { isSqliteMemoryEnabled, closeDb } from "../memory-sqlite.js";
import { stopKeepAlive } from "./lifecycle.js";
import type { DaemonContext } from "./context.js";

/**
 * @param ctx          Shared daemon state
 * @param server       The HTTP server to close
 * @param timeoutMs    How long to wait for active runs to finish before giving up
 * @param onRelease    Async callback to remove PID/port lock files before waiting
 * @param onExit       Called after server.close() — defaults to process.exit(0).
 *                     Pass a no-op in tests to avoid killing the vitest process.
 */
export async function drainAndExit(
  ctx: DaemonContext,
  server: http.Server,
  timeoutMs: number,
  onRelease: () => Promise<void>,
  onExit: () => void = () => process.exit(0),
): Promise<void> {
  ctx.draining = true;
  process.stderr.write(
    `[orager daemon] draining in-flight runs (timeout ${timeoutMs / 1000}s)...\n`,
  );
  stopKeepAlive(ctx);

  // Abort every active run so clients receive a clean error immediately
  for (const controller of ctx.activeRunControllers.values()) {
    controller.abort();
  }

  // Release lock files before waiting so a new daemon can start immediately
  await onRelease();

  const drainStart = Date.now();
  while (ctx.activeRuns > 0 && Date.now() - drainStart < timeoutMs) {
    await new Promise<void>((r) => setTimeout(r, 500));
  }

  if (ctx.activeRuns > 0) {
    process.stderr.write(
      `[orager daemon] drain timeout — ${ctx.activeRuns} run(s) abandoned\n`,
    );
  } else {
    process.stderr.write("[orager daemon] all runs completed — exiting\n");
  }

  // Flush SQLite WAL before exiting so no memory data is lost
  if (isSqliteMemoryEnabled()) closeDb();
  server.close(() => onExit());
}
