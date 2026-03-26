/**
 * Minimal HS256 JWT implementation using Node.js built-in crypto.
 * No external dependencies — keeps orager's footprint small.
 *
 * Tokens are short-lived (5 min) and carry agentId + scope so the daemon can
 * log per-request metadata without needing a persistent session store.
 */

import crypto from "node:crypto";

// ── Base64url helpers ─────────────────────────────────────────────────────────

function base64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function parseBase64url(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

// ── Token expiry ──────────────────────────────────────────────────────────────

const TOKEN_TTL_SECONDS = 300; // 5 minutes — matches Anthropic cache TTL

// ── Public API ────────────────────────────────────────────────────────────────

export interface JwtClaims {
  agentId: string;
  scope: "run";
  iat: number;
  exp: number;
}

/**
 * Mint a signed HS256 JWT for the given agentId.
 * @param signingKey  Raw key string (hex or arbitrary; kept in ~/.orager/daemon.key)
 * @param agentId     Identifier for this agent/caller (used in daemon audit logs)
 */
export function mintJwt(signingKey: string, agentId: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      agentId,
      scope: "run",
      iat: now,
      exp: now + TOKEN_TTL_SECONDS,
    } satisfies JwtClaims),
  );
  const data = `${header}.${payload}`;
  const sig = crypto.createHmac("sha256", signingKey).update(data).digest("base64url");
  return `${data}.${sig}`;
}

/**
 * Verify a JWT and return its claims.
 * Throws an error (never returns null) on any failure — caller should map to 401.
 */
export function verifyJwt(token: string, signingKey: string): JwtClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed JWT");

  const [header, payload, sig] = parts as [string, string, string];
  const data = `${header}.${payload}`;
  const expected = crypto
    .createHmac("sha256", signingKey)
    .update(data)
    .digest("base64url");

  // Constant-time comparison to prevent timing attacks
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    throw new Error("Invalid JWT signature");
  }

  let claims: JwtClaims;
  try {
    claims = JSON.parse(parseBase64url(payload)) as JwtClaims;
  } catch {
    throw new Error("JWT payload is not valid JSON");
  }

  if (claims.exp < Math.floor(Date.now() / 1000)) {
    throw new Error("JWT has expired");
  }
  if (claims.scope !== "run") {
    throw new Error("JWT scope must be 'run'");
  }

  return claims;
}

// ── Signing key management ────────────────────────────────────────────────────

import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

const KEY_PATH = path.join(os.homedir(), ".orager", "daemon.key");

/**
 * Load the daemon signing key from ~/.orager/daemon.key.
 * On first call (file absent) generates a new 32-byte key and writes it
 * with chmod 600. Subsequent calls return the cached key.
 */
export async function loadOrCreateSigningKey(): Promise<string> {
  try {
    const key = await fs.readFile(KEY_PATH, "utf8");
    return key.trim();
  } catch {
    // Key file missing — generate and store
    const key = crypto.randomBytes(32).toString("hex");
    await fs.mkdir(path.dirname(KEY_PATH), { recursive: true });
    await fs.writeFile(KEY_PATH, key, { encoding: "utf8", mode: 0o600 });
    return key;
  }
}

export { KEY_PATH };
