/**
 * Structure-aware content truncation.
 *
 * For plain text: truncates at the last newline before the limit to avoid
 * cutting mid-line.
 *
 * For JSON: attempts to truncate arrays to their first N elements, or
 * truncates string values, so the output remains valid JSON.
 *
 * Falls back to a raw byte slice with a truncation notice if structure
 * detection fails.
 */

const TRUNCATION_NOTICE = (original: number, limit: number) =>
  `\n[truncated: ${original} chars → ${limit} chars limit]`;

/**
 * Attempt to truncate a JSON value to fit within `maxChars` when serialized.
 * Returns the truncated JSON string, or null if it can't be done cleanly.
 */
function truncateJson(value: unknown, maxChars: number): string | null {
  // Already fits
  const full = JSON.stringify(value, null, 2);
  if (full.length <= maxChars) return full;

  // Array: drop elements from the end until it fits
  if (Array.isArray(value)) {
    for (let n = value.length - 1; n >= 1; n--) {
      const sliced = JSON.stringify(
        [...value.slice(0, n), `…(${value.length - n} more items)`],
        null,
        2,
      );
      if (sliced.length <= maxChars) return sliced;
    }
    // Even one element is too large — truncate its string rep
    return JSON.stringify([`…array with ${value.length} items (too large to display)`]);
  }

  // Object: keep all keys but truncate long string values
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    const truncated: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string" && v.length > 200) {
        truncated[k] = v.slice(0, 200) + `…(${v.length - 200} more chars)`;
      } else {
        truncated[k] = v;
      }
    }
    const result = JSON.stringify(truncated, null, 2);
    if (result.length <= maxChars) return result;
  }

  return null;
}

/**
 * Truncate content to at most `maxChars` characters in a structure-aware way.
 *
 * @param content  The string to truncate
 * @param maxChars Maximum allowed characters
 * @returns        Truncated string (possibly with a truncation notice appended)
 */
export function truncateContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;

  const trimmed = content.trimStart();

  // ── JSON truncation ────────────────────────────────────────────────────────
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      // Leave room for the truncation notice
      const notice = TRUNCATION_NOTICE(content.length, maxChars);
      const budget = maxChars - notice.length;
      const result = truncateJson(parsed, budget);
      if (result !== null) return result + notice;
    } catch {
      // Not valid JSON — fall through to text truncation
    }
  }

  // ── Plain-text truncation: break at last newline ───────────────────────────
  const slice = content.slice(0, maxChars);
  const lastNewline = slice.lastIndexOf("\n");
  const cutPoint = lastNewline > maxChars * 0.8 ? lastNewline : maxChars;
  return content.slice(0, cutPoint) + TRUNCATION_NOTICE(content.length, maxChars);
}
