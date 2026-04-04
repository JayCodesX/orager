/**
 * skillbank-merge.ts — ADR-0011
 *
 * Skill merging pipeline: clusters similar skills by embedding cosine similarity,
 * then uses an LLM to synthesize each cluster into a single meta-skill, archiving
 * the originals with provenance links.
 *
 * Keeps the active SkillBank manageable at scale (e.g. 100 K skills → bounded set
 * of consolidated meta-skills) without discarding coverage.
 *
 * Triggered automatically when `skillbank.mergeAt` threshold is reached, or
 * manually via `orager skills merge`.
 */

import crypto from "node:crypto";
import type { SkillBankConfig } from "./types.js";
import {
  _getSkillsDbForMerge,
  _embeddingToBlob,
  _blobToEmbedding,
  _ensureSkillsVecTableForMerge,
  _rebuildFtsForMerge,
  type Skill,
} from "./skillbank.js";
import { cosineSimilarity } from "./memory.js";
import { localEmbed } from "./local-embeddings.js";
import { getOpenRouterProvider } from "./providers/registry.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MergeResult {
  clustersFound: number;
  mergesCompleted: number;
  skillsArchived: number;
  skillsCreated: number;
  errors: string[];
}

interface Cluster {
  skills: Skill[];
  centroid: number[];
}

// ── Config defaults ───────────────────────────────────────────────────────────

const DEFAULT_MERGE_THRESHOLD = 0.78;
const DEFAULT_MERGE_MIN_CLUSTER_SIZE = 3;

// ── Clustering ────────────────────────────────────────────────────────────────

/**
 * Greedy agglomerative clustering.
 * Groups skills whose embeddings are within `threshold` cosine similarity of the
 * cluster centroid. Discards clusters smaller than `minSize`.
 */
function clusterSkills(skills: Skill[], threshold: number, minSize: number): Cluster[] {
  const withEmb = skills.filter((s) => s.embedding !== null) as (Skill & { embedding: number[] })[];
  const assigned = new Set<string>();
  const clusters: Cluster[] = [];

  for (const seed of withEmb) {
    if (assigned.has(seed.id)) continue;

    const members: (Skill & { embedding: number[] }) = [seed] as unknown as (Skill & { embedding: number[] });
    const memberList: (Skill & { embedding: number[] })[] = [seed];
    assigned.add(seed.id);

    // Compute initial centroid
    let centroid = [...seed.embedding];

    // Expand cluster greedily
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const candidate of withEmb) {
        if (assigned.has(candidate.id)) continue;
        if (cosineSimilarity(centroid, candidate.embedding) >= threshold) {
          memberList.push(candidate);
          assigned.add(candidate.id);
          // Update centroid as mean of all member embeddings
          const n = memberList.length;
          centroid = centroid.map((v, i) => (v * (n - 1) + candidate.embedding[i]) / n);
          expanded = true;
        }
      }
    }

    if (memberList.length >= minSize) {
      clusters.push({ skills: memberList, centroid });
    }
  }

  return clusters;
}

// ── LLM synthesis ─────────────────────────────────────────────────────────────

/**
 * Ask the LLM to synthesize a cluster of skills into one meta-skill.
 * Returns null if the model responds with NO_MERGE or on error.
 */
async function synthesizeCluster(
  cluster: Cluster,
  model: string,
  apiKey: string,
): Promise<string | null> {
  const skillTexts = cluster.skills
    .map((s, i) => `[${i + 1}] ${s.text.trim()}`)
    .join("\n\n");

  const prompt = `You are consolidating a SkillBank of agent strategies. The following ${cluster.skills.length} skills cover similar territory. Synthesize them into ONE concise meta-skill (≤ 200 words) that subsumes all their key strategies without losing important nuance.

If the skills are too different to synthesize coherently, respond with exactly: NO_MERGE

Skills to merge:
${skillTexts}

Respond with the synthesized meta-skill text only (no preamble, no numbering, no "Meta-skill:" label). Or respond NO_MERGE.`;

  try {
    const { callOpenRouter } = await import("./openrouter.js");
    const resp = await callOpenRouter({
      apiKey,
      model,
      messages: [{ role: "user", content: prompt }],
      max_completion_tokens: 400,
      temperature: 0.2,
    });
    const text = (resp.content ?? "").trim();
    if (!text || text === "NO_MERGE") return null;
    return text;
  } catch {
    return null;
  }
}

// ── Main pipeline ─────────────────────────────────────────────────────────────

/**
 * Run the full merge pipeline:
 *   1. Load all live skills with embeddings
 *   2. Cluster by cosine similarity
 *   3. Synthesize each cluster via LLM
 *   4. Insert meta-skills, archive originals (in a single transaction per cluster)
 */
