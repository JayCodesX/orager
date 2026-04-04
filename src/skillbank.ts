/**
 * SkillBank — ADR-0006
 *
 * Persistent, embedding-indexed library of behavioural skill instructions
 * distilled from failure trajectories. Skills are retrieved by cosine
 * similarity to the run prompt and injected into the system prompt as a
 * "## Learned Skills" section before the memory context.
 *
 * Storage: standalone SQLite database (resolveSkillsDbPath()).
 *
 * Performance layers:
 *  1. sqlite-vec ANN index (skills_vectors vec0 table) — sub-ms retrieval at any scale
 *  2. FTS5 full-text index (skills_fts) — keyword-based fallback/supplement
 *  3. Local embeddings via Transformers.js (384-dim) — zero API cost
 *  4. Similarity gate — skips prompt injection when no skill exceeds threshold
 *  5. Brute-force JS cosine fallback — always works, no dependencies
 *
 * All public functions are non-fatal — errors are logged to stderr and
 * swallowed. An unavailable SkillBank must never abort an agent run.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { openDb, isSqliteVecAvailable, type SqliteDatabase } from "./native-sqlite.js";
import { getOpenRouterProvider } from "./providers/index.js";
import { resolveSkillsDbPath } from "./db.js";
import { localEmbed } from "./local-embeddings.js";
import type { SkillBankConfig } from "./types.js";

// ── Defaults ──────────────────────────────────────────────────────────────────

export const DEFAULT_SKILLBANK_CONFIG: Required<SkillBankConfig> = {
  enabled: true,
  extractionModel: "",
  maxSkills: 500,
  similarityThreshold: 0.65,
  deduplicationThreshold: 0.92,
  topK: 5,
  retentionDays: 30,
  autoExtract: true,
  mergeAt: 100,
  mergeThreshold: 0.78,
  mergeMinClusterSize: 3,
};

function cfg(userConfig?: SkillBankConfig): Required<SkillBankConfig> {
  return { ...DEFAULT_SKILLBANK_CONFIG, ...userConfig };
}

// ── Skill type ────────────────────────────────────────────────────────────────

export interface Skill {
  id: string;
  version: number;
  text: string;
  embedding: number[] | null;
  sourceSession: string;
  extractionModel: string;
  createdAt: string;
  updatedAt: string;
  useCount: number;
  successRate: number;
  deleted: boolean;
  /** ID of the meta-skill this skill was merged into (set when deleted via merge). */
  mergedInto?: string | null;
  /** IDs of the source skills this meta-skill was synthesized from. */
  sourceSkills?: string[] | null;
}

// ── Stats ─────────────────────────────────────────────────────────────────────

export interface SkillStats {
  total: number;
  avgSuccessRate: number;
  topByUse: Skill[];
  weakSkills: Skill[];
}

// ── Skills DB connection ──────────────────────────────────────────────────────

let _skillsDb: SqliteDatabase | null = null;

