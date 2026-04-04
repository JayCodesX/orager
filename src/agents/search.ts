/**
 * Semantic agent search — find the closest catalog agents to a task description.
 *
 * Mirrors the SkillBank retrieval pipeline exactly:
 *   1. sqlite-vec ANN (sub-ms at any catalog size)
 *   2. Brute-force JS cosine fallback (always works)
 *   3. FTS5 keyword supplement (deduped)
 *   4. Similarity gate — filters agents below threshold
 *
 * Embeddings are stored as Float32 blobs in the agents table and indexed in
 * an `agents_vectors` vec0 virtual table. FTS covers description + name.
 *
 * When to use semantic search vs full catalog load:
 *   - Small catalogs (< minCatalogSize agents) → load all, let the LLM pick
 *   - Large catalogs → retrieve top-K closest and inject only those
 *
 * The loop calls findClosestAgents() to narrow the Agent tool's description
 * when the catalog grows beyond a useful full-list size.
 *
 * Embedding generation is non-blocking and best-effort — upsertAgent fires
 * it in the background. Agents without embeddings fall through to FTS only.
 */

import { isSqliteVecAvailable } from "../native-sqlite.js";
import type { SqliteDatabase } from "../native-sqlite.js";
import { localEmbed } from "../local-embeddings.js";
import { getCachedQueryEmbedding, setCachedQueryEmbedding } from "../embedding-cache.js";
import { cosineSimilarity } from "../memory.js";
import type { AgentDefinition } from "../types.js";

// ── Config ────────────────────────────────────────────────────────────────────

export interface AgentSearchConfig {
  /** Number of agents to return. Default 5. */
  topK?: number;
  /**
   * Minimum cosine similarity to include a result.
   * Slightly lower than skills (0.65) because agent descriptions are longer and
   * more varied in style than distilled skill sentences.
   * Default 0.60.
   */
  threshold?: number;
  /**
   * Only activate semantic search when the catalog has at least this many agents.
   * Below this, the full catalog is small enough to inject entirely.
   * Default 10.
   */
  minCatalogSize?: number;
}

const DEFAULT_CONFIG: Required<AgentSearchConfig> = {
  topK: 5,
  threshold: 0.60,
  minCatalogSize: 10,
};

function cfg(c?: AgentSearchConfig): Required<AgentSearchConfig> {
  return { ...DEFAULT_CONFIG, ...c };
}

// ── Embedding blob helpers (same format as skillbank) ─────────────────────────

export function embeddingToBlob(vec: number[]): Uint8Array {
  return new Uint8Array(new Float32Array(vec).buffer);
}

export function blobToEmbedding(buf: Uint8Array | null | undefined): number[] | null {
  if (!buf || buf.byteLength === 0) return null;
  const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return Array.from(f32);
}

// ── Result type ───────────────────────────────────────────────────────────────

export interface AgentSearchResult {
  id: string;
  definition: AgentDefinition;
  /** Cosine similarity score [0, 1]. */
  score: number;
  /** How the match was found. */
  matchType: "ann" | "cosine" | "fts";
}

// ── vec0 table helpers ────────────────────────────────────────────────────────

const AGENTS_VEC_META_KEY = "agents_vec_dim";

/**
 * Ensure the agents_vectors vec0 table exists and has the right dimension.
 * Returns true when ANN index is ready. Mirrors _ensureSkillsVecTable.
 */
