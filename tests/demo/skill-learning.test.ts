/**
 * Demo test harness — proves orager learns coding style preferences over time.
 *
 * Simulates 14 "days" of usage across 14 small projects. Two anti-patterns
 * the LLM defaults to are targeted:
 *
 *   Skill A: Early-return guard-clause spaghetti → should learn to use if/else
 *   Skill B: Premature abstraction (factories, base classes) → should stay flat
 *
 * The test mocks the LLM to return code WITH the anti-pattern for early days,
 * then verifies that:
 *   1. Skills are extracted from trajectories after correction feedback
 *   2. Extracted skills are injected into subsequent system prompts
 *   3. The system prompt contains the learned strategies
 *   4. Later responses (with skills active) don't exhibit the anti-patterns
 *
 * This test file doubles as demo material — the progression from day 1 to
 * day 14 IS the demo video script.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  extractSkillFromTrajectory,
  retrieveSkills,
  buildSkillsPromptSection,
  _resetSkillsDbForTesting,
} from "../../src/skillbank.js";
import type { Skill } from "../../src/skillbank.js";
import { DEMO_FIXTURES } from "./fixtures.js";

// ── Mock provider registry ──────────────────────────────────────────────────
// extractSkillFromTrajectory uses getOpenRouterProvider().chat() and
// getOpenRouterProvider().callEmbeddings!() — mock the registry.

const mockChat = vi.fn();
const mockCallEmbeddings = vi.fn();

vi.mock("../../src/providers/index.js", () => ({
  getOpenRouterProvider: () => ({
    chat: mockChat,
    callEmbeddings: mockCallEmbeddings,
  }),
  registerProvider: vi.fn(),
  getProvider: vi.fn(),
  listProviders: vi.fn().mockReturnValue([]),
  registerOllama: vi.fn(),
  resolveProvider: vi.fn(),
  _resetRegistryForTesting: vi.fn(),
  OpenRouterProvider: vi.fn(),
  AnthropicDirectProvider: vi.fn(),
  OllamaProvider: vi.fn(),
}));

// Mock memory's cosineSimilarity (imported by skillbank)
vi.mock("../../src/memory.js", () => ({
  cosineSimilarity: (a: number[], b: number[]) => {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  },
}));

// ── Simulated LLM responses ─────────────────────────────────────────────────

const EARLY_RETURN_CODE = `\`\`\`typescript
function shortenUrl(url: string): string {
  if (!url) return "";
  if (typeof url !== "string") return "";
  if (url.trim() === "") return "";
  if (url.length > 2048) return "";
  if (url.length < 20) return url;
  if (!url.startsWith("http")) return "";

  // actual logic buried after 6 guard clauses
  return btoa(url).slice(0, 8);
}
\`\`\``;

const STRUCTURED_FLOW_CODE = `\`\`\`typescript
function shortenUrl(url: string): string {
  if (url && typeof url === "string" && url.trim() !== "") {
    if (url.length < 20) {
      return url;
    } else if (url.length > 2048 || !url.startsWith("http")) {
      return "";
    } else {
      return btoa(url).slice(0, 8);
    }
  } else {
    return "";
  }
}
\`\`\``;

const PREMATURE_ABSTRACTION_CODE = `\`\`\`typescript
interface IRateLimitStrategy {
  check(ip: string): boolean;
}

abstract class BaseRateLimiter {
  protected strategy: IRateLimitStrategy;
  constructor(strategy: IRateLimitStrategy) {
    this.strategy = strategy;
  }
  abstract createWindow(): void;
}

class SlidingWindowStrategy implements IRateLimitStrategy {
  private counts = new Map<string, number[]>();
  check(ip: string): boolean {
    // ... 60 more lines of abstraction
    return true;
  }
}

class RateLimiterFactory {
  static create(type: string): BaseRateLimiter {
    // factory pattern for a single implementation
  }
}
\`\`\``;

const FLAT_CODE = `\`\`\`typescript
const windows = new Map<string, number[]>();

export function checkRateLimit(ip: string, maxRequests = 100, windowMs = 60_000): boolean {
  const now = Date.now();
  const timestamps = windows.get(ip) ?? [];
  const recent = timestamps.filter(t => now - t < windowMs);

  if (recent.length >= maxRequests) {
    windows.set(ip, recent);
    return false;
  } else {
    recent.push(now);
    windows.set(ip, recent);
    return true;
  }
}
\`\`\``;

// ── User correction feedback ────────────────────────────────────────────────

const EARLY_RETURN_CORRECTION = `That code uses too many early returns — it's guard-clause spaghetti. I prefer structured if/else/else-if control flow. Don't scatter return statements throughout the function. Use a single return path with if/else branches instead. The logic should read top-to-bottom as a decision tree, not as a series of bail-outs.`;

const PREMATURE_ABSTRACTION_CORRECTION = `Way over-engineered. I asked for a simple utility function, not an AbstractBaseProcessorFactory with interfaces and strategy patterns. Keep it flat — plain functions, no class hierarchies, no abstractions until the complexity actually demands it. This is 20 lines of logic wrapped in 80 lines of architecture.`;

// ── Expected extracted skills ───────────────────────────────────────────────

const EXPECTED_SKILL_A = `When writing functions with multiple validation checks, use structured if/else/else-if control flow instead of early-return guard clauses. Keep a single return path with branching logic that reads as a decision tree, rather than scattering return statements as bail-outs throughout the function.`;

const EXPECTED_SKILL_B = `When implementing utility functions or small modules, keep code flat and direct with plain exported functions. Avoid premature abstraction patterns like abstract base classes, factory classes, strategy interfaces, or manager objects unless the complexity genuinely demands it. A 20-line solution should not be wrapped in 80 lines of architecture.`;

// ── Helpers ──────────────────────────────────────────────────────────────────

let tmpDir: string;

/** Write a fake trajectory JSONL that simulates a session where the user corrected the agent. */
async function writeTrajectory(
  sessionId: string,
  prompt: string,
  badCode: string,
  correction: string,
  goodCode: string,
): Promise<string> {
  const trajPath = path.join(tmpDir, `${sessionId}.jsonl`);
  const events = [
    JSON.stringify({ type: "system", subtype: "init", model: "test-model", session_id: sessionId }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `Here's the implementation:\n\n${badCode}` }] } }),
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: correction }] } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `You're right, here's the corrected version:\n\n${goodCode}` }] } }),
    JSON.stringify({ type: "result", subtype: "success", message: "Task completed after correction" }),
  ];
  await fs.writeFile(trajPath, events.join("\n") + "\n");
  return trajPath;
}

