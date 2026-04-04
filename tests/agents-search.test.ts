/**
 * Tests for agent semantic search (embedding + FTS pipeline).
 * Uses in-memory SQLite — no disk I/O.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { openDb } from "../src/native-sqlite.js";
import { runMigrations } from "../src/db-migrations.js";
import type { SqliteDatabase } from "../src/native-sqlite.js";
import {
  embeddingToBlob,
  blobToEmbedding,
  ftsUpsertAgent,
  ftsDeleteAgent,
  retrieveAgentsByEmbedding,
  computeAndStoreAgentEmbedding,
} from "../src/agents/search.js";

// ── Test DB setup ─────────────────────────────────────────────────────────────

const TEST_MIGRATIONS = [
  {
    version: 1,
    name: "create_agents_table",
    sql: `
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY, name TEXT, definition TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'db',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        embedding BLOB, embedding_model TEXT
      );
      CREATE TABLE IF NOT EXISTS agent_scores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL, session_id TEXT,
        success INTEGER NOT NULL DEFAULT 1, turns INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0,
        recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS _agents_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS agents_fts USING fts5(agent_id UNINDEXED, content);
    `,
  },
];

async function makeTestDb(): Promise<SqliteDatabase> {
  const db = await openDb(":memory:");
  runMigrations(db, TEST_MIGRATIONS);
  return db;
}

function insertAgent(
  db: SqliteDatabase,
  id: string,
  description: string,
  embedding?: number[],
): void {
  const definition = JSON.stringify({ description, prompt: `You are ${id}.` });
  const blob = embedding ? embeddingToBlob(embedding) : null;
  db.prepare(
    `INSERT INTO agents (id, name, definition, embedding, embedding_model)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, id, definition, blob, embedding ? "test" : null);
}

// Simple deterministic vector for testing (not real embeddings)
function makeVec(seed: number, dim = 4): number[] {
  const v = Array.from({ length: dim }, (_, i) => Math.sin(seed + i));
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

// ── embeddingToBlob / blobToEmbedding round-trip ──────────────────────────────

describe("embeddingToBlob / blobToEmbedding", () => {
  it("round-trips a float32 vector", () => {
    const original = [0.1, 0.5, -0.3, 0.9, 0.0];
    const blob = embeddingToBlob(original);
    const restored = blobToEmbedding(blob);
    expect(restored).not.toBeNull();
    for (let i = 0; i < original.length; i++) {
      expect(restored![i]).toBeCloseTo(original[i]!, 5);
    }
  });

  it("returns null for empty buffer", () => {
    expect(blobToEmbedding(new Uint8Array(0))).toBeNull();
    expect(blobToEmbedding(null)).toBeNull();
    expect(blobToEmbedding(undefined)).toBeNull();
  });
});

// ── FTS helpers ───────────────────────────────────────────────────────────────

describe("ftsUpsertAgent / ftsDeleteAgent", () => {
  it("inserts an FTS entry that can be searched", async () => {
    const db = await makeTestDb();

    ftsUpsertAgent(db, "test-agent", "Test Agent", "Use for testing things.", "You are a tester.");

    const rows = db.prepare(
      "SELECT agent_id FROM agents_fts WHERE agents_fts MATCH 'testing'",
    ).all() as { agent_id: string }[];
    expect(rows.map((r) => r.agent_id)).toContain("test-agent");
  });

  it("replaces FTS entry on re-upsert (no duplicates)", async () => {
    const db = await makeTestDb();

    ftsUpsertAgent(db, "agent-x", "Agent X", "Use for alpha tasks.", "You do alpha.");
    ftsUpsertAgent(db, "agent-x", "Agent X v2", "Use for beta tasks.", "You do beta.");

    const rows = db.prepare(
      "SELECT agent_id FROM agents_fts WHERE agents_fts MATCH 'beta'",
    ).all() as { agent_id: string }[];
    expect(rows.length).toBe(1);
    expect(rows[0]!.agent_id).toBe("agent-x");
  });

  it("removes FTS entry on delete", async () => {
    const db = await makeTestDb();

    ftsUpsertAgent(db, "to-delete", "Delete Me", "Use for deletion.", "You delete.");
    ftsDeleteAgent(db, "to-delete");

    const rows = db.prepare(
      "SELECT agent_id FROM agents_fts WHERE agents_fts MATCH 'deletion'",
    ).all();
    expect(rows.length).toBe(0);
  });
});

// ── retrieveAgentsByEmbedding — cosine brute-force path ───────────────────────

describe("retrieveAgentsByEmbedding (brute-force cosine, no vec0)", () => {
  it("returns empty array when no agents have embeddings", async () => {
    const db = await makeTestDb();
    insertAgent(db, "agent-no-emb", "An agent without an embedding.");

    const query = makeVec(0);
    const results = await retrieveAgentsByEmbedding(db, query);
    expect(results).toEqual([]);
  });

  it("returns agents above threshold sorted by similarity", async () => {
    const db = await makeTestDb();

    // agent-a: very similar to query (seed 0 ≈ seed 0)
    insertAgent(db, "agent-a", "First agent.", makeVec(0));
    // agent-b: less similar (different direction)
    insertAgent(db, "agent-b", "Second agent.", makeVec(10));
    // agent-c: most similar (identical direction to query)
    insertAgent(db, "agent-c", "Third agent.", makeVec(0));

    const query = makeVec(0);
    const results = await retrieveAgentsByEmbedding(db, query, { threshold: 0.0, topK: 3 });

    expect(results.length).toBeGreaterThan(0);
    // agent-a and agent-c should both be returned (identical to query)
    const ids = results.map((r) => r.id);
    expect(ids).toContain("agent-a");
    expect(ids).toContain("agent-c");
    // All should have positive scores
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
    }
    // Results should be sorted descending
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]!.score).toBeGreaterThanOrEqual(results[i]!.score);
    }
  });

  it("filters out agents below threshold", async () => {
    const db = await makeTestDb();

    // Make a query vector and two agents — one very similar, one very different
    const query = makeVec(0, 8);
    insertAgent(db, "similar", "Similar agent.", makeVec(0, 8));
    // Opposite direction → negative cosine → below any positive threshold
    const opposite = makeVec(0, 8).map((x) => -x);
    insertAgent(db, "opposite", "Opposite agent.", opposite);

    const results = await retrieveAgentsByEmbedding(db, query, { threshold: 0.5, topK: 5 });

    const ids = results.map((r) => r.id);
    expect(ids).toContain("similar");
    expect(ids).not.toContain("opposite");
  });

  it("respects topK limit", async () => {
    const db = await makeTestDb();
    const query = makeVec(0);

    // Insert 5 agents all at threshold-crossing similarity
    for (let i = 0; i < 5; i++) {
      insertAgent(db, `agent-${i}`, `Agent ${i}.`, makeVec(0));
    }

    const results = await retrieveAgentsByEmbedding(db, query, { threshold: 0.0, topK: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it("supplements with FTS when queryText provided and ANN/cosine short on results", async () => {
    const db = await makeTestDb();

    // Agent with no embedding but relevant description
    insertAgent(db, "fts-only-agent", "Excellent at rust debugging.");
    ftsUpsertAgent(db, "fts-only-agent", "FTS Only Agent", "Excellent at rust debugging.", "You debug rust.");

    // Query with a non-matching direction (won't find via cosine) but matching keywords
    const query = makeVec(99); // different direction, won't match
    const results = await retrieveAgentsByEmbedding(
      db,
      query,
      { threshold: 0.99, topK: 5 }, // very high threshold so cosine finds nothing
      "rust debugging errors", // but FTS matches
    );

    const ids = results.map((r) => r.id);
    expect(ids).toContain("fts-only-agent");
    const ftsResult = results.find((r) => r.id === "fts-only-agent");
    expect(ftsResult?.matchType).toBe("fts");
  });

  it("deduplicates between cosine and FTS results", async () => {
    const db = await makeTestDb();

    // Agent found by both cosine and FTS — should appear only once
    const vec = makeVec(0);
    insertAgent(db, "dual-agent", "Use for dual matching tasks.", vec);
    ftsUpsertAgent(db, "dual-agent", "Dual Agent", "Use for dual matching tasks.", "You match dually.");

    const query = makeVec(0);
    const results = await retrieveAgentsByEmbedding(
      db, query, { threshold: 0.0, topK: 5 }, "dual matching",
    );

    const ids = results.map((r) => r.id);
    const dupeCount = ids.filter((id) => id === "dual-agent").length;
    expect(dupeCount).toBe(1);
  });

  it("returns match type correctly", async () => {
    const db = await makeTestDb();
    insertAgent(db, "cosine-agent", "Cosine match agent.", makeVec(0));

    const results = await retrieveAgentsByEmbedding(
      db, makeVec(0), { threshold: 0.0, topK: 5 }
    );

    const cosineResult = results.find((r) => r.id === "cosine-agent");
    expect(cosineResult).toBeDefined();
    expect(cosineResult?.matchType).toBe("cosine");
  });
});

// ── computeAndStoreAgentEmbedding ─────────────────────────────────────────────

describe("computeAndStoreAgentEmbedding", () => {
  it("does not throw when local embeddings are unavailable", async () => {
    const db = await makeTestDb();
    insertAgent(db, "no-emb-agent", "Agent without embedding.");

    // This will try localEmbed, which returns null in test env without
    // @huggingface/transformers. Should be a no-op, not a crash.
    await expect(
      computeAndStoreAgentEmbedding(db, "no-emb-agent", {
        description: "Agent without embedding.",
        prompt: "You help without embeddings.",
      }),
    ).resolves.toBeUndefined();
  });
});