export function ensureAgentsVecTable(db: SqliteDatabase, dim: number): boolean {
  if (!isSqliteVecAvailable()) return false;
  try {
    const meta = db.prepare(
      "SELECT value FROM _agents_meta WHERE key = ?",
    ).get(AGENTS_VEC_META_KEY) as { value: string } | undefined;

    if (meta) {
      if (parseInt(meta.value, 10) === dim) return true;
      // Dimension changed — drop and recreate
      db.exec("DROP TABLE IF EXISTS agents_vectors");
      db.prepare("DELETE FROM _agents_meta WHERE key = ?").run(AGENTS_VEC_META_KEY);
    }

    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS agents_vectors USING vec0(embedding float[${dim}])`);
    db.prepare(
      "INSERT OR REPLACE INTO _agents_meta (key, value) VALUES (?, ?)",
    ).run(AGENTS_VEC_META_KEY, String(dim));
    return true;
  } catch {
    return false;
  }
}

/**
 * Rebuild the agents_vectors ANN index from the agents table.
 * Called after migration or when the index is found empty.
 */
export function rebuildAgentsVec(db: SqliteDatabase): void {
  if (!isSqliteVecAvailable()) return;
  try {
    const rows = db.prepare(
      "SELECT rowid, embedding FROM agents WHERE embedding IS NOT NULL",
    ).all() as { rowid: number; embedding: Uint8Array }[];
    if (rows.length === 0) return;

    const dim = rows[0]!.embedding.byteLength / 4;
    if (!ensureAgentsVecTable(db, dim)) return;

    db.transaction(() => {
      db.exec("DELETE FROM agents_vectors");
      const ins = db.prepare(
        "INSERT INTO agents_vectors (rowid, embedding) VALUES (?, ?)",
      );
      for (const row of rows) {
        try { ins.run(row.rowid, row.embedding); } catch { /* skip */ }
      }
    })();
  } catch { /* non-fatal */ }
}

// ── FTS helpers ───────────────────────────────────────────────────────────────

/** Insert or replace an agent's FTS entry. Call after every upsertAgent. */
export function ftsUpsertAgent(
  db: SqliteDatabase,
  agentId: string,
  name: string,
  description: string,
  prompt: string,
): void {
  try {
    // Delete existing FTS entry for this agent (content-less FTS5 doesn't auto-update)
    db.prepare("DELETE FROM agents_fts WHERE agent_id = ?").run(agentId);
    // Combine searchable text: name + description + first 500 chars of prompt
    const content = [name, description, prompt.slice(0, 500)].filter(Boolean).join(" ");
    db.prepare("INSERT INTO agents_fts (agent_id, content) VALUES (?, ?)").run(agentId, content);
  } catch { /* FTS unavailable — non-fatal */ }
}

/** Remove an agent's FTS entry. Call after deleteAgent. */
export function ftsDeleteAgent(db: SqliteDatabase, agentId: string): void {
  try {
    db.prepare("DELETE FROM agents_fts WHERE agent_id = ?").run(agentId);
  } catch { /* non-fatal */ }
}

// ── ANN retrieval ─────────────────────────────────────────────────────────────

interface AgentRow {
  rowid: number;
  id: string;
  definition: string;
  embedding: Uint8Array | null;
}

function _retrieveAgentsANN(
  db: SqliteDatabase,
  queryEmbedding: number[],
  config: Required<AgentSearchConfig>,
): AgentSearchResult[] | null {
  if (!isSqliteVecAvailable()) return null;

  try {
    const dimRow = db.prepare(
      "SELECT value FROM _agents_meta WHERE key = ?",
    ).get(AGENTS_VEC_META_KEY) as { value: string } | undefined;
    if (!dimRow || parseInt(dimRow.value, 10) !== queryEmbedding.length) return null;

    const queryBlob = embeddingToBlob(queryEmbedding);
    const annRows = db.prepare(`
      SELECT rowid, distance
      FROM agents_vectors
      WHERE embedding MATCH ?
        AND k = ?
    `).all(queryBlob, config.topK * 2) as { rowid: number; distance: number }[];

    if (annRows.length === 0) return [];

    const rowids = annRows.map((r) => r.rowid);
    const placeholders = rowids.map(() => "?").join(",");
    const agentRows = db.prepare(
      `SELECT rowid, id, definition, embedding FROM agents WHERE rowid IN (${placeholders})`,
    ).all(...rowids) as unknown as AgentRow[];

    const scored = agentRows
      .map((row) => {
        const emb = blobToEmbedding(row.embedding);
        const score = emb ? cosineSimilarity(queryEmbedding, emb) : 0;
        return { row, score };
      })
      .filter(({ score }) => score >= config.threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, config.topK);

    return scored.map(({ row, score }) => ({
      id: row.id,
      definition: { ...JSON.parse(row.definition) as AgentDefinition, source: "db" as const },
      score,
      matchType: "ann" as const,
    }));
  } catch {
    return null; // fall through to brute-force
  }
}

// ── Brute-force cosine ────────────────────────────────────────────────────────

function _retrieveAgentsCosine(
  db: SqliteDatabase,
  queryEmbedding: number[],
  config: Required<AgentSearchConfig>,
): AgentSearchResult[] {
  try {
    const rows = db.prepare(
      "SELECT rowid, id, definition, embedding FROM agents WHERE embedding IS NOT NULL",
    ).all() as unknown as AgentRow[];

    if (rows.length === 0) return [];

    return rows
      .map((row) => {
        const emb = blobToEmbedding(row.embedding);
        const score = emb ? cosineSimilarity(queryEmbedding, emb) : 0;
        return { row, score };
      })
      .filter(({ score }) => score >= config.threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, config.topK)
      .map(({ row, score }) => ({
        id: row.id,
        definition: { ...JSON.parse(row.definition) as AgentDefinition, source: "db" as const },
        score,
        matchType: "cosine" as const,
      }));
  } catch {
    return [];
  }
}

// ── FTS retrieval ─────────────────────────────────────────────────────────────

function _retrieveAgentsFTS(
  db: SqliteDatabase,
  queryText: string,
  topK: number,
): Array<{ id: string; definition: AgentDefinition }> {
  try {
    const words = queryText
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .slice(0, 10);

    if (words.length === 0) return [];

    const ftsQuery = words.join(" OR ");
    const rows = db.prepare(`
      SELECT a.id, a.definition
      FROM agents a
      JOIN agents_fts f ON f.agent_id = a.id
      WHERE agents_fts MATCH ?
      LIMIT ?
    `).all(ftsQuery, topK) as { id: string; definition: string }[];

    return rows.map((row) => ({
      id: row.id,
      definition: { ...JSON.parse(row.definition) as AgentDefinition, source: "db" as const },
    }));
  } catch {
    return [];
  }
}

// ── Main retrieval function ───────────────────────────────────────────────────

/**
 * Retrieve top-K agents from the DB by cosine similarity to queryEmbedding.
 *
 * Pipeline:
 *   1. sqlite-vec ANN (sub-ms at any scale)
 *   2. Brute-force JS cosine fallback (if ANN unavailable)
 *   3. FTS5 keyword supplement (deduped, fills up to topK)
 *
 * Returns [] on any error — agent search must never abort a run.
 *
 * Note: Only searches DB-stored agents. Seeds and file-based agents are small
 * enough to always load fully; this function is for the DB catalog portion.
 */
export async function retrieveAgentsByEmbedding(
  db: SqliteDatabase,
  queryEmbedding: number[],
  config?: AgentSearchConfig,
  queryText?: string,
): Promise<AgentSearchResult[]> {
  const c = cfg(config);

  try {
    // Step 1: ANN
    let results = _retrieveAgentsANN(db, queryEmbedding, c);

    // Step 2: Cosine fallback
    if (results === null) {
      results = _retrieveAgentsCosine(db, queryEmbedding, c);
    }

    // Step 3: FTS supplement
    if (queryText) {
      const ftsMatches = _retrieveAgentsFTS(db, queryText, c.topK);
      const existingIds = new Set(results.map((r) => r.id));
      for (const match of ftsMatches) {
        if (!existingIds.has(match.id) && results.length < c.topK) {
          results.push({
            id: match.id,
            definition: match.definition,
            score: 0, // FTS doesn't have a cosine score
            matchType: "fts",
          });
          existingIds.add(match.id);
        }
      }
    }

    return results;
  } catch (err) {
    process.stderr.write(
      `[agents/search] retrieveAgentsByEmbedding error: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    return [];
  }
}

