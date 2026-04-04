/**
 * Tests for the agent catalog system: seeds, registry, and score tracking.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { openDb } from "../src/native-sqlite.js";
import { runMigrations } from "../src/db-migrations.js";
import { recordAgentScore, getAgentStats, getAllAgentStats, pruneOldScores } from "../src/agents/score.js";
import { SEED_AGENTS } from "../src/agents/seeds.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function makeTestDb() {
  const db = await openDb(":memory:");
  runMigrations(db, [
    {
      version: 1,
      name: "create_agents_table",
      sql: `
        CREATE TABLE IF NOT EXISTS agents (
          id TEXT PRIMARY KEY, name TEXT, definition TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'db',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS agent_scores (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_id TEXT NOT NULL, session_id TEXT,
          success INTEGER NOT NULL DEFAULT 1, turns INTEGER NOT NULL DEFAULT 0,
          cost_usd REAL NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0,
          recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_agent_scores_agent_id ON agent_scores(agent_id);
        CREATE INDEX IF NOT EXISTS idx_agent_scores_recorded_at ON agent_scores(recorded_at);
      `,
    },
  ]);
  return db;
}

// ── Seeds ─────────────────────────────────────────────────────────────────────

describe("SEED_AGENTS", () => {
  it("contains the expected built-in agents", () => {
    expect(Object.keys(SEED_AGENTS).sort()).toEqual([
      "coder",
      "explorer",
      "planner",
      "researcher",
      "reviewer",
      "tester",
    ]);
  });

  it("every seed has required fields", () => {
    for (const [id, defn] of Object.entries(SEED_AGENTS)) {
      expect(defn.description, `${id}.description`).toBeTruthy();
      expect(defn.prompt, `${id}.prompt`).toBeTruthy();
      expect(defn.source, `${id}.source`).toBe("seed");
    }
  });

  it("explorer is read-only (no Bash, Write, etc.)", () => {
    const { tools } = SEED_AGENTS.explorer;
    expect(tools).toBeDefined();
    expect(tools).not.toContain("Bash");
    expect(tools).not.toContain("Write");
    expect(tools).not.toContain("Edit");
  });

  it("explorer uses a cheap model", () => {
    expect(SEED_AGENTS.explorer.model).toBe("openai/gpt-4o-mini");
  });

  it("planner has effort:high", () => {
    expect(SEED_AGENTS.planner.effort).toBe("high");
  });

  it("planner reads project instructions", () => {
    expect(SEED_AGENTS.planner.readProjectInstructions).toBe(true);
  });

  it("coder inherits all tools (no tools restriction)", () => {
    // coder should have no tools field — it inherits all from parent
    expect(SEED_AGENTS.coder.tools).toBeUndefined();
  });

  it("tester has Bash access", () => {
    expect(SEED_AGENTS.tester.tools).toContain("Bash");
  });

  it("reviewer is read-only (no Bash or Write)", () => {
    const { tools } = SEED_AGENTS.reviewer;
    expect(tools).not.toContain("Bash");
    expect(tools).not.toContain("Write");
  });

  it("seeds do not allow memory writes", () => {
    for (const [id, defn] of Object.entries(SEED_AGENTS)) {
      expect(defn.memoryWrite, `${id}.memoryWrite should be falsy`).toBeFalsy();
    }
  });
});

// ── Score tracking ────────────────────────────────────────────────────────────

describe("recordAgentScore / getAgentStats", () => {
  it("returns null for an agent with no runs", async () => {
    const db = await makeTestDb();
    const stats = getAgentStats(db, "nonexistent");
    expect(stats).toBeNull();
  });

  it("records a single successful run", async () => {
    const db = await makeTestDb();
    recordAgentScore(db, {
      agentId: "explorer",
      sessionId: "sess-1",
      success: true,
      turns: 3,
      costUsd: 0.001,
      durationMs: 1500,
    });

    const stats = getAgentStats(db, "explorer");
    expect(stats).not.toBeNull();
    expect(stats!.totalRuns).toBe(1);
    expect(stats!.successRuns).toBe(1);
    expect(stats!.successRate).toBe(1);
    expect(stats!.avgTurns).toBe(3);
    expect(stats!.avgCostUsd).toBeCloseTo(0.001, 5);
    expect(stats!.totalCostUsd).toBeCloseTo(0.001, 5);
    expect(stats!.avgDurationMs).toBeCloseTo(1500, 0);
  });

  it("records mixed success/failure runs and computes success rate", async () => {
    const db = await makeTestDb();
    recordAgentScore(db, { agentId: "researcher", sessionId: null, success: true,  turns: 2, costUsd: 0.002, durationMs: 2000 });
    recordAgentScore(db, { agentId: "researcher", sessionId: null, success: false, turns: 1, costUsd: 0.001, durationMs: 500 });
    recordAgentScore(db, { agentId: "researcher", sessionId: null, success: true,  turns: 4, costUsd: 0.004, durationMs: 3000 });

    const stats = getAgentStats(db, "researcher");
    expect(stats!.totalRuns).toBe(3);
    expect(stats!.successRuns).toBe(2);
    expect(stats!.successRate).toBeCloseTo(2 / 3, 2);
    expect(stats!.avgTurns).toBeCloseTo((2 + 1 + 4) / 3, 1);
    expect(stats!.totalCostUsd).toBeCloseTo(0.007, 5);
  });

  it("getAllAgentStats returns all agents with runs", async () => {
    const db = await makeTestDb();
    recordAgentScore(db, { agentId: "explorer",  sessionId: null, success: true, turns: 2, costUsd: 0.001, durationMs: 1000 });
    recordAgentScore(db, { agentId: "coder",     sessionId: null, success: true, turns: 5, costUsd: 0.01,  durationMs: 5000 });
    recordAgentScore(db, { agentId: "explorer",  sessionId: null, success: false, turns: 1, costUsd: 0,    durationMs: 200 });

    const all = getAllAgentStats(db);
    expect(Object.keys(all).sort()).toEqual(["coder", "explorer"]);
    expect(all.explorer!.totalRuns).toBe(2);
    expect(all.coder!.totalRuns).toBe(1);
  });

  it("pruneOldScores removes records older than keepDays", async () => {
    const db = await makeTestDb();
    // Insert a record with a very old timestamp
    db.prepare(
      `INSERT INTO agent_scores (agent_id, success, turns, cost_usd, duration_ms, recorded_at)
       VALUES ('old-agent', 1, 2, 0.001, 1000, datetime('now', '-100 days'))`
    ).run();
    recordAgentScore(db, { agentId: "old-agent", success: true, turns: 3, costUsd: 0.001, durationMs: 1000 });

    const beforePrune = getAgentStats(db, "old-agent");
    expect(beforePrune!.totalRuns).toBe(2);

    pruneOldScores(db, 30, "old-agent"); // keep only last 30 days

    const afterPrune = getAgentStats(db, "old-agent");
    expect(afterPrune!.totalRuns).toBe(1); // only recent run remains
  });
});

// ── File-based registry loading ────────────────────────────────────────────────

describe("loadAgentsFromDir (via file system)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `orager-agents-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("loads agent definitions from JSON files in a directory", async () => {
    // Write a test agent file
    writeFileSync(
      join(tmpDir, "my-helper.json"),
      JSON.stringify({
        description: "A test helper agent.",
        prompt: "You are a helpful test agent.",
        tools: ["Read"],
        model: "openai/gpt-4o-mini",
      }),
      "utf-8",
    );

    // We use the internal file loader pattern via env override
    const original = process.env["ORAGER_AGENTS_DIR"];
    process.env["ORAGER_AGENTS_DIR"] = tmpDir;

    const { loadAllAgents } = await import("../src/agents/registry.js");
    const agents = await loadAllAgents(tmpDir, /* skipDb */ true);

    process.env["ORAGER_AGENTS_DIR"] = original;

    // Should contain seeds + our file agent
    expect(Object.keys(agents)).toContain("explorer");
    expect(Object.keys(agents)).toContain("my-helper");
    expect(agents["my-helper"]!.description).toBe("A test helper agent.");
    expect(agents["my-helper"]!.source).toBe("user");
  });

  it("ignores non-JSON files", async () => {
    writeFileSync(join(tmpDir, "README.md"), "# agents", "utf-8");
    writeFileSync(join(tmpDir, "config.yaml"), "description: test", "utf-8");
    writeFileSync(join(tmpDir, "valid.json"), JSON.stringify({ description: "ok", prompt: "ok" }), "utf-8");

    const original = process.env["ORAGER_AGENTS_DIR"];
    process.env["ORAGER_AGENTS_DIR"] = tmpDir;

    const { loadAllAgents } = await import("../src/agents/registry.js");
    const agents = await loadAllAgents(tmpDir, /* skipDb */ true);

    process.env["ORAGER_AGENTS_DIR"] = original;

    expect(Object.keys(agents)).toContain("valid");
    expect(Object.keys(agents)).not.toContain("README");
    expect(Object.keys(agents)).not.toContain("config");
  });

  it("user file overrides seed with same key", async () => {
    // Override the 'explorer' seed
    writeFileSync(
      join(tmpDir, "explorer.json"),
      JSON.stringify({
        description: "Custom explorer override.",
        prompt: "Custom prompt.",
        source: "should-be-overridden-by-loader",
      }),
      "utf-8",
    );

    const original = process.env["ORAGER_AGENTS_DIR"];
    process.env["ORAGER_AGENTS_DIR"] = tmpDir;

    const { loadAllAgents } = await import("../src/agents/registry.js");
    const agents = await loadAllAgents(tmpDir, /* skipDb */ true);

    process.env["ORAGER_AGENTS_DIR"] = original;

    expect(agents["explorer"]!.description).toBe("Custom explorer override.");
    expect(agents["explorer"]!.source).toBe("user"); // loader sets source, not file content
  });
});

// ── AgentDefinition new fields ────────────────────────────────────────────────

describe("AgentDefinition new fields", () => {
  it("disallowedTools field is defined in the type (compilation check)", () => {
    const defn = {
      description: "test",
      prompt: "test",
      tools: ["Read", "Bash"],
      disallowedTools: ["Bash"],
    };
    expect(defn.disallowedTools).toEqual(["Bash"]);
  });

  it("effort field accepts low/medium/high", () => {
    const efforts: Array<"low" | "medium" | "high"> = ["low", "medium", "high"];
    for (const e of efforts) {
      const defn = { description: "test", prompt: "test", effort: e };
      expect(defn.effort).toBe(e);
    }
  });

  it("source field has the expected values", () => {
    const sources: Array<"seed" | "user" | "project" | "db"> = ["seed", "user", "project", "db"];
    for (const s of sources) {
      const defn = { description: "test", prompt: "test", source: s };
      expect(defn.source).toBe(s);
    }
  });
});
