/**
 * Generates alternative prompt framings when the agent appears stuck.
 * Called by the loop when identicalTurnStreak fires repeatedly or
 * when the agent explicitly asks for help.
 */

const VARIATION_TEMPLATES = [
  (original: string) =>
    `${original}\n\n[Hint: Your previous attempts have not succeeded. Try a completely different approach. ` +
    `If using a tool that keeps failing, try an alternative tool or method.]`,

  (original: string) =>
    `${original}\n\n[Hint: Break this task into smaller steps. What is the very first, smallest action you can take?]`,

  (original: string) =>
    `${original}\n\n[Hint: Before trying again, re-read the relevant files to confirm your understanding of the current state. ` +
    `Your mental model may be out of date.]`,

  (original: string) =>
    `${original}\n\n[Hint: Consider whether there is a simpler solution. ` +
    `Sometimes the direct approach (e.g., rewriting a function entirely) is easier than a surgical fix.]`,

  (original: string) =>
    `${original}\n\n[Hint: List what you know for certain, what you're unsure about, and what you need to find out. ` +
    `Then gather the missing information before proceeding.]`,
];

/**
 * Returns a varied version of the original prompt.
 * Cycles through templates based on `attempt` number (0-indexed).
 */
export function varyPrompt(original: string, attempt: number): string {
  const template = VARIATION_TEMPLATES[attempt % VARIATION_TEMPLATES.length];
  return template(original);
}

/**
 * Generates a re-injection message for when the agent appears stuck.
 * Used by the loop's loop-detection code instead of a generic warning.
 */
export function makeStuckMessage(streak: number, attempt: number): string {
  const hints = [
    "Stop repeating the same calls. Re-read the relevant files and try a different approach.",
    "Your current strategy is not working. Break the problem down differently.",
    "Consider using a different tool or a completely different method to accomplish this.",
    "Check whether the task has already been partially completed and you're unnecessarily repeating work.",
    "Pause and reconsider. What is the simplest possible action that would make progress?",
  ];
  return (
    `[System notice] Identical tool calls detected for ${streak} consecutive turns. ` +
    hints[attempt % hints.length]
  );
}
