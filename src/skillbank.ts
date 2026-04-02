/**
 * SkillBank — ADR-0006
 *
 * Persistent, embedding-indexed library of behavioural skill instructions
 * distilled from failure trajectories. Skills are retrieved by cosine
 * similarity to the run prompt and injected into the system prompt as a
 * "## Learned Skills" section before the memory context.
 *
 * Storage: shares the singleton SQLite connection from memory-sqlite.ts.
 * The `skills` table is created by the _migrate() call in memory-sqlite.ts.
 *
 * All public functions are non-fatal — errors are logged to stderr and
 * swallowed. An unavailable SkillBank must never abort an agent run.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { _getDb } from "./memory-sqlite.js";
import { callEmbeddings, callOpenRouter } from "./openrouter.js";
import { resolveDbPath } from "./db.js";
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
}

// ── Stats ─────────────────────────────────────────────────────────────────────

export interface SkillStats {
  total: number;
  avgSuccessRate: number;
  topByUse: Skill[];
  weakSkills: Skill[];
}

// ── Guards ────────────────────────────────────────────────────────────────────

function isSkillBankAvailable(): boolean {
  return resolveDbPath() !== null;
}

// ── Embedding helpers ─────────────────────────────────────────────────────────

function embeddingToBlob(vec: number[]): Uint8Array {
  return new Uint8Array(new Float32Array(vec).buffer);
}

function blobToEmbedding(buf: Uint8Array | null): number[] | null {
  if (!buf || buf.length === 0) return null;
  const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return Array.from(f32);
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
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
  };
}

// ── Retrieval ─────────────────────────────────────────────────────────────────

/**
 * Retrieve top-K skills by cosine similarity to queryEmbedding.
 * Returns [] when no skills exist, DB is disabled, or any error occurs.
 */
export async function retrieveSkills(
  queryEmbedding: number[],
  userConfig?: SkillBankConfig,
): Promise<Skill[]> {
  if (!isSkillBankAvailable()) return [];
  const config = cfg(userConfig);
  if (!config.enabled) return [];

  try {
    const db = await _getDb();
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

    return scored.map(({ row }) => rowToSkill(row));
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
    const db = await _getDb();
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

const EXTRACTION_SYSTEM_PROMPT = `You are extracting a reusable strategy from a failed AI agent run.
Analyse the trajectory and produce ONE concise skill instruction (≤ 150 words) describing what the agent should do differently on similar tasks in the future.

The instruction must be:
- Task-agnostic (avoid specific file names, session IDs, or repository names)
- Actionable (start with a verb phrase: "When X, always Y", "Before X, verify Y", "Never X without first Y")
- A strategy, not a fact about the specific run

Output ONLY the instruction text — no preamble, no markdown, no JSON, no explanation.`;

/**
 * Extract a skill from a trajectory file via LLM call and store it.
 * Non-fatal — all errors are swallowed and logged to stderr.
 *
 * @param trajectoryPath - Path to the .jsonl trajectory file
 * @param sourceSession  - Session ID the trajectory came from
 * @param model          - Model to use for extraction (overrides config.extractionModel)
 * @param apiKey         - OpenRouter API key
 * @param embeddingModel - Model to use for embedding the extracted skill
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

    for (const line of lines) {
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        let excerpt: string | null = null;

        if (event.type === "assistant") {
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
        } else if (event.type === "tool") {
          // Capture tool name only (not results — no sensitive data sent to LLM)
          excerpt = `[tool:${event.name ?? "?"}]`;
        } else if (event.type === "result") {
          excerpt = `[result:${event.subtype ?? "?"}] ${String(event.message ?? "").slice(0, 200)}`;
        }

        if (excerpt) {
          charCount += excerpt.length + 1;
          if (charCount > CHAR_LIMIT) break;
          condensed.push(excerpt);
        }
      } catch { /* skip malformed lines */ }
    }

    if (condensed.length === 0) return;

    const trajectoryText = condensed.join("\n");

    // ── 2. Call LLM extractor ─────────────────────────────────────────────────
    const extractionModel = config.extractionModel || model;
    let skillText = "";
    try {
      const result = await callOpenRouter({
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

    if (!skillText || skillText.length < 20) return; // too short to be useful

    // ── 3. Embed the candidate skill ──────────────────────────────────────────
    let candidateEmbedding: number[];
    try {
      const vecs = await callEmbeddings(apiKey, embeddingModel, [skillText]);
      candidateEmbedding = vecs[0];
    } catch (err) {
      process.stderr.write(
        `[skillbank] embedding failed during extraction: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return;
    }

    // ── 4. Deduplication check ────────────────────────────────────────────────
    try {
      const db = await _getDb();
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

      process.stderr.write(`[skillbank] extracted skill ${id} from session ${sourceSession}\n`);
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
    const db = await _getDb();
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
    const db = await _getDb();
    const row = db.prepare("SELECT * FROM skills WHERE id = ?").get(id) as unknown as SkillRow | undefined;
    return row ? rowToSkill(row) : null;
  } catch {
    return null;
  }
}

export async function deleteSkill(id: string): Promise<void> {
  if (!isSkillBankAvailable()) return;
  try {
    const db = await _getDb();
    db.prepare("UPDATE skills SET deleted = 1, updated_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      id,
    );
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
    const db = await _getDb();
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
