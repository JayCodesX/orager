/**
 * SkillBank performance layer tests — sqlite-vec ANN, FTS5, local embeddings,
 * similarity gate, and graceful degradation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  retrieveSkills,
  extractSkillFromTrajectory,
  deleteSkill,
  listSkills,
  _resetSkillsDbForTesting,
  DEFAULT_SKILLBANK_CONFIG,
} from "../src/skillbank.js";

// ── Mocks ────────────────────────────────────────────────────────────────────

// Mock local embeddings — return deterministic vectors
vi.mock("../src/local-embeddings.js", () => ({
  localEmbed: vi.fn(async (text: string) => fakeEmbedding(text)),
  localEmbedBatch: vi.fn(async (texts: string[]) => texts.map(fakeEmbedding)),
  isLocalEmbeddingAvailable: vi.fn(() => true),
  LOCAL_EMBEDDING_DIM: 128,
  _resetLocalEmbeddingsForTesting: vi.fn(),
}));

// Mock OpenRouter provider (fallback path)
vi.mock("../src/providers/index.js", () => {
  const mockChat = vi.fn(async () => ({
    content: "When building URL shorteners, always validate input URLs before processing.",
    usage: { prompt_tokens: 100, completion_tokens: 50 },
  }));
  const mockCallEmbeddings = vi.fn(async (_key: string, _model: string, texts: string[]) =>
    texts.map((t: string) => fakeEmbedding(t)),
  );
  return {
    getOpenRouterProvider: () => ({
      chat: mockChat,
      callEmbeddings: mockCallEmbeddings,
    }),
  };
});

// Mock cosineSimilarity with real implementation
vi.mock("../src/memory.js", () => ({
  cosineSimilarity: (a: number[], b: number[]): number => {
    if (a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i]! * b[i]!;
      normA += a[i]! * a[i]!;
      normB += b[i]! * b[i]!;
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  },
}));

// ── Test helpers ─────────────────────────────────────────────────────────────

const DIM = 128;

/** Deterministic fake embedding using hash-spread approach. */
function fakeEmbedding(text: string): number[] {
  const vec = new Array(DIM).fill(0);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const base = (code * 31 + i * 7) % DIM;
    vec[base] += code / 500;
    vec[(base + 37) % DIM] += (code * 0.3) / 500;
    vec[(base + 73) % DIM] -= (code * 0.15) / 500;
  }
  const norm = Math.sqrt(vec.reduce((sum: number, v: number) => sum + v * v, 0));
  return vec.map((v: number) => v / (norm || 1));
}

const TEST_CONFIG = {
  ...DEFAULT_SKILLBANK_CONFIG,
  similarityThreshold: 0.01,
  topK: 10,
};

let tmpDir: string;

/** Write a minimal trajectory file that triggers extraction. */
async function writeTrajectory(sessionId: string, userMsg: string, assistantMsg: string): Promise<string> {
  const trajDir = path.join(tmpDir, "trajectories");
  await fs.mkdir(trajDir, { recursive: true });
  const trajPath = path.join(trajDir, `${sessionId}.jsonl`);
  const lines = [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: assistantMsg }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "text", text: userMsg }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Fixed." }] } }),
    JSON.stringify({ type: "result", subtype: "success", message: "done" }),
  ];
  await fs.writeFile(trajPath, lines.join("\n") + "\n");
  return trajPath;
}

// ── Setup/teardown ───────────────────────────────────────────────────────────

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orager-vec-test-"));
  process.env["ORAGER_SKILLS_DB_PATH"] = path.join(tmpDir, "skills.sqlite");
  _resetSkillsDbForTesting();
  vi.clearAllMocks();
});

