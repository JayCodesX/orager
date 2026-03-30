/**
 * Graceful shutdown: abort in-flight runs, wait for them to complete,
 * flush SQLite WAL, close the HTTP server, then exit.
 */
import http from "node:http";
import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isSqliteMemoryEnabled, closeDb } from "../memory-sqlite.js";
import { stopKeepAlive } from "./lifecycle.js";
import { activeBashPids } from "../tools/bash.js";
import type { DaemonContext } from "./context.js";

const RECOVERY_FILE = join(homedir(), ".orager", "recovery.json");

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
    // Kill orphaned bash subprocesses that kept runs alive past drain timeout
    for (const pid of activeBashPids) {
      try { process.kill(pid, "SIGTERM"); } catch { /* already exited */ }
    }
  } else {
    process.stderr.write("[orager daemon] all runs completed — exiting\n");
  }

  // Write recovery manifest for in-flight runs that couldn't complete gracefully
  if (ctx.activeRuns > 0) {
    try {
      const abandonedRunIds = Array.from(ctx.activeRunControllers.keys());
      const manifest = {
        abandonedAt: new Date().toISOString(),
        activeRunCount: ctx.activeRuns,
        runs: abandonedRunIds.map((runId) => ({ runId, abandonedAt: new Date().toISOString() })),
      };
      mkdirSync(join(homedir(), ".orager"), { recursive: true });
      writeFileSync(RECOVERY_FILE, JSON.stringify(manifest, null, 2), { encoding: "utf8", mode: 0o600 });
    } catch {
      // Non-fatal — recovery manifest write failure must not block shutdown
    }
  }

  // Flush SQLite WAL before exiting so no memory data is lost
  if (isSqliteMemoryEnabled()) closeDb();
  server.close(() => onExit());
}
