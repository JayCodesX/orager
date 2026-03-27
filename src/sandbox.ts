import { resolve, relative } from "node:path";

/**
 * Throws if `resolvedPath` is not at or under `sandboxRoot`.
 * Uses path.relative() to correctly handle platform path separators,
 * symlinks resolved by resolve(), and traversal attempts like `../escape`.
 */
export function assertPathAllowed(resolvedPath: string, sandboxRoot: string): void {
  const root = resolve(sandboxRoot);
  const target = resolve(resolvedPath);
  // Same path is allowed
  if (target === root) return;
  // relative() returns a path starting with '..' if target is outside root
  const rel = relative(root, target);
  if (rel.startsWith("..") || rel.startsWith("/")) {
    throw new Error(
      `Path '${resolvedPath}' is outside the sandbox root '${sandboxRoot}'`
    );
  }
}