// ── Public entry point ────────────────────────────────────────────────────────

const LOCAL_EMBED_MODEL = "local/all-MiniLM-L6-v2";

/**
 * Find the closest agents in the DB catalog to a natural language task description.
 *
 * This is the high-level entry point used by the loop and CLI. It handles:
 *   - Embedding generation (local model with API fallback)
 *   - Embedding cache lookup
 *   - DB retrieval via retrieveAgentsByEmbedding
 *
 * @param task   Natural language task description
 * @param db     Open agents database handle
 * @param config Search configuration
 * @returns      Ranked agent results, or [] if embedding unavailable / no matches
 */
export async function findClosestAgents(
  task: string,
  db: SqliteDatabase,
  config?: AgentSearchConfig,
): Promise<AgentSearchResult[]> {
  // Check embedding cache first
  const cached = getCachedQueryEmbedding(LOCAL_EMBED_MODEL, task);
  let embedding: number[] | null = cached;

  if (!embedding) {
    embedding = await localEmbed(task);
    if (embedding) {
      setCachedQueryEmbedding(LOCAL_EMBED_MODEL, task, embedding);
    }
  }

  if (!embedding) {
    // Local embeddings unavailable — fall back to FTS-only search
    const c = cfg(config);
    const ftsResults = _retrieveAgentsFTS(db, task, c.topK);
    return ftsResults.map((r) => ({
      ...r,
      score: 0,
      matchType: "fts" as const,
    }));
  }

  return retrieveAgentsByEmbedding(db, embedding, config, task);
}

/**
 * Compute and store an embedding for a single agent definition.
 * Called from upsertAgent — fires in the background (non-blocking).
 *
 * The text embedded is: "<name>. <description>. <first 300 chars of prompt>"
 * This gives the embedding enough context to match both "what it does"
 * (description) and "how it works" (prompt style).
 */
export async function computeAndStoreAgentEmbedding(
  db: SqliteDatabase,
  agentId: string,
  defn: AgentDefinition,
): Promise<void> {
  try {
    const text = [
      defn.name ?? agentId,
      defn.description,
      defn.prompt.slice(0, 300),
    ].join(". ");

    const embedding = await localEmbed(text);
    if (!embedding) return;

    const blob = embeddingToBlob(embedding);
    const dim = embedding.length;

    // Ensure vec table exists
    ensureAgentsVecTable(db, dim);

    // Update embedding columns
    db.prepare(
      "UPDATE agents SET embedding = ?, embedding_model = ? WHERE id = ?",
    ).run(blob, LOCAL_EMBED_MODEL, agentId);

    // Upsert into vec index
    if (isSqliteVecAvailable()) {
      try {
        const rowRow = db.prepare("SELECT rowid FROM agents WHERE id = ?").get(agentId) as
          | { rowid: number }
          | undefined;
        if (rowRow) {
          db.prepare("DELETE FROM agents_vectors WHERE rowid = ?").run(rowRow.rowid);
          db.prepare(
            "INSERT INTO agents_vectors (rowid, embedding) VALUES (?, ?)",
          ).run(rowRow.rowid, blob);
        }
      } catch { /* vec index unavailable — brute-force fallback active */ }
    }

    // Update FTS
    ftsUpsertAgent(
      db,
      agentId,
      defn.name ?? agentId,
      defn.description,
      defn.prompt,
    );
  } catch { /* non-fatal — embeddings are best-effort */ }
}
