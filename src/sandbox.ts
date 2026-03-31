import { resolve, relative, dirname, basename } from "node:path";
import fs from "node:fs";
import { logSandboxViolation } from "./audit.js";

/**
 * Throws if `resolvedPath` is not at or under `sandboxRoot`.
 *
 * Resolves symlinks via fs.realpathSync so a symlink inside the sandbox that
 * points outside (e.g. sandbox/escape -> /etc) is caught before any I/O.
 * For paths that do not yet exist (e.g. a write target), the parent directory
 * is resolved instead — this still catches directory-level symlink escapes
 * while allowing new-file creation inside the sandbox.
 *
 * M-10: This check-then-use pattern has an inherent TOCTOU window — a symlink
 * could be swapped between the check and the actual I/O. The OS-level sandbox
 * (sandbox-exec / bwrap) is the authoritative control; this check provides
 * defense-in-depth. For additional safety, the check also detects symlinks
 * at the target path itself and rejects them when they point outside.
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

  // M-10: If the target exists and is a symlink, verify the link target is
  // within the sandbox. This narrows the TOCTOU window by catching symlinks
  // that are currently pointing outside, even though the symlink itself is
  // inside the sandbox.
  try {
    const lstat = fs.lstatSync(lexicalTarget);
    if (lstat.isSymbolicLink()) {
      // realTarget already followed the symlink — verify it's within bounds
      const relLink = relative(realRoot, realTarget);
      if (relLink.startsWith("..") || relLink.startsWith("/")) {
        logSandboxViolation({ path: realTarget, sandboxRoot: realRoot, ts: Date.now() });
        throw new Error(
          `Path '${resolvedPath}' is a symlink pointing outside the sandbox root '${sandboxRoot}'`
        );
      }
    }
  } catch (e) {
    // Re-throw sandbox violations; ignore ENOENT (target doesn't exist yet)
    if (e instanceof Error && e.message.includes("outside the sandbox")) throw e;
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