async function _getSkillsDb(): Promise<SqliteDatabase> {
  if (_skillsDb) return _skillsDb;
  const dbPath = resolveSkillsDbPath();
  _skillsDb = await openDb(dbPath);
  _skillsDb.exec(`
    CREATE TABLE IF NOT EXISTS skills (
      id               TEXT PRIMARY KEY,
      version          INTEGER NOT NULL DEFAULT 1,
      text             TEXT NOT NULL,
      embedding        BLOB,
      embedding_model  TEXT,
      source_session   TEXT NOT NULL DEFAULT '',
      extraction_model TEXT NOT NULL DEFAULT '',
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL,
      use_count        INTEGER NOT NULL DEFAULT 0,
      success_rate     REAL NOT NULL DEFAULT 0.5,
      deleted          INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_skills_deleted ON skills(deleted);
  `);

  // ── Additive migrations for merge pipeline ───────────────────────────────
  // These columns are nullable and default to NULL so existing rows are unaffected.
  try {
    _skillsDb.exec(`ALTER TABLE skills ADD COLUMN merged_into TEXT`);
  } catch { /* column already exists */ }
  try {
    _skillsDb.exec(`ALTER TABLE skills ADD COLUMN source_skills TEXT`);
  } catch { /* column already exists */ }

  // ── Meta table for vec dimension tracking ────────────────────────────────
  _skillsDb.exec(`
    CREATE TABLE IF NOT EXISTS _skills_meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // ── FTS5 full-text index ─────────────────────────────────────────────────
  try {
    _skillsDb.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts
        USING fts5(text, content=skills, content_rowid=rowid);
    `);
    // Rebuild FTS from existing skills (fast, idempotent)
    _rebuildFts(_skillsDb);
  } catch {
    // FTS5 may not be available on very old SQLite builds — non-fatal
  }

  // ── sqlite-vec ANN index ─────────────────────────────────────────────────
  _rebuildSkillsVec(_skillsDb);

  return _skillsDb;
}

/** Reset for testing — closes any open skills DB connection. */
export function _resetSkillsDbForTesting(): void {
  try { _skillsDb?.close(); } catch { /* ignore */ }
  _skillsDb = null;
}

// ── Guards ────────────────────────────────────────────────────────────────────

function isSkillBankAvailable(): boolean {
  return true; // errors are caught and swallowed per-function; never abort a run
}

// ── Embedding helpers ─────────────────────────────────────────────────────────

/** @internal — used by skillbank-merge.ts */
export function _embeddingToBlob(vec: number[]): Uint8Array {
  return embeddingToBlob(vec);
}
/** @internal — used by skillbank-merge.ts */
export function _blobToEmbedding(buf: Uint8Array | null): number[] | null {
  return blobToEmbedding(buf ?? null);
}
/** @internal — used by skillbank-merge.ts */
export async function _getSkillsDbForMerge(): Promise<SqliteDatabase> {
  return _getSkillsDb();
}
/** @internal — used by skillbank-merge.ts */
export function _ensureSkillsVecTableForMerge(db: SqliteDatabase, dim: number): boolean {
  return _ensureSkillsVecTable(db, dim);
}
/** @internal — used by skillbank-merge.ts */
export function _rebuildFtsForMerge(db: SqliteDatabase): void {
  _rebuildFts(db);
}

function embeddingToBlob(vec: number[]): Uint8Array {
  return new Uint8Array(new Float32Array(vec).buffer);
}

function blobToEmbedding(buf: Uint8Array | null): number[] | null {
  if (!buf || buf.length === 0) return null;
  const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return Array.from(f32);
}

import { cosineSimilarity } from "./memory.js";

// ── sqlite-vec ANN helpers ────────────────────────────────────────────────────

/**
 * Create (or verify) the skills_vectors vec0 virtual table.
 * Returns true when the table is ready for use with the given dimension.
 * If the stored dimension differs (model swap), drops and recreates.
 */
function _ensureSkillsVecTable(db: SqliteDatabase, dim: number): boolean {
  if (!isSqliteVecAvailable()) return false;
  try {
    const dimRow = db.prepare("SELECT value FROM _skills_meta WHERE key = 'vec_dim'").get() as { value: string } | undefined;
    if (dimRow) {
      if (parseInt(dimRow.value, 10) === dim) return true;
      // Dimension changed (embedding model swap) — drop and recreate
      db.exec("DROP TABLE IF EXISTS skills_vectors");
      db.prepare("DELETE FROM _skills_meta WHERE key = 'vec_dim'").run();
    }
    db.exec(`CREATE VIRTUAL TABLE skills_vectors USING vec0(embedding float[${dim}])`);
    db.prepare("INSERT OR REPLACE INTO _skills_meta (key, value) VALUES ('vec_dim', ?)").run(String(dim));
    return true;
  } catch {
    return false;
  }
}