afterEach(async () => {
  _resetSkillsDbForTesting();
  delete process.env["ORAGER_SKILLS_DB_PATH"];
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("SkillBank sqlite-vec + FTS5 + local embeddings", () => {

  describe("local embeddings", () => {
    it("uses local embeddings for skill extraction (no OpenRouter embedding call)", async () => {
      const trajPath = await writeTrajectory("local-1", "Fix this", "Here's the fix");
      const { getOpenRouterProvider } = await import("../src/providers/index.js");
      const mockCallEmbeddings = getOpenRouterProvider().callEmbeddings as ReturnType<typeof vi.fn>;

      await extractSkillFromTrajectory(trajPath, "local-1", "test-model", "key", "embed-model", TEST_CONFIG);

      // Local embeddings should have been used — OpenRouter callEmbeddings NOT called
      expect(mockCallEmbeddings).not.toHaveBeenCalled();

      const skills = await listSkills();
      expect(skills.length).toBe(1);
      expect(skills[0]!.embedding).not.toBeNull();
      expect(skills[0]!.embedding!.length).toBe(DIM);
    });
  });

  describe("retrieval", () => {
    it("retrieves skills by embedding similarity", async () => {
      const { getOpenRouterProvider } = await import("../src/providers/index.js");
      const mockChat = getOpenRouterProvider().chat as ReturnType<typeof vi.fn>;

      // First skill
      mockChat.mockResolvedValueOnce({
        content: "When implementing URL handlers, always validate input URLs with a regex check before processing them.",
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      });
      const traj1 = await writeTrajectory("s1", "Use early returns", "I used if/else instead");
      await extractSkillFromTrajectory(traj1, "s1", "m", "k", "em", TEST_CONFIG);

      // Second skill with distinct text
      mockChat.mockResolvedValueOnce({
        content: "Prefer flat function composition over deep class hierarchies for simple data transformations.",
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      });
      const traj2 = await writeTrajectory("s2", "Avoid premature abstraction", "I created too many classes");
      await extractSkillFromTrajectory(traj2, "s2", "m", "k", "em", TEST_CONFIG);

      const skills = await listSkills();
      expect(skills.length).toBe(2);

      // Retrieve with a query embedding
      const queryVec = fakeEmbedding("early return pattern");
      const results = await retrieveSkills(queryVec, TEST_CONFIG);
      expect(results.length).toBeGreaterThan(0);
    });

    it("returns empty when similarity gate blocks (no match above threshold)", async () => {
      const traj = await writeTrajectory("gate-1", "Fix bug", "Done");
      await extractSkillFromTrajectory(traj, "gate-1", "m", "k", "em", TEST_CONFIG);

      // Use a very high threshold — nothing should match
      const strictConfig = { ...TEST_CONFIG, similarityThreshold: 0.99 };
      const queryVec = fakeEmbedding("completely unrelated topic about cooking");
      const results = await retrieveSkills(queryVec, strictConfig);
      expect(results.length).toBe(0);
    });

    it("supplements vector results with FTS5 keyword matches", async () => {
      const traj = await writeTrajectory("fts-1", "Fix the early return", "Used if/else");
      await extractSkillFromTrajectory(traj, "fts-1", "m", "k", "em", TEST_CONFIG);

      // Query with text that should match FTS
      const queryVec = fakeEmbedding("something random");
      const results = await retrieveSkills(queryVec, TEST_CONFIG, "validate input URLs");
      // Should find via FTS even if vector similarity is low
      // (the extracted skill text contains "validate input URLs")
      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe("skill deletion", () => {
    it("deleted skills are excluded from retrieval", async () => {
      const traj = await writeTrajectory("del-1", "Fix this", "Here's fix");
      await extractSkillFromTrajectory(traj, "del-1", "m", "k", "em", TEST_CONFIG);

      let skills = await listSkills();
      expect(skills.length).toBe(1);

      await deleteSkill(skills[0]!.id);

      // Should not appear in retrieval
      const queryVec = fakeEmbedding("validate input");
      const results = await retrieveSkills(queryVec, TEST_CONFIG);
      expect(results.length).toBe(0);

      // Should not appear in default list
      skills = await listSkills();
      expect(skills.length).toBe(0);

      // But should appear when includeDeleted=true
      skills = await listSkills(true);
      expect(skills.length).toBe(1);
    });
  });

  describe("graceful degradation", () => {
    it("works without sqlite-vec (brute-force fallback)", async () => {
      // sqlite-vec may or may not be available in test env — either way, retrieval should work
      const traj = await writeTrajectory("bf-1", "Use early returns", "I used if/else");
      await extractSkillFromTrajectory(traj, "bf-1", "m", "k", "em", TEST_CONFIG);

      const queryVec = fakeEmbedding("early return pattern");
      const results = await retrieveSkills(queryVec, TEST_CONFIG);
      expect(results.length).toBeGreaterThan(0);
    });

    it("handles empty DB gracefully", async () => {
      const queryVec = fakeEmbedding("anything");
      const results = await retrieveSkills(queryVec, TEST_CONFIG);
      expect(results.length).toBe(0);
    });

    it("handles disabled skillbank", async () => {
      const queryVec = fakeEmbedding("anything");
      const results = await retrieveSkills(queryVec, { ...TEST_CONFIG, enabled: false });
      expect(results.length).toBe(0);
    });
  });

  describe("multiple skills and deduplication", () => {
    it("deduplicates near-identical skills", async () => {
      // Both trajectories will produce the same mock LLM output (same mockChat return)
      const traj1 = await writeTrajectory("dup-1", "Fix A", "Done A");
      const traj2 = await writeTrajectory("dup-2", "Fix A again", "Done A again");

      await extractSkillFromTrajectory(traj1, "dup-1", "m", "k", "em", TEST_CONFIG);
      await extractSkillFromTrajectory(traj2, "dup-2", "m", "k", "em", TEST_CONFIG);

      // Should only have 1 skill since both produce identical text
      const skills = await listSkills();
      expect(skills.length).toBe(1);
    });

    it("stores distinct skills when texts differ", async () => {
      const { getOpenRouterProvider } = await import("../src/providers/index.js");
      const mockChat = getOpenRouterProvider().chat as ReturnType<typeof vi.fn>;

      // First extraction
      mockChat.mockResolvedValueOnce({
        content: "When building services, always validate input before processing.",
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      });
      const traj1 = await writeTrajectory("dist-1", "Fix validation", "Missing check");
      await extractSkillFromTrajectory(traj1, "dist-1", "m", "k", "em", TEST_CONFIG);

      // Second extraction with different skill text
      mockChat.mockResolvedValueOnce({
        content: "Prefer flat function composition over deep class hierarchies for simple transformations.",
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      });
      const traj2 = await writeTrajectory("dist-2", "Too many abstractions", "Simplified");
      await extractSkillFromTrajectory(traj2, "dist-2", "m", "k", "em", TEST_CONFIG);

      const skills = await listSkills();
      expect(skills.length).toBe(2);
    });
  });
});