export async function mergeSkillClusters(
  model: string,
  apiKey: string,
  userConfig?: SkillBankConfig,
): Promise<MergeResult> {
  const threshold = userConfig?.mergeThreshold ?? DEFAULT_MERGE_THRESHOLD;
  const minSize = userConfig?.mergeMinClusterSize ?? DEFAULT_MERGE_MIN_CLUSTER_SIZE;
  const result: MergeResult = { clustersFound: 0, mergesCompleted: 0, skillsArchived: 0, skillsCreated: 0, errors: [] };

  try {
    const db = await _getSkillsDbForMerge();

    // Load all live skills with embeddings
    const rows = db
      .prepare("SELECT * FROM skills WHERE deleted = 0 AND embedding IS NOT NULL")
      .all() as Array<Record<string, unknown>>;

    if (rows.length === 0) return result;

    // Reconstruct Skill objects with embeddings
    const skills: Skill[] = rows.map((row) => ({
      id: row.id as string,
      version: row.version as number,
      text: row.text as string,
      embedding: _blobToEmbedding((row.embedding as Uint8Array | null) ?? null),
      sourceSession: row.source_session as string,
      extractionModel: row.extraction_model as string,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      useCount: row.use_count as number,
      successRate: row.success_rate as number,
      deleted: false,
      mergedInto: null,
      sourceSkills: null,
    }));

    const clusters = clusterSkills(skills, threshold, minSize);
    result.clustersFound = clusters.length;

    if (clusters.length === 0) return result;

    process.stderr.write(`[skillbank-merge] found ${clusters.length} clusters to synthesize\n`);

    for (const cluster of clusters) {
      const metaText = await synthesizeCluster(cluster, model, apiKey);
      if (!metaText) continue;

      // Embed the meta-skill
      let metaEmbedding: number[] | null = null;
      try {
        metaEmbedding = await localEmbed(metaText);
        if (!metaEmbedding) {
          const vecs = await getOpenRouterProvider().callEmbeddings!(apiKey, "", [metaText]);
          metaEmbedding = vecs[0] ?? null;
        }
      } catch {
        // Continue without embedding — skill still useful for FTS
      }

      const now = new Date().toISOString();
      const metaId = `sk_${crypto.randomBytes(3).toString("hex")}`;
      const sourceIds = cluster.skills.map((s) => s.id);

      // All writes in a single transaction
      try {
        db.transaction(() => {
          // Insert meta-skill
          db.prepare(`
            INSERT INTO skills
              (id, version, text, embedding, embedding_model, source_session,
               extraction_model, created_at, updated_at, use_count, success_rate,
               deleted, source_skills)
            VALUES (?, 1, ?, ?, ?, 'merge', ?, ?, ?, 0, 0.5, 0, ?)
          `).run(
            metaId,
            metaText,
            metaEmbedding ? _embeddingToBlob(metaEmbedding) : null,
            metaEmbedding ? "merged" : null,
            cluster.skills[0]?.extractionModel ?? model,
            now,
            now,
            JSON.stringify(sourceIds),
          );

          // Archive originals
          db.prepare(
            `UPDATE skills SET deleted = 1, merged_into = ?, updated_at = ? WHERE id IN (${sourceIds.map(() => "?").join(",")})`,
          ).run(metaId, now, ...sourceIds);
        })();

        // Update vec index — remove archived, add meta-skill
        try {
          for (const sourceId of sourceIds) {
            const delRow = db.prepare("SELECT rowid FROM skills WHERE id = ?").get(sourceId) as { rowid: number } | undefined;
            if (delRow) {
              db.prepare("DELETE FROM skills_vectors WHERE rowid = ?").run(delRow.rowid);
            }
          }
          if (metaEmbedding) {
            const inserted = db.prepare("SELECT rowid FROM skills WHERE id = ?").get(metaId) as { rowid: number } | undefined;
            if (inserted && _ensureSkillsVecTableForMerge(db, metaEmbedding.length)) {
              db.prepare("INSERT INTO skills_vectors (rowid, embedding) VALUES (?, ?)").run(
                inserted.rowid,
                _embeddingToBlob(metaEmbedding),
              );
            }
          }
        } catch { /* non-fatal — vec index self-heals on restart */ }

        // Update FTS index — remove archived, add meta-skill
        try {
          for (const sourceId of sourceIds) {
            const delRow = db.prepare("SELECT rowid FROM skills WHERE id = ?").get(sourceId) as { rowid: number } | undefined;
            if (delRow) {
              db.prepare("DELETE FROM skills_fts WHERE rowid = ?").run(delRow.rowid);
            }
          }
          const inserted = db.prepare("SELECT rowid FROM skills WHERE id = ?").get(metaId) as { rowid: number } | undefined;
          if (inserted) {
            db.prepare("INSERT INTO skills_fts (rowid, text) VALUES (?, ?)").run(inserted.rowid, metaText);
          }
        } catch { /* non-fatal */ }

        result.mergesCompleted++;
        result.skillsArchived += sourceIds.length;
        result.skillsCreated++;

        process.stderr.write(
          `[skillbank-merge] merged ${sourceIds.length} skills → ${metaId}\n`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`cluster merge failed: ${msg}`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(`pipeline error: ${msg}`);
  }

  return result;
}

/**
 * Dry-run: returns what would be merged without writing anything.
 */
export async function dryRunMerge(
  userConfig?: SkillBankConfig,
): Promise<{ clustersFound: number; clusters: Array<{ size: number; preview: string[] }> }> {
  const threshold = userConfig?.mergeThreshold ?? DEFAULT_MERGE_THRESHOLD;
  const minSize = userConfig?.mergeMinClusterSize ?? DEFAULT_MERGE_MIN_CLUSTER_SIZE;

  const db = await _getSkillsDbForMerge();
  const rows = db
    .prepare("SELECT * FROM skills WHERE deleted = 0 AND embedding IS NOT NULL")
    .all() as Array<Record<string, unknown>>;

  const skills: Skill[] = rows.map((row) => ({
    id: row.id as string,
    version: row.version as number,
    text: row.text as string,
    embedding: _blobToEmbedding((row.embedding as Uint8Array | null) ?? null),
    sourceSession: row.source_session as string,
    extractionModel: row.extraction_model as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    useCount: row.use_count as number,
    successRate: row.success_rate as number,
    deleted: false,
    mergedInto: null,
    sourceSkills: null,
  }));

  const clusters = clusterSkills(skills, threshold, minSize);

  return {
    clustersFound: clusters.length,
    clusters: clusters.map((c) => ({
      size: c.skills.length,
      preview: c.skills.slice(0, 3).map((s) => s.text.slice(0, 80) + (s.text.length > 80 ? "…" : "")),
    })),
  };
}
