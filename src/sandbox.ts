import { resolve } from "node:path";

/**
 * Throws if `resolvedPath` is not at or under `sandboxRoot`.
 * Both paths are resolved before comparison.
 */
export function assertPathAllowed(resolvedPath: string, sandboxRoot: string): void {
  const root = resolve(sandboxRoot);
  const target = resolve(resolvedPath);
  if (target !== root && !target.startsWith(root + "/")) {
    throw new Error(
      `Path '${resolvedPath}' is outside the sandbox root '${sandboxRoot}'`
    );
  }
}
