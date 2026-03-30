import { resolve, relative, dirname, basename } from "node:path";
import fs from "node:fs";
import { logSandboxViolation } from "./audit.js";

/**
 * Throws if `resolvedPath` is not at or under `sandboxRoot`.
 *
 * Resolves symlinks via fs.realpathSync so a symlink inside the sandbox that
 * points outside (e.g. sandbox/escape -> /etc) is caught before any I/O.
 * For paths that do not yet exist (e.g. a write target), the parent directory
 * is resolved instead — this still catches symlink escapes on the directory
 * component while allowing new-file creation inside the sandbox.
 */
export function assertPathAllowed(resolvedPath: string, sandboxRoot: string): void {
  // Resolve the sandbox root — follow any symlinks in the root path itself
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(resolve(sandboxRoot));
  } catch {
    // Sandbox root doesn't exist — fall back to lexical check
    realRoot = resolve(sandboxRoot);
  }

  // Try to resolve the full target path (works for existing files/dirs)
  let realTarget: string;
  const lexicalTarget = resolve(resolvedPath);
  try {
    realTarget = fs.realpathSync(lexicalTarget);
  } catch {
    // Target doesn't exist yet — resolve the parent directory and reattach the
    // filename so we still catch directory-level symlink escapes
    const parent = dirname(lexicalTarget);
    let realParent: string;
    try {
      realParent = fs.realpathSync(parent);
    } catch {
      realParent = parent;
    }
    realTarget = resolve(realParent, basename(lexicalTarget));
  }

  // Same path is allowed
  if (realTarget === realRoot) return;
  // relative() returns a path starting with '..' if target is outside root
  const rel = relative(realRoot, realTarget);
  if (rel.startsWith("..") || rel.startsWith("/")) {
    logSandboxViolation({ path: realTarget, sandboxRoot: realRoot, ts: Date.now() });
    throw new Error(
      `Path '${resolvedPath}' is outside the sandbox root '${sandboxRoot}'`
    );
  }
}
