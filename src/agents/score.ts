/**
 * Agent score tracking — per-run recording and aggregate stats.
 *
 * Every spawn_agent / Agent tool invocation records a row in `agent_scores`
 * in the agents registry DB. Aggregate stats (success rate, avg cost, avg
 * turns) are computed on read.
 *
 * Schema lives in registry.ts migrations so the DB is always open by the
 * time score functions are called.
 */

import type { SqliteDatabase } from "../native-sqlite.js";
import type { AgentStats } from "../types.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ScoreRecord {
  agentId: string;
  sessionId?: string | null;
  success: boolean;
  turns: number;
  costUsd: number;
  durationMs: number;
}

// ── Write ─────────────────────────────────────────────────────────────────────

/**
 * Record a single agent run result. Call this after every spawn_agent /
 * Agent tool execution, regardless of success or failure.
 *
 * Never throws — score recording is best-effort and must not affect the
 * parent run if the DB is unavailable.
 */
export function recordAgentScore(
  db: SqliteDatabase,
  record: ScoreRecord,
): void {
  try {
    db.prepare(
      `INSERT INTO agent_scores
         (agent_id, session_id, success, turns, cost_usd, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      record.agentId,
      record.sessionId ?? null,
      record.success ? 1 : 0,
      record.turns,
      record.costUsd,
      record.durationMs,
    );
  } catch {
    // Non-fatal — never surface DB errors to the agent run
  }
}

// ── Read ──────────────────────────────────────────────────────────────────────

/**
 * Aggregate stats for a single agent.
 * Returns null if the agent has no recorded runs.
 */
export function getAgentStats(
  db: SqliteDatabase,
  agentId: string,
): AgentStats | null {
  const row = db.prepare(
    `SELECT
       COUNT(*)                                             AS total_runs,
       SUM(success)                                        AS success_runs,
       ROUND(AVG(turns), 2)                                AS avg_turns,
       ROUND(AVG(cost_usd), 6)                             AS avg_cost_usd,
       ROUND(SUM(cost_usd), 6)                             AS total_cost_usd,
       ROUND(AVG(duration_ms))                             AS avg_duration_ms,
       MAX(recorded_at)                                    AS last_used_at
     FROM agent_scores
     WHERE agent_id = ?`,
  ).get(agentId) as {
    total_runs: number;
    success_runs: number;
    avg_turns: number;
    avg_cost_usd: number;
    total_cost_usd: number;
    avg_duration_ms: number;
    last_used_at: string | null;
  } | undefined;

  if (!row || row.total_runs === 0) return null;

  return {
    agentId,
    totalRuns: row.total_runs,
    successRuns: row.success_runs ?? 0,
    successRate: row.total_runs > 0
      ? Math.round((row.success_runs / row.total_runs) * 100) / 100
      : 0,
    avgTurns: row.avg_turns ?? 0,
    avgCostUsd: row.avg_cost_usd ?? 0,
    totalCostUsd: row.total_cost_usd ?? 0,
    avgDurationMs: row.avg_duration_ms ?? 0,
    lastUsedAt: row.last_used_at,
  };
}

/**
 * Aggregate stats for all agents that have recorded runs.
 * Returns a map keyed by agentId.
 */
export function getAllAgentStats(
  db: SqliteDatabase,
): Record<string, AgentStats> {
  const rows = db.prepare(
    `SELECT
       agent_id,
       COUNT(*)              AS total_runs,
       SUM(success)          AS success_runs,
       ROUND(AVG(turns), 2)  AS avg_turns,
       ROUND(AVG(cost_usd), 6) AS avg_cost_usd,
       ROUND(SUM(cost_usd), 6) AS total_cost_usd,
       ROUND(AVG(duration_ms)) AS avg_duration_ms,
       MAX(recorded_at)      AS last_used_at
     FROM agent_scores
     GROUP BY agent_id
     ORDER BY total_runs DESC`,
  ).all() as Array<{
    agent_id: string;
    total_runs: number;
    success_runs: number;
    avg_turns: number;
    avg_cost_usd: number;
    total_cost_usd: number;
    avg_duration_ms: number;
    last_used_at: string | null;
  }>;

  const result: Record<string, AgentStats> = {};
  for (const row of rows) {
    result[row.agent_id] = {
      agentId: row.agent_id,
      totalRuns: row.total_runs,
      successRuns: row.success_runs ?? 0,
      successRate: row.total_runs > 0
        ? Math.round((row.success_runs / row.total_runs) * 100) / 100
        : 0,
      avgTurns: row.avg_turns ?? 0,
      avgCostUsd: row.avg_cost_usd ?? 0,
      totalCostUsd: row.total_cost_usd ?? 0,
      avgDurationMs: row.avg_duration_ms ?? 0,
      lastUsedAt: row.last_used_at,
    };
  }
  return result;
}

/**
 * Delete all score records for a given agent (e.g. when removing from catalog).
 */
export function deleteAgentScores(db: SqliteDatabase, agentId: string): void {
  try {
    db.prepare("DELETE FROM agent_scores WHERE agent_id = ?").run(agentId);
  } catch {
    /* best effort */
  }
}

/**
 * Prune score records older than `keepDays` for a given agent (or all agents
 * if agentId is null). Prevents unbounded growth.
 */
export function pruneOldScores(
  db: SqliteDatabase,
  keepDays: number,
  agentId?: string,
): void {
  try {
    if (agentId) {
      db.prepare(
        `DELETE FROM agent_scores
         WHERE agent_id = ?
           AND recorded_at < datetime('now', ?)`,
      ).run(agentId, `-${keepDays} days`);
    } else {
      db.prepare(
        `DELETE FROM agent_scores
         WHERE recorded_at < datetime('now', ?)`,
      ).run(`-${keepDays} days`);
    }
  } catch {
    /* best effort */
  }
}