/**
 * Rebuild the skills_vectors ANN index from scratch.
 * Called on DB open (backfill) and after skill insertions with new dimensions.
 * No-op when sqlite-vec is unavailable or no embeddings exist.
 */
function _rebuildSkillsVec(db: SqliteDatabase): void {
  if (!isSqliteVecAvailable()) return;
  try {
    const embRows = db.prepare(
      "SELECT rowid, embedding FROM skills WHERE deleted = 0 AND embedding IS NOT NULL",
    ).all() as { rowid: number; embedding: Uint8Array }[];
    if (embRows.length === 0) return;

    const dim = embRows[0]!.embedding.byteLength / 4;
    if (!_ensureSkillsVecTable(db, dim)) return;

    db.transaction(() => {
      db.exec("DELETE FROM skills_vectors");
      const ins = db.prepare("INSERT INTO skills_vectors (rowid, embedding) VALUES (?, ?)");
      for (const row of embRows) {
        try { ins.run(row.rowid, row.embedding); } catch { /* skip malformed */ }
      }
    })();
  } catch { /* graceful — ANN unavailable, brute-force fallback active */ }
}

/**
 * Try ANN retrieval via sqlite-vec. Returns ranked skills or null if unavailable.
 */
function _retrieveSkillsANN(
  db: SqliteDatabase,
  queryEmbedding: number[],
  config: Required<SkillBankConfig>,
): Skill[] | null {
  if (!isSqliteVecAvailable()) return null;

  try {
    // Verify vec table has matching dimension
    const dimRow = db.prepare("SELECT value FROM _skills_meta WHERE key = 'vec_dim'").get() as { value: string } | undefined;
    if (!dimRow || parseInt(dimRow.value, 10) !== queryEmbedding.length) return null;

    const queryBlob = new Uint8Array(new Float32Array(queryEmbedding).buffer);
    // Fetch topK * 2 candidates for re-ranking buffer
    const annRows = db.prepare(`
      SELECT rowid, distance
      FROM skills_vectors
      WHERE embedding MATCH ?
        AND k = ?
    `).all(queryBlob, config.topK * 2) as { rowid: number; distance: number }[];

    if (annRows.length === 0) return [];

    const rowids = annRows.map((r) => r.rowid);
    const placeholders = rowids.map(() => "?").join(",");

    const skillRows = db.prepare(
      `SELECT *, rowid as _rowid FROM skills WHERE rowid IN (${placeholders}) AND deleted = 0`,
    ).all(...rowids) as unknown as (SkillRow & { _rowid: number })[];

    // Re-rank by exact cosine similarity
    const scored = skillRows
      .map((row) => {
        const emb = blobToEmbedding(row.embedding ?? null);
        const sim = emb ? cosineSimilarity(queryEmbedding, emb) : 0;
        return { row, sim };
      })
      .filter(({ sim }) => sim >= config.similarityThreshold)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, config.topK);

    return scored.map(({ row }) => rowToSkill(row));
  } catch {
    return null; // fall through to brute-force
  }
}

// ── FTS5 helpers ──────────────────────────────────────────────────────────────

/**
 * Rebuild FTS5 index from existing skills. Called on DB open.
 */
function _rebuildFts(db: SqliteDatabase): void {
  try {
    db.exec("INSERT INTO skills_fts(skills_fts) VALUES('rebuild')");
  } catch { /* FTS5 unavailable — non-fatal */ }
}

/**
 * Retrieve skills via FTS5 keyword search.
 * Returns matching skills or empty array. Used as supplement to vector search.
 */
function _retrieveSkillsFTS(
  db: SqliteDatabase,
  queryText: string,
  config: Required<SkillBankConfig>,
): Skill[] {
  try {
    // Extract significant words (>3 chars) for FTS query
    const words = queryText
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .slice(0, 10);

    if (words.length === 0) return [];

    // Use OR matching — any keyword hit is useful
    const ftsQuery = words.join(" OR ");
    const rows = db.prepare(`
      SELECT s.* FROM skills s
      JOIN skills_fts f ON s.rowid = f.rowid
      WHERE skills_fts MATCH ?
        AND s.deleted = 0
      LIMIT ?
    `).all(ftsQuery, config.topK) as unknown as SkillRow[];

    return rows.map(rowToSkill);
  } catch {
    return []; // FTS5 unavailable — non-fatal
  }
}

