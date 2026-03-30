/**
 * Pure utility functions for audit log formatting.
 * Kept in a separate module so tests can import them directly
 * without being affected by vi.mock("../src/audit.js") stubs.
 */

/**
 * Truncate string values in an object to keep audit entries compact.
 * String values longer than 500 characters are sliced and annotated with
 * a "…(N more chars)" suffix.  Object values are replaced with "[object]".
 */
export function sanitizeInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === "string" && v.length > 500) {
      out[k] = v.slice(0, 500) + `\u2026(${v.length - 500} more chars)`;
    } else if (typeof v === "object" && v !== null) {
      out[k] = "[object]";
    } else {
      out[k] = v;
    }
  }
  return out;
}
