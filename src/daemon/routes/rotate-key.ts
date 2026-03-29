/**
 * POST /rotate-key — generate a new JWT signing key atomically.
 *
 * Authenticated with the *current* key (not dual-key, since you must hold
 * the current key to rotate it). After rotation the old key remains valid
 * for previousKeyTtlMs so in-flight JWTs don't immediately break.
 */
import http from "node:http";
import fs from "node:fs/promises";
import { verifyJwt, KEY_PATH } from "../../jwt.js";
import type { DaemonContext } from "../context.js";

export function handleRotateKey(
  ctx: DaemonContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const authHeader = req.headers["authorization"] ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) { res.writeHead(401); res.end(); return; }
  try { verifyJwt(token, ctx.signingKey); } catch { res.writeHead(401); res.end(); return; }

  void (async () => {
    try {
      const { randomBytes } = await import("node:crypto");
      const newKey = randomBytes(32).toString("base64url");
      const newKeyPath = KEY_PATH + ".new";

      // Atomic write: write to .new then rename
      await fs.writeFile(newKeyPath, newKey, { encoding: "utf8", mode: 0o600 });
      await fs.rename(newKeyPath, KEY_PATH);

      // Keep old key for overlap window so in-flight JWTs remain valid
      ctx.previousKey = ctx.signingKey;
      const expiresAt = new Date(Date.now() + ctx.previousKeyTtlMs);
      ctx.previousKeyExpiresAt = expiresAt;
      ctx.signingKey = newKey;

      // Schedule previous key expiry
      setTimeout(() => {
        if (ctx.previousKeyExpiresAt && Date.now() >= ctx.previousKeyExpiresAt.getTime()) {
          ctx.previousKey = null;
          ctx.previousKeyExpiresAt = null;
        }
      }, ctx.previousKeyTtlMs).unref();

      process.stderr.write(
        `[orager daemon] signing key rotated; old key expires at ${expiresAt.toISOString()}\n`,
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ rotated: true, previousKeyExpiresAt: expiresAt.toISOString() }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[orager daemon] key rotation failed: ${msg}\n`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: msg }));
    }
  })();
}