// ── Row mapping ───────────────────────────────────────────────────────────────

interface SkillRow {
  id: string;
  version: number;
  text: string;
  embedding: Uint8Array | null;
  embedding_model: string | null;
  source_session: string;
  extraction_model: string;
  created_at: string;
  updated_at: string;
  use_count: number;
  success_rate: number;
  deleted: number;
  merged_into?: string | null;
  source_skills?: string | null; // stored as JSON array string
}

function rowToSkill(row: SkillRow): Skill {
  return {
    id: row.id,
    version: row.version,
    text: row.text,
    embedding: blobToEmbedding(row.embedding ?? null),
    sourceSession: row.source_session,
    extractionModel: row.extraction_model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    useCount: row.use_count,
    successRate: row.success_rate,
    deleted: row.deleted === 1,
    mergedInto: row.merged_into ?? null,
    sourceSkills: row.source_skills ? JSON.parse(row.source_skills) as string[] : null,
  };
}

// ── Retrieval ─────────────────────────────────────────────────────────────────

/**
 * Retrieve top-K skills by cosine similarity to queryEmbedding.
 *
 * Retrieval pipeline:
 *  1. Try sqlite-vec ANN (sub-ms at any scale)
 *  2. Fall back to brute-force JS cosine (always works)
 *  3. Supplement with FTS5 keyword matches (deduped)
 *  4. Apply similarity gate — return [] if best match < threshold
 *
 * Returns [] when no skills exist, DB is disabled, or any error occurs.
 */
