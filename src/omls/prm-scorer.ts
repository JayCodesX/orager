/**
 * prm-scorer.ts — ADR-0007
 *
 * Process Reward Model (PRM) scorer. Scores each trajectory turn on a
 * [0.0, 1.0] scale using an LLM-as-judge call.
 *
 * The PRM is used in two places:
 *   1. During multi-teacher race mode: score teacher responses in parallel
 *      and select the winner before adding to the training batch.
 *   2. During training batch preparation: score the full trajectory to
 *      produce per-turn reward labels for GRPO/OPSD.
 *
 * All functions are non-fatal — errors return a default score of 0.5.
 */

import { getOpenRouterProvider } from "../providers/index.js";
import type { TrajectoryMeta } from "../trajectory-logger.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TurnScore {
  /** Turn index (0-based). */
  turn: number;
  /** Score in [0.0, 1.0]. Higher = better. */
  score: number;
  /** Raw judge reasoning (first 200 chars). */
  reasoning: string;
}

export interface TrajectoryScore {
  sessionId: string;
  turns: TurnScore[];
  /** Mean score across all turns. */
  meanScore: number;
  /** Weighted score: penalises trajectories that required more turns to succeed. */
  weightedScore: number;
}

// ── Prompts ───────────────────────────────────────────────────────────────────

const PRM_SYSTEM_PROMPT = `You are evaluating the quality of an AI agent's action at a single turn.
Score the action on a scale from 0.0 to 1.0:
  1.0 = perfectly correct, efficient, and directly moves toward the goal
  0.7 = correct but slightly verbose or inefficient
  0.5 = neutral or unclear contribution
  0.3 = partially incorrect or introduces unnecessary complexity
  0.0 = wrong, harmful, or moves away from the goal

Context:
- The task is stated in the conversation history
- Focus on the MOST RECENT assistant action only
- Be calibrated: reserve 1.0 for truly excellent actions

Output ONLY a JSON object: {"score": <float>, "reasoning": "<one sentence>"}
No preamble, no markdown fences.`;

// ── Single-turn scoring ───────────────────────────────────────────────────────

/**
 * Score a single assistant turn using the PRM judge.
 */
export async function scoreTurn(
  conversationContext: string,
  assistantAction: string,
  judgeModel: string,
  apiKey: string,
): Promise<TurnScore & { turnIndex: number }> {
  const DEFAULT_SCORE = 0.5;
  const turnIndex = 0; // caller sets this

  try {
    const result = await getOpenRouterProvider().chat({
      apiKey,
      model: judgeModel,
      messages: [
        { role: "system", content: PRM_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Conversation context:\n${conversationContext.slice(0, 3000)}\n\nAssistant action to score:\n${assistantAction.slice(0, 1000)}`,
        },
      ],
      max_completion_tokens: 150,
      temperature: 0.1,
    });

    const raw = result.content.trim();
    // Strip markdown fences if model added them
    const cleaned = raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
    const parsed = JSON.parse(cleaned) as { score?: number; reasoning?: string };
    const score = typeof parsed.score === "number"
      ? Math.max(0, Math.min(1, parsed.score))
      : DEFAULT_SCORE;
    const reasoning = typeof parsed.reasoning === "string"
      ? parsed.reasoning.slice(0, 200)
      : "";

    return { turn: turnIndex, score, reasoning, turnIndex };
  } catch {
    return { turn: turnIndex, score: DEFAULT_SCORE, reasoning: "scoring_error", turnIndex };
  }
}

// ── Full trajectory scoring ───────────────────────────────────────────────────

interface TrajectoryEvent {
  type: string;
  message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
  name?: string;
  subtype?: string;
}

/**
 * Score all turns in a trajectory file.
 * Reads the .jsonl, reconstructs the conversation, and calls the PRM
 * judge for each assistant turn.
 *
 * @param jsonlPath  - Path to the trajectory .jsonl file
 * @param meta       - Trajectory metadata
 * @param judgeModel - LLM to use as PRM judge
 * @param apiKey     - OpenRouter API key
 */
export async function scoreTrajectory(
  jsonlPath: string,
  meta: TrajectoryMeta,
  judgeModel: string,
  apiKey: string,
): Promise<TrajectoryScore> {
  const { readFile } = await import("node:fs/promises");

  let raw: string;
  try {
    raw = await readFile(jsonlPath, "utf8");
  } catch {
    return { sessionId: meta.sessionId, turns: [], meanScore: 0.5, weightedScore: 0.5 };
  }

  const events: TrajectoryEvent[] = [];
  for (const line of raw.split("\n").filter(Boolean)) {
    try {
      events.push(JSON.parse(line) as TrajectoryEvent);
    } catch { /* skip malformed */ }
  }

  // Rebuild conversation context and score each assistant turn
  const contextParts: string[] = [`Task: ${meta.prompt}`];
  const turnScores: TurnScore[] = [];
  let turnIdx = 0;

  for (const event of events) {
    if (event.type === "assistant") {
      let actionText = "";
      const content = event.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && block.text) {
            actionText += block.text.slice(0, 500);
          }
        }
      }
      if (actionText) {
        const context = contextParts.join("\n").slice(-2000);
        const scored = await scoreTurn(context, actionText, judgeModel, apiKey);
        turnScores.push({ turn: turnIdx, score: scored.score, reasoning: scored.reasoning });
        turnIdx++;
        contextParts.push(`[assistant turn ${turnIdx}]: ${actionText.slice(0, 200)}`);
      }
    } else if (event.type === "tool") {
      contextParts.push(`[tool result]`);
    }
  }

  if (turnScores.length === 0) {
    return { sessionId: meta.sessionId, turns: [], meanScore: 0.5, weightedScore: 0.5 };
  }

  const meanScore = turnScores.reduce((s, t) => s + t.score, 0) / turnScores.length;

  // Weighted score: penalise trajectories that needed more turns (efficiency bonus)
  const efficiencyPenalty = Math.max(0, (turnScores.length - 3) * 0.02); // -2% per turn > 3
  const weightedScore = Math.max(0, meanScore - efficiencyPenalty);

  return { sessionId: meta.sessionId, turns: turnScores, meanScore, weightedScore };
}

// ── Teacher race scoring ──────────────────────────────────────────────────────

/**
 * Given multiple teacher model responses to the same prompt, use the PRM
 * to score each and return the winner.
 *
 * Used in multi-teacher race mode (ADR-0007 §3).
 */
export async function pickBestTeacherResponse(
  prompt: string,
  responses: Array<{ model: string; content: string }>,
  judgeModel: string,
  apiKey: string,
): Promise<{ winner: typeof responses[0]; scores: Array<{ model: string; score: number }> }> {
  // Score all responses in parallel
  const scored = await Promise.all(
    responses.map(async (r) => {
      const result = await scoreTurn(prompt, r.content, judgeModel, apiKey);
      return { model: r.model, content: r.content, score: result.score };
    }),
  );

  // Pick highest score; ties go to first response
  scored.sort((a, b) => b.score - a.score);
  const winner = scored[0]!;

  return {
    winner: { model: winner.model, content: winner.content },
    scores: scored.map((s) => ({ model: s.model, score: s.score })),
  };
}