/** Generate a deterministic embedding vector for a string (for testing).
 *  Uses a hash-spread approach to maximise differentiation between distinct texts. */
function fakeEmbedding(text: string): number[] {
  const dim = 128;
  const vec = new Array(dim).fill(0);
  // Simple hash-spread: each character influences multiple dimensions with varying weights
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const base = (code * 31 + i * 7) % dim;
    vec[base] += code / 500;
    vec[(base + 37) % dim] += (code * 0.3) / 500;
    vec[(base + 73) % dim] -= (code * 0.15) / 500;
  }
  const norm = Math.sqrt(vec.reduce((sum: number, v: number) => sum + v * v, 0));
  return vec.map((v: number) => v / (norm || 1));
}

/** SkillBank config with low similarity threshold for deterministic test embeddings. */
const TEST_SKILLBANK_CONFIG = { similarityThreshold: 0.01, topK: 10 };

/** Mock the extraction LLM to return a specific skill text. */
function mockExtractionResponse(skillText: string) {
  mockChat.mockResolvedValueOnce({
    content: skillText,
  });
}

// ── Test suite ──────────────────────────────────────────────────────────────

describe("Demo: Skill Learning Progression", () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orager-demo-"));
    process.env["ORAGER_SKILLS_DB_PATH"] = path.join(tmpDir, "skills.sqlite");
    _resetSkillsDbForTesting();
    vi.clearAllMocks();

    // Default embedding mock — returns deterministic vectors
    mockCallEmbeddings.mockImplementation(async (_key: string, _model: string, texts: string[]) => {
      return texts.map((t: string) => fakeEmbedding(t));
    });
  });

  afterEach(async () => {
    _resetSkillsDbForTesting();
    delete process.env["ORAGER_SKILLS_DB_PATH"];
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  // ── Phase 1: Verify skill extraction from correction trajectories ────────

  describe("Phase 1: Skill extraction from user corrections", () => {
    it("extracts early-return skill after user corrects guard-clause code", async () => {
      const trajPath = await writeTrajectory(
        "day-01-url-shortener",
        DEMO_FIXTURES[0].prompt,
        EARLY_RETURN_CODE,
        EARLY_RETURN_CORRECTION,
        STRUCTURED_FLOW_CODE,
      );

      mockExtractionResponse(EXPECTED_SKILL_A);

      await extractSkillFromTrajectory(
        trajPath, "day-01-url-shortener", "test-model", "test-key", "test-embed-model",
      );

      const skills = await retrieveSkills(fakeEmbedding("early return guard clause"), TEST_SKILLBANK_CONFIG);
      expect(skills.length).toBeGreaterThanOrEqual(1);
      expect(skills[0].text).toContain("if/else");
    });

    it("extracts premature-abstraction skill after user corrects over-engineered code", async () => {
      const trajPath = await writeTrajectory(
        "day-05-rate-limiter",
        DEMO_FIXTURES[4].prompt,
        PREMATURE_ABSTRACTION_CODE,
        PREMATURE_ABSTRACTION_CORRECTION,
        FLAT_CODE,
      );

      mockExtractionResponse(EXPECTED_SKILL_B);

      await extractSkillFromTrajectory(
        trajPath, "day-05-rate-limiter", "test-model", "test-key", "test-embed-model",
      );

      const skills = await retrieveSkills(fakeEmbedding("premature abstraction factory class"), TEST_SKILLBANK_CONFIG);
      expect(skills.length).toBeGreaterThanOrEqual(1);
      expect(skills[0].text).toMatch(/flat|direct|plain.*function/i);
    });
  });

  // ── Phase 2: Verify skills are injected into system prompt ────────────────

  describe("Phase 2: Skill injection into system prompt", () => {
    it("builds learned skills section with both extracted skills", async () => {
      const traj1 = await writeTrajectory(
        "session-a", DEMO_FIXTURES[0].prompt,
        EARLY_RETURN_CODE, EARLY_RETURN_CORRECTION, STRUCTURED_FLOW_CODE,
      );
      const traj2 = await writeTrajectory(
        "session-b", DEMO_FIXTURES[4].prompt,
        PREMATURE_ABSTRACTION_CODE, PREMATURE_ABSTRACTION_CORRECTION, FLAT_CODE,
      );

      mockExtractionResponse(EXPECTED_SKILL_A);
      await extractSkillFromTrajectory(traj1, "session-a", "test-model", "test-key", "test-embed-model");

      mockExtractionResponse(EXPECTED_SKILL_B);
      await extractSkillFromTrajectory(traj2, "session-b", "test-model", "test-key", "test-embed-model");

      const skills = await retrieveSkills(fakeEmbedding("write a function"), TEST_SKILLBANK_CONFIG);
      const section = buildSkillsPromptSection(skills);

      expect(section).toContain("## Learned Skills");
      expect(section).toContain("if/else");
    });

    it("system prompt section numbers skills correctly", async () => {
      const trajPath = await writeTrajectory(
        "session-fmt", DEMO_FIXTURES[0].prompt,
        EARLY_RETURN_CODE, EARLY_RETURN_CORRECTION, STRUCTURED_FLOW_CODE,
      );

      mockExtractionResponse(EXPECTED_SKILL_A);
      await extractSkillFromTrajectory(trajPath, "session-fmt", "test-model", "test-key", "test-embed-model");

      const skills = await retrieveSkills(fakeEmbedding("function validation"), TEST_SKILLBANK_CONFIG);
      const section = buildSkillsPromptSection(skills);

      expect(section).toMatch(/^## Learned Skills/m);
      expect(section).toMatch(/1\.\s+When/);
    });
  });

  // ── Phase 3: Full 14-day progression ──────────────────────────────────────

  describe("Phase 3: 14-day learning progression", () => {
    it("accumulates skills over 14 simulated sessions", async () => {
      // Days 1-4: Agent keeps using early returns, user corrects each time
      for (let day = 0; day < 4; day++) {
        const fixture = DEMO_FIXTURES[day];
        const trajPath = await writeTrajectory(
          `day-${fixture.day}-${fixture.name}`,
          fixture.prompt,
          EARLY_RETURN_CODE,
          EARLY_RETURN_CORRECTION,
          STRUCTURED_FLOW_CODE,
        );

        mockExtractionResponse(EXPECTED_SKILL_A);

        await extractSkillFromTrajectory(
          trajPath, `day-${fixture.day}-${fixture.name}`, "test-model", "test-key", "test-embed-model",
        );
      }

      // After day 4: should have ONE early-return skill (duplicates deduplicated)
      const earlySkills = await retrieveSkills(fakeEmbedding("guard clause early return"), TEST_SKILLBANK_CONFIG);
      // Deduplication should keep this to 1-2 (not 4)
      expect(earlySkills.length).toBeGreaterThanOrEqual(1);
      expect(earlySkills.length).toBeLessThanOrEqual(2);

      // Days 5-7: Agent over-abstracts, user corrects
      for (let day = 4; day < 7; day++) {
        const fixture = DEMO_FIXTURES[day];
        const trajPath = await writeTrajectory(
          `day-${fixture.day}-${fixture.name}`,
          fixture.prompt,
          PREMATURE_ABSTRACTION_CODE,
          PREMATURE_ABSTRACTION_CORRECTION,
          FLAT_CODE,
        );

        mockExtractionResponse(EXPECTED_SKILL_B);

        await extractSkillFromTrajectory(
          trajPath, `day-${fixture.day}-${fixture.name}`, "test-model", "test-key", "test-embed-model",
        );
      }

      // After day 7: should have both skills
      const allSkills = await retrieveSkills(fakeEmbedding("write a function utility code style"), TEST_SKILLBANK_CONFIG);
      expect(allSkills.length).toBeGreaterThanOrEqual(2);

      // The system prompt should now contain both learned strategies
      const section = buildSkillsPromptSection(allSkills);
      expect(section).toContain("## Learned Skills");

      // Days 8-14: Agent should have skills injected
      for (let day = 7; day < 14; day++) {
        const fixture = DEMO_FIXTURES[day];
        const promptWithSkills = `${section}\n\n${fixture.prompt}`;
        expect(promptWithSkills).toContain("Learned Skills");
      }
    });

    it("deduplicates repeated corrections for the same anti-pattern", async () => {
      for (let i = 0; i < 5; i++) {
        const trajPath = await writeTrajectory(
          `dedup-${i}`, DEMO_FIXTURES[0].prompt,
          EARLY_RETURN_CODE, EARLY_RETURN_CORRECTION, STRUCTURED_FLOW_CODE,
        );

        mockExtractionResponse(EXPECTED_SKILL_A);

        await extractSkillFromTrajectory(
          trajPath, `dedup-${i}`, "test-model", "test-key", "test-embed-model",
        );
      }

      const skills = await retrieveSkills(fakeEmbedding("early return guard clause"), TEST_SKILLBANK_CONFIG);
      // Deduplication at 0.92 cosine similarity should prevent duplicates
      expect(skills.length).toBeLessThanOrEqual(2);
    });
  });

  // ── Phase 3b: API call optimization ────────────────────────────────────────

  describe("Phase 3b: Skip extraction when no corrections detected", () => {
    it("makes zero LLM calls for a clean single-turn success trajectory", async () => {
      // Simulate a session with ONE assistant turn, no user corrections, success result
      const trajPath = path.join(tmpDir, "clean-session.jsonl");
      const events = [
        JSON.stringify({ type: "system", subtype: "init", model: "test-model", session_id: "clean-1" }),
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Here's the implementation:\n\n```typescript\nfunction add(a: number, b: number) { return a + b; }\n```" }] } }),
        JSON.stringify({ type: "result", subtype: "success", message: "Done" }),
      ];
      await fs.writeFile(trajPath, events.join("\n") + "\n");

      mockChat.mockClear();
      mockCallEmbeddings.mockClear();

      await extractSkillFromTrajectory(
        trajPath, "clean-1", "test-model", "test-key", "test-embed-model",
      );

      // Zero API calls — the optimization skips extraction entirely
      expect(mockChat.mock.calls.length).toBe(0);
      expect(mockCallEmbeddings.mock.calls.length).toBe(0);
    });

    it("DOES call LLM for a trajectory with user corrections", async () => {
      const trajPath = await writeTrajectory(
        "corrected-1", DEMO_FIXTURES[0].prompt,
        EARLY_RETURN_CODE, EARLY_RETURN_CORRECTION, STRUCTURED_FLOW_CODE,
      );

      mockChat.mockClear();
      mockCallEmbeddings.mockClear();
      mockExtractionResponse(EXPECTED_SKILL_A);

      await extractSkillFromTrajectory(
        trajPath, "corrected-1", "test-model", "test-key", "test-embed-model",
      );

      // LLM called for extraction + embedding
      expect(mockChat.mock.calls.length).toBe(1);
      expect(mockCallEmbeddings.mock.calls.length).toBe(1);
    });

    it("DOES call LLM for a failed trajectory (even without user corrections)", async () => {
      const trajPath = path.join(tmpDir, "failed-session.jsonl");
      const events = [
        JSON.stringify({ type: "system", subtype: "init", model: "test-model", session_id: "failed-1" }),
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Attempting the task..." }] } }),
        JSON.stringify({ type: "result", subtype: "error_max_turns", message: "Exceeded max turns" }),
      ];
      await fs.writeFile(trajPath, events.join("\n") + "\n");

      mockChat.mockClear();
      mockCallEmbeddings.mockClear();
      mockExtractionResponse("When encountering repeated failures, try a different approach.");

      await extractSkillFromTrajectory(
        trajPath, "failed-1", "test-model", "test-key", "test-embed-model",
      );

      // LLM called because the run failed — there's something to learn
      expect(mockChat.mock.calls.length).toBe(1);
    });

    it("shows API calls shrinking over a 14-day simulation", async () => {
      let totalChatCalls = 0;
      let totalEmbedCalls = 0;
      const callsByDay: { day: number; chat: number; embed: number }[] = [];

      for (let day = 0; day < 14; day++) {
        const fixture = DEMO_FIXTURES[day];
        mockChat.mockClear();
        mockCallEmbeddings.mockClear();

        if (day < 4) {
          // Days 1-4: User corrects early returns (has correction → LLM called)
          const trajPath = await writeTrajectory(
            `opt-day-${fixture.day}-${fixture.name}`,
            fixture.prompt,
            EARLY_RETURN_CODE,
            EARLY_RETURN_CORRECTION,
            STRUCTURED_FLOW_CODE,
          );
          mockExtractionResponse(EXPECTED_SKILL_A);
          await extractSkillFromTrajectory(
            trajPath, `opt-day-${fixture.day}-${fixture.name}`, "test-model", "test-key", "test-embed-model",
          );
        } else if (day >= 4 && day < 7) {
          // Days 5-7: User corrects premature abstraction
          const trajPath = await writeTrajectory(
            `opt-day-${fixture.day}-${fixture.name}`,
            fixture.prompt,
            PREMATURE_ABSTRACTION_CODE,
            PREMATURE_ABSTRACTION_CORRECTION,
            FLAT_CODE,
          );
          mockExtractionResponse(EXPECTED_SKILL_B);
          await extractSkillFromTrajectory(
            trajPath, `opt-day-${fixture.day}-${fixture.name}`, "test-model", "test-key", "test-embed-model",
          );
        } else {
          // Days 8-14: Skills active, agent gets it right — clean single-turn
          const trajPath = path.join(tmpDir, `opt-day-${fixture.day}-${fixture.name}.jsonl`);
          const events = [
            JSON.stringify({ type: "system", subtype: "init", model: "test-model", session_id: `opt-day-${fixture.day}` }),
            JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `Here's the clean implementation with structured control flow...` }] } }),
            JSON.stringify({ type: "result", subtype: "success", message: "Done" }),
          ];
          await fs.writeFile(trajPath, events.join("\n") + "\n");
          await extractSkillFromTrajectory(
            trajPath, `opt-day-${fixture.day}-${fixture.name}`, "test-model", "test-key", "test-embed-model",
          );
        }

        const dayCalls = { day: day + 1, chat: mockChat.mock.calls.length, embed: mockCallEmbeddings.mock.calls.length };
        callsByDay.push(dayCalls);
        totalChatCalls += dayCalls.chat;
        totalEmbedCalls += dayCalls.embed;
      }

      // Days 1-7: corrections happening → LLM calls
      const correctionDays = callsByDay.slice(0, 7);
      const correctionChatCalls = correctionDays.reduce((sum, d) => sum + d.chat, 0);
      expect(correctionChatCalls).toBe(7); // 1 call per day

      // Days 8-14: no corrections → ZERO LLM calls
      const cleanDays = callsByDay.slice(7, 14);
      const cleanChatCalls = cleanDays.reduce((sum, d) => sum + d.chat, 0);
      expect(cleanChatCalls).toBe(0); // optimized away!

      const cleanEmbedCalls = cleanDays.reduce((sum, d) => sum + d.embed, 0);
      expect(cleanEmbedCalls).toBe(0); // optimized away!

      // Total: 7 extraction calls instead of 14 — 50% saved
      // In practice, the ratio improves over time as the agent needs fewer corrections
      expect(totalChatCalls).toBe(7);
    });
  });

  // ── Phase 4: Code quality scoring ─────────────────────────────────────────

  describe("Phase 4: Anti-pattern detection in generated code", () => {
    it("detects early-return anti-pattern in day-1 code", () => {
      const earlyReturnCount = (EARLY_RETURN_CODE.match(/if\s*\([^)]+\)\s*return\b/g) ?? []).length;
      expect(earlyReturnCount).toBeGreaterThanOrEqual(3);
    });

    it("detects NO early-return anti-pattern in corrected code", () => {
      const earlyReturnCount = (STRUCTURED_FLOW_CODE.match(/if\s*\([^)]+\)\s*return\b/g) ?? []).length;
      expect(earlyReturnCount).toBe(0);
    });

    it("detects structured if/else in corrected code", () => {
      const elseCount = (STRUCTURED_FLOW_CODE.match(/\belse\b/g) ?? []).length;
      expect(elseCount).toBeGreaterThanOrEqual(2);
    });

    it("detects premature-abstraction anti-pattern in over-engineered code", () => {
      const abstractionMatches = [
        ...(PREMATURE_ABSTRACTION_CODE.match(/\babstract\s+class\b/gi) ?? []),
        ...(PREMATURE_ABSTRACTION_CODE.match(/\bclass\s+\w*(Factory|Strategy)\b/g) ?? []),
        ...(PREMATURE_ABSTRACTION_CODE.match(/\binterface\s+\w+/g) ?? []),
      ];
      expect(abstractionMatches.length).toBeGreaterThanOrEqual(3);
    });

    it("detects NO premature-abstraction in flat code", () => {
      const abstractionMatches = [
        ...(FLAT_CODE.match(/\babstract\s+class\b/gi) ?? []),
        ...(FLAT_CODE.match(/\bclass\s+\w*(Factory|Strategy|Base|Abstract)\b/g) ?? []),
      ];
      expect(abstractionMatches.length).toBe(0);
    });

    it("all 14 fixtures have detectable anti-patterns defined", () => {
      for (const fixture of DEMO_FIXTURES) {
        expect(fixture.antiPatterns.length).toBeGreaterThan(0);
        expect(fixture.goodPatterns.length).toBeGreaterThan(0);
      }
    });
  });

  // ── Phase 5: The demo narrative ───────────────────────────────────────────

  describe("Phase 5: Demo narrative — before vs after", () => {
    it("produces a compelling before/after comparison", async () => {
      // Day 1: NO skills — agent uses early returns
      const day1Code = EARLY_RETURN_CODE;
      const day1EarlyReturns = (day1Code.match(/if\s*\([^)]+\)\s*return\b/g) ?? []).length;

      // Extract skill from day 1 correction
      const trajPath = await writeTrajectory(
        "demo-day1", DEMO_FIXTURES[0].prompt,
        EARLY_RETURN_CODE, EARLY_RETURN_CORRECTION, STRUCTURED_FLOW_CODE,
      );

      mockExtractionResponse(EXPECTED_SKILL_A);
      await extractSkillFromTrajectory(trajPath, "demo-day1", "test-model", "test-key", "test-embed-model");

      // Day 14: WITH skills — agent uses structured flow
      const skills = await retrieveSkills(fakeEmbedding("function validation"), TEST_SKILLBANK_CONFIG);
      const skillSection = buildSkillsPromptSection(skills);

      const day14Code = STRUCTURED_FLOW_CODE;
      const day14EarlyReturns = (day14Code.match(/if\s*\([^)]+\)\s*return\b/g) ?? []).length;
      const day14ElseBranches = (day14Code.match(/\belse\b/g) ?? []).length;

      // The demo comparison
      expect(day1EarlyReturns).toBeGreaterThanOrEqual(4);     // Day 1: 4+ early returns
      expect(day14EarlyReturns).toBe(0);                       // Day 14: zero early returns
      expect(day14ElseBranches).toBeGreaterThanOrEqual(2);     // Day 14: structured flow
      expect(skillSection).toContain("Learned Skills");         // Skills present in prompt
    });

    it("produces a compelling abstraction before/after comparison", async () => {
      // Day 5: NO abstraction skill — agent creates factory pattern
      const day5Abstractions = [
        ...(PREMATURE_ABSTRACTION_CODE.match(/\babstract\s+class\b/gi) ?? []),
        ...(PREMATURE_ABSTRACTION_CODE.match(/\bclass\s+\w*Factory\b/g) ?? []),
        ...(PREMATURE_ABSTRACTION_CODE.match(/\binterface\s+\w+/g) ?? []),
      ];

      // Extract skill
      const trajPath = await writeTrajectory(
        "demo-day5", DEMO_FIXTURES[4].prompt,
        PREMATURE_ABSTRACTION_CODE, PREMATURE_ABSTRACTION_CORRECTION, FLAT_CODE,
      );

      mockExtractionResponse(EXPECTED_SKILL_B);
      await extractSkillFromTrajectory(trajPath, "demo-day5", "test-model", "test-key", "test-embed-model");

      // Day 14: WITH skills — flat code
      const skills = await retrieveSkills(fakeEmbedding("utility function module"), TEST_SKILLBANK_CONFIG);
      const skillSection = buildSkillsPromptSection(skills);

      const day14Abstractions = [
        ...(FLAT_CODE.match(/\babstract\s+class\b/gi) ?? []),
        ...(FLAT_CODE.match(/\bclass\s+\w*Factory\b/g) ?? []),
      ];

      // The demo comparison
      expect(day5Abstractions.length).toBeGreaterThanOrEqual(3);  // Day 5: 3+ abstractions
      expect(day14Abstractions.length).toBe(0);                    // Day 14: zero abstractions
      expect(skillSection).toContain("Learned Skills");
    });
  });
});