export async function retrieveSkills(
  queryEmbedding: number[],
  userConfig?: SkillBankConfig,
  queryText?: string,
): Promise<Skill[]> {
  if (!isSkillBankAvailable()) return [];
  const config = cfg(userConfig);
  if (!config.enabled) return [];

  try {
    const db = await _getSkillsDb();

    // ── Step 1: Try ANN retrieval ──────────────────────────────────────────
    let results = _retrieveSkillsANN(db, queryEmbedding, config);

    // ── Step 2: Brute-force fallback ───────────────────────────────────────
    if (results === null) {
      const rows = db
        .prepare("SELECT * FROM skills WHERE deleted = 0")
        .all() as unknown as SkillRow[];

      if (rows.length === 0) return [];

      const scored = rows
        .map((row) => {
          const emb = blobToEmbedding(row.embedding ?? null);
          const sim = emb ? cosineSimilarity(queryEmbedding, emb) : 0;
          return { row, sim };
        })
        .filter(({ sim }) => sim >= config.similarityThreshold)
        .sort((a, b) => b.sim - a.sim)
        .slice(0, config.topK);

      results = scored.map(({ row }) => rowToSkill(row));
    }

    // ── Step 3: Supplement with FTS5 keyword matches ───────────────────────
    if (queryText) {
      const ftsResults = _retrieveSkillsFTS(db, queryText, config);
      if (ftsResults.length > 0) {
        const existingIds = new Set(results.map((s) => s.id));
        for (const ftsSkill of ftsResults) {
          if (!existingIds.has(ftsSkill.id) && results.length < config.topK) {
            results.push(ftsSkill);
            existingIds.add(ftsSkill.id);
          }
        }
      }
    }

    return results;
  } catch (err) {
    process.stderr.write(
      `[skillbank] retrieveSkills error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return [];
  }
}

// ── System prompt builder ─────────────────────────────────────────────────────

/**
 * Render the "## Learned Skills" system prompt section.
 * Returns "" when skills is empty (caller must guard against injecting the empty string).
 */
export function buildSkillsPromptSection(skills: Skill[]): string {
  if (skills.length === 0) return "";
  const lines = [
    "## Learned Skills",
    "The following strategies were learned from previous runs on similar tasks.",
    "Apply them where relevant:\n",
    ...skills.map((s, i) => `${i + 1}. ${s.text}`),
  ];
  return lines.join("\n");
}

// ── Outcome recording ─────────────────────────────────────────────────────────

/**
 * Update use_count and success_rate for a set of skills after a run completes.
 * Fire-and-forget safe — swallows all errors.
 */
export async function updateSkillOutcomes(
  skillIds: string[],
  success: boolean,
): Promise<void> {
  if (!isSkillBankAvailable() || skillIds.length === 0) return;
  try {
    const db = await _getSkillsDb();
    const upd = db.prepare(`
      UPDATE skills
      SET use_count    = use_count + 1,
          success_rate = ROUND(
            (success_rate * use_count + ?) / (use_count + 1),
            4
          ),
          updated_at   = ?
      WHERE id = ?
    `);
    const now = new Date().toISOString();
    const successVal = success ? 1 : 0;
    for (const id of skillIds) {
      upd.run(successVal, now, id);
    }

    // Auto-prune skills with persistent low success rate (≥10 uses, rate < 0.3)
    db.exec(`
      UPDATE skills
      SET deleted    = 1,
          updated_at = '${now}'
      WHERE deleted = 0
        AND use_count >= 10
        AND success_rate < 0.30
    `);
  } catch (err) {
    process.stderr.write(
      `[skillbank] updateSkillOutcomes error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

// ── Extraction ────────────────────────────────────────────────────────────────

const EXTRACTION_SYSTEM_PROMPT = `You are extracting a reusable strategy from an AI agent run.
Analyse the trajectory and produce ONE concise skill instruction (≤ 150 words) describing a pattern the agent should apply on similar tasks in the future.

Focus on:
- User corrections or preferences expressed during the run
- Coding style patterns the user enforced (e.g., control flow style, abstraction level, naming conventions)
- Strategies that led to successful outcomes
- Mistakes or anti-patterns the agent should avoid

The instruction must be:
- Task-agnostic (avoid specific file names, session IDs, or repository names)
- Actionable (start with a verb phrase: "When X, always Y", "Before X, verify Y", "Never X without first Y")
- A strategy or preference, not a fact about the specific run

If the trajectory contains no learnable pattern (e.g., simple one-shot success with no corrections), output exactly "NO_SKILL".

Output ONLY the instruction text — no preamble, no markdown, no JSON, no explanation.`;

/**
 * Extract a skill from a trajectory file via LLM call and store it.
 * Non-fatal — all errors are swallowed and logged to stderr.
 *
 * Uses local embeddings (Transformers.js) when available, falling back to
 * the OpenRouter embedding API.
 *
 * @param trajectoryPath - Path to the .jsonl trajectory file
 * @param sourceSession  - Session ID the trajectory came from
 * @param model          - Model to use for extraction (overrides config.extractionModel)
 * @param apiKey         - OpenRouter API key
 * @param embeddingModel - Model to use for embedding via OpenRouter (fallback)
 * @param userConfig     - SkillBank config
 */
export async function extractSkillFromTrajectory(
  trajectoryPath: string,
  sourceSession: string,
  model: string,
  apiKey: string,
  embeddingModel: string,
  userConfig?: SkillBankConfig,
): Promise<void> {
  if (!isSkillBankAvailable()) return;
  const config = cfg(userConfig);
  if (!config.enabled) return;

  try {
    // ── 1. Read and condense trajectory ───────────────────────────────────────
    let raw: string;
    try {
      raw = await fs.readFile(trajectoryPath, "utf8");
    } catch {
      return; // file not found or unreadable — silently skip
    }

    const lines = raw.split("\n").filter(Boolean);
    const condensed: string[] = [];
    let charCount = 0;
    const CHAR_LIMIT = 8_000; // ~2000 tokens — keeps extraction cheap

    // ── Correction detection counters ────────────────────────────────────────
    let assistantTurns = 0;
    let userTurns = 0;
    let hasFailureResult = false;

    for (const line of lines) {
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        let excerpt: string | null = null;

        if (event.type === "assistant") {
          assistantTurns++;
          // Capture assistant text (first 400 chars per turn)
          const msg = event.message as Record<string, unknown> | undefined;
          if (msg && Array.isArray(msg.content)) {
            for (const block of msg.content as Array<Record<string, unknown>>) {
              if (block.type === "text" && typeof block.text === "string") {
                excerpt = `[assistant] ${block.text.slice(0, 400)}`;
                break;
              }
            }
          }
        } else if (event.type === "user") {
          userTurns++;
          // Capture user text for correction detection
          const msg = event.message as Record<string, unknown> | undefined;
          if (msg && Array.isArray(msg.content)) {
            for (const block of msg.content as Array<Record<string, unknown>>) {
              if (block.type === "text" && typeof block.text === "string") {
                excerpt = `[user] ${block.text.slice(0, 400)}`;
                break;
              }
            }
          }
        } else if (event.type === "tool") {
          // Capture tool name only (not results — no sensitive data sent to LLM)
          excerpt = `[tool:${event.name ?? "?"}]`;
        } else if (event.type === "result") {
          const subtype = String(event.subtype ?? "");
          if (subtype !== "success" && subtype !== "interrupted" && subtype !== "unknown") {
            hasFailureResult = true;
          }
          excerpt = `[result:${subtype}] ${String(event.message ?? "").slice(0, 200)}`;
        }

        if (excerpt) {
          charCount += excerpt.length + 1;
          if (charCount > CHAR_LIMIT) break;
          condensed.push(excerpt);
        }
      } catch { /* skip malformed lines */ }
    }

    if (condensed.length === 0) return;

    // ── 1b. Skip extraction if no learnable signal ───────────────────────────
    // A single-turn success with no user corrections has nothing to learn from.
    // This saves 1 LLM call + 1 embedding call per clean session.
    const hasCorrection = userTurns > 0;
    const isMultiAssistantTurn = assistantTurns > 1;
    if (!hasCorrection && !isMultiAssistantTurn && !hasFailureResult) {
      process.stderr.write(
        `[skillbank] skipping extraction for ${sourceSession}: no corrections or failures detected\n`,
      );
      return;
    }

    const trajectoryText = condensed.join("\n");

    // ── 2. Call LLM extractor ─────────────────────────────────────────────────
    const extractionModel = config.extractionModel || model;
    let skillText = "";
    try {
      const result = await getOpenRouterProvider().chat({
        apiKey,
        model: extractionModel,
        messages: [
          { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
          { role: "user", content: `Trajectory:\n\n${trajectoryText}` },
        ],
        max_completion_tokens: 250,
        temperature: 0.3,
      });
      skillText = (result.content ?? "").trim();
    } catch (err) {
      process.stderr.write(
        `[skillbank] extraction LLM call failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return;
    }

    if (!skillText || skillText.length < 20 || skillText === "NO_SKILL") return; // too short, empty, or no learnable pattern

    // ── 3. Embed the candidate skill ──────────────────────────────────────────
    // Try local embeddings first (free, fast), fall back to OpenRouter API
    let candidateEmbedding: number[];
    try {
      const localVec = await localEmbed(skillText);
      if (localVec) {
        candidateEmbedding = localVec;
      } else {
        const vecs = await getOpenRouterProvider().callEmbeddings!(apiKey, embeddingModel, [skillText]);
        candidateEmbedding = vecs[0];
      }
    } catch (err) {
      process.stderr.write(
        `[skillbank] embedding failed during extraction: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return;
    }

    // ── 4. Deduplication check ────────────────────────────────────────────────
    try {
      const db = await _getSkillsDb();
      const existing = db
        .prepare("SELECT embedding FROM skills WHERE deleted = 0 AND embedding IS NOT NULL")
        .all() as Array<{ embedding: Uint8Array | null }>;

      for (const row of existing) {
        const emb = blobToEmbedding(row.embedding ?? null);
        if (emb && cosineSimilarity(candidateEmbedding, emb) >= config.deduplicationThreshold) {
          return; // duplicate — skip
        }
      }

      // ── 5. Check max skills cap ───────────────────────────────────────────────
      const countRow = db
        .prepare("SELECT COUNT(*) as c FROM skills WHERE deleted = 0")
        .get() as { c: number };

      if (countRow.c >= config.maxSkills) {
        // Prune oldest skill with lowest success rate
        const worst = db
          .prepare(
            "SELECT id FROM skills WHERE deleted = 0 ORDER BY success_rate ASC, created_at ASC LIMIT 1",
          )
          .get() as { id: string } | undefined;
        if (worst) {
          db.prepare("UPDATE skills SET deleted = 1, updated_at = ? WHERE id = ?").run(
            new Date().toISOString(),
            worst.id,
          );
          // Remove from vec index
          try {
            const delRow = db.prepare("SELECT rowid FROM skills WHERE id = ?").get(worst.id) as { rowid: number } | undefined;
            if (delRow) {
              db.prepare("DELETE FROM skills_vectors WHERE rowid = ?").run(delRow.rowid);
            }
          } catch { /* non-fatal */ }
        }
      }

      // ── 6. Insert new skill ────────────────────────────────────────────────────
      const now = new Date().toISOString();
      const id = `sk_${crypto.randomBytes(3).toString("hex")}`;
      db.prepare(`
        INSERT INTO skills
          (id, version, text, embedding, embedding_model, source_session,
           extraction_model, created_at, updated_at, use_count, success_rate, deleted)
        VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, 0, 0.5, 0)
      `).run(
        id,
        skillText,
        embeddingToBlob(candidateEmbedding),
        embeddingModel,
        sourceSession,
        extractionModel,
        now,
        now,
      );

      // ── 6b. Update vec index ──────────────────────────────────────────────────
      try {
        const inserted = db.prepare("SELECT rowid FROM skills WHERE id = ?").get(id) as { rowid: number } | undefined;
        if (inserted && _ensureSkillsVecTable(db, candidateEmbedding.length)) {
          db.prepare("INSERT INTO skills_vectors (rowid, embedding) VALUES (?, ?)").run(
            inserted.rowid,
            embeddingToBlob(candidateEmbedding),
          );
        }
      } catch { /* non-fatal — vec index out of sync is self-healing on restart */ }

      // ── 6c. Update FTS index ──────────────────────────────────────────────────
      try {
        const inserted = db.prepare("SELECT rowid FROM skills WHERE id = ?").get(id) as { rowid: number } | undefined;
        if (inserted) {
          db.prepare("INSERT INTO skills_fts (rowid, text) VALUES (?, ?)").run(inserted.rowid, skillText);
        }
      } catch { /* non-fatal */ }

      process.stderr.write(`[skillbank] extracted skill ${id} from session ${sourceSession}\n`);

      // ── Auto-merge trigger ─────────────────────────────────────────────────────
      const mergeAt = config.mergeAt ?? 100;
      if (mergeAt > 0 && countRow.c + 1 >= mergeAt && apiKey) {
        // Non-blocking — never delays the extraction caller
        setImmediate(() => {
          import("./skillbank-merge.js").then(({ mergeSkillClusters }) => {
            mergeSkillClusters(extractionModel || "openai/gpt-4o-mini", apiKey, userConfig)
              .then((r) => {
                if (r.mergesCompleted > 0) {
                  process.stderr.write(
                    `[skillbank] auto-merge: ${r.mergesCompleted} clusters → ${r.skillsCreated} meta-skills, archived ${r.skillsArchived} originals\n`,
                  );
                }
              })
              .catch(() => { /* non-fatal */ });
          }).catch(() => { /* non-fatal if module missing */ });
        });
      }
    } catch (err) {
      process.stderr.write(
        `[skillbank] DB write failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  } catch (err) {
    process.stderr.write(
      `[skillbank] unexpected error in extractSkillFromTrajectory: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

// ── CLI helpers ───────────────────────────────────────────────────────────────

export async function listSkills(includeDeleted = false): Promise<Skill[]> {
  if (!isSkillBankAvailable()) return [];
  try {
    const db = await _getSkillsDb();
    const sql = includeDeleted
      ? "SELECT * FROM skills ORDER BY created_at DESC"
      : "SELECT * FROM skills WHERE deleted = 0 ORDER BY created_at DESC";
    return (db.prepare(sql).all() as unknown as SkillRow[]).map(rowToSkill);
  } catch {
    return [];
  }
}

export async function getSkill(id: string): Promise<Skill | null> {
  if (!isSkillBankAvailable()) return null;
  try {
    const db = await _getSkillsDb();
    const row = db.prepare("SELECT * FROM skills WHERE id = ?").get(id) as unknown as SkillRow | undefined;
    return row ? rowToSkill(row) : null;
  } catch {
    return null;
  }
}

export async function deleteSkill(id: string): Promise<void> {
  if (!isSkillBankAvailable()) return;
  try {
    const db = await _getSkillsDb();
    // Get rowid before marking deleted (needed for vec/fts cleanup)
    const row = db.prepare("SELECT rowid FROM skills WHERE id = ?").get(id) as { rowid: number } | undefined;
    db.prepare("UPDATE skills SET deleted = 1, updated_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      id,
    );
    // Clean up vec index
    if (row) {
      try { db.prepare("DELETE FROM skills_vectors WHERE rowid = ?").run(row.rowid); } catch { /* non-fatal */ }
    }
  } catch (err) {
    process.stderr.write(
      `[skillbank] deleteSkill error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

export async function getSkillStats(): Promise<SkillStats> {
  if (!isSkillBankAvailable()) {
    return { total: 0, avgSuccessRate: 0, topByUse: [], weakSkills: [] };
  }
  try {
    const db = await _getSkillsDb();
    const total = (db
      .prepare("SELECT COUNT(*) as c FROM skills WHERE deleted = 0")
      .get() as { c: number }).c;

    const avgRow = db
      .prepare("SELECT AVG(success_rate) as avg FROM skills WHERE deleted = 0")
      .get() as { avg: number | null };

    const topByUse = (db
      .prepare(
        "SELECT * FROM skills WHERE deleted = 0 ORDER BY use_count DESC LIMIT 5",
      )
      .all() as unknown as SkillRow[]).map(rowToSkill);

    const weakSkills = (db
      .prepare(
        "SELECT * FROM skills WHERE deleted = 0 AND use_count >= 5 AND success_rate < 0.40 ORDER BY success_rate ASC LIMIT 10",
      )
      .all() as unknown as SkillRow[]).map(rowToSkill);

    return {
      total,
      avgSuccessRate: avgRow.avg ?? 0,
      topByUse,
      weakSkills,
    };
  } catch {
    return { total: 0, avgSuccessRate: 0, topByUse: [], weakSkills: [] };
  }
}

// ── Trajectory directory helper (shared with trajectory-logger.ts) ─────────────

export function getTrajectoriesDir(): string {
  return path.join(os.homedir(), ".orager", "trajectories");
}

export function trajectoryPath(sessionId: string): string {
  return path.join(getTrajectoriesDir(), `${sessionId}.jsonl`);
}

export function trajectoryMetaPath(sessionId: string): string {
  return path.join(getTrajectoriesDir(), `${sessionId}.meta.json`);
}
