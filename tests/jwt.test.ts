import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs/promises";
import { mintJwt, verifyJwt, loadOrCreateSigningKey, KEY_PATH } from "../src/jwt.js";
import crypto from "node:crypto";

const SIGNING_KEY = "test-signing-key-32-bytes-long!!";
const AGENT_ID = "test-agent";

describe("mintJwt", () => {
  it("produces a 3-part JWT string", () => {
    const token = mintJwt(SIGNING_KEY, AGENT_ID);
    const parts = token.split(".");
    expect(parts).toHaveLength(3);
    // Each part should be non-empty base64url
    for (const part of parts) {
      expect(part.length).toBeGreaterThan(0);
    }
  });
});

describe("verifyJwt", () => {
  it("accepts a freshly minted token", () => {
    const token = mintJwt(SIGNING_KEY, AGENT_ID);
    expect(() => verifyJwt(token, SIGNING_KEY)).not.toThrow();
  });

  it("returns correct claims on round-trip", () => {
    const token = mintJwt(SIGNING_KEY, AGENT_ID);
    const claims = verifyJwt(token, SIGNING_KEY);
    expect(claims.agentId).toBe(AGENT_ID);
    expect(claims.scope).toBe("run");
    expect(typeof claims.iat).toBe("number");
    expect(typeof claims.exp).toBe("number");
    expect(claims.exp).toBeGreaterThan(claims.iat);
  });

  it("round-trips different agentId values correctly", () => {
    for (const id of ["agent-1", "my-cool-agent", "uuid-1234-abcd"]) {
      const token = mintJwt(SIGNING_KEY, id);
      const claims = verifyJwt(token, SIGNING_KEY);
      expect(claims.agentId).toBe(id);
      expect(claims.scope).toBe("run");
    }
  });

  it("throws on tampered signature", () => {
    const token = mintJwt(SIGNING_KEY, AGENT_ID);
    const parts = token.split(".");
    // Flip one char in the middle of the signature (avoid last char which may
    // encode padding bits that Node.js masks during base64url decoding).
    const sig = parts[2]!;
    const midIdx = Math.floor(sig.length / 2);
    const flipped = sig[midIdx] === "a" ? "b" : "a";
    const badSig = sig.slice(0, midIdx) + flipped + sig.slice(midIdx + 1);
    const tampered = `${parts[0]}.${parts[1]}.${badSig}`;
    expect(() => verifyJwt(tampered, SIGNING_KEY)).toThrow();
  });

  it("throws on expired token", () => {
    // Manually craft a token with exp in the past
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const pastTime = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
    const payload = Buffer.from(
      JSON.stringify({ agentId: AGENT_ID, scope: "run", iat: pastTime - 300, exp: pastTime }),
    ).toString("base64url");
    const data = `${header}.${payload}`;
    const sig = crypto.createHmac("sha256", SIGNING_KEY).update(data).digest("base64url");
    const expiredToken = `${data}.${sig}`;
    expect(() => verifyJwt(expiredToken, SIGNING_KEY)).toThrow(/expired/i);
  });

  it("throws on malformed token (not 3 parts)", () => {
    expect(() => verifyJwt("only.two", SIGNING_KEY)).toThrow(/malformed/i);
    expect(() => verifyJwt("one", SIGNING_KEY)).toThrow(/malformed/i);
    expect(() => verifyJwt("a.b.c.d", SIGNING_KEY)).toThrow(/malformed/i);
  });

  it("throws on wrong scope", () => {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(
      JSON.stringify({ agentId: AGENT_ID, scope: "admin", iat: now, exp: now + 300 }),
    ).toString("base64url");
    const data = `${header}.${payload}`;
    const sig = crypto.createHmac("sha256", SIGNING_KEY).update(data).digest("base64url");
    const token = `${data}.${sig}`;
    expect(() => verifyJwt(token, SIGNING_KEY)).toThrow(/scope/i);
  });

  it("throws on non-JSON payload", () => {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from("not-json-at-all").toString("base64url");
    const data = `${header}.${payload}`;
    const sig = crypto.createHmac("sha256", SIGNING_KEY).update(data).digest("base64url");
    const token = `${data}.${sig}`;
    expect(() => verifyJwt(token, SIGNING_KEY)).toThrow(/JSON/i);
  });

  it("throws on wrong signing key", () => {
    const token = mintJwt(SIGNING_KEY, AGENT_ID);
    expect(() => verifyJwt(token, "a-completely-different-key")).toThrow();
  });
});

// ── loadOrCreateSigningKey ────────────────────────────────────────────────────
// Tests use fs spies to avoid touching the real ~/.orager/daemon.key file.

describe("loadOrCreateSigningKey", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns the trimmed key from disk when the key file exists", async () => {
    const realReadFile = fs.readFile.bind(fs);
    vi.spyOn(fs, "readFile").mockImplementation((...args: Parameters<typeof fs.readFile>) => {
      if (String(args[0]) === KEY_PATH) {
        return Promise.resolve("deadbeef1234  \n") as ReturnType<typeof fs.readFile>;
      }
      return (realReadFile as typeof fs.readFile)(...args);
    });

    const key = await loadOrCreateSigningKey();
    expect(key).toBe("deadbeef1234"); // trailing whitespace stripped
  });

  it("generates a 64-char hex key and writes it to disk when key file is absent", async () => {
    let writtenKey = "";
    const realReadFile = fs.readFile.bind(fs);

    vi.spyOn(fs, "readFile").mockImplementation((...args: Parameters<typeof fs.readFile>) => {
      if (String(args[0]) === KEY_PATH) {
        return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" })) as ReturnType<typeof fs.readFile>;
      }
      return (realReadFile as typeof fs.readFile)(...args);
    });
    vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
    // Mock fs.open to return a fake file handle that captures the written key
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]) === KEY_PATH) {
        return {
          writeFile(data: string) { writtenKey = data; return Promise.resolve(); },
          close() { return Promise.resolve(); },
        } as unknown as Awaited<ReturnType<typeof fs.open>>;
      }
      return fs.open(...args);
    });

    const key = await loadOrCreateSigningKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/); // 32 bytes → 64 hex chars
    expect(writtenKey).toBe(key);           // written value matches returned value
  });

  it("generates a different key on each call when key file is absent (rotation produces unique keys)", async () => {
    const realReadFile = fs.readFile.bind(fs);
    vi.spyOn(fs, "readFile").mockImplementation((...args: Parameters<typeof fs.readFile>) => {
      if (String(args[0]) === KEY_PATH) {
        return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" })) as ReturnType<typeof fs.readFile>;
      }
      return (realReadFile as typeof fs.readFile)(...args);
    });
    vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]) === KEY_PATH) {
        return {
          writeFile() { return Promise.resolve(); },
          close() { return Promise.resolve(); },
        } as unknown as Awaited<ReturnType<typeof fs.open>>;
      }
      return fs.open(...args);
    });

    const key1 = await loadOrCreateSigningKey();
    const key2 = await loadOrCreateSigningKey();

    expect(key1).not.toBe(key2); // each rotation yields a fresh random key
    expect(key1).toMatch(/^[0-9a-f]{64}$/);
    expect(key2).toMatch(/^[0-9a-f]{64}$/);
  });

  it("tokens signed with the old key are rejected after key rotation", () => {
    // Simulate rotation: old and new are independently random keys
    const oldKey = crypto.randomBytes(32).toString("hex");
    const newKey = crypto.randomBytes(32).toString("hex");

    const token = mintJwt(oldKey, "agent-pre-rotation");

    // Valid with old key
    expect(() => verifyJwt(token, oldKey)).not.toThrow();
    // Rejected with new key — rotation invalidates all pre-rotation tokens
    expect(() => verifyJwt(token, newKey)).toThrow(/invalid jwt signature/i);
  });
});

// ── S5: iat future-date check ─────────────────────────────────────────────────

describe("verifyJwt — iat future-date guard", () => {
  it("rejects a token whose iat is more than 30s in the future", () => {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const futureIat = now + 60; // 60s in the future — exceeds 30s tolerance
    const payload = Buffer.from(
      JSON.stringify({ agentId: "test-agent", scope: "run", iat: futureIat, exp: futureIat + 900 }),
    ).toString("base64url");
    const data = `${header}.${payload}`;
    const sig = crypto.createHmac("sha256", SIGNING_KEY).update(data).digest("base64url");
    const token = `${data}.${sig}`;

    expect(() => verifyJwt(token, SIGNING_KEY)).toThrow(/future|clock|forgery/i);
  });

  it("accepts a token whose iat is within 30s clock-skew tolerance (25s ahead)", () => {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const slightlyFutureIat = now + 25; // 25s — within the 30s tolerance
    const payload = Buffer.from(
      JSON.stringify({ agentId: "test-agent", scope: "run", iat: slightlyFutureIat, exp: slightlyFutureIat + 900 }),
    ).toString("base64url");
    const data = `${header}.${payload}`;
    const sig = crypto.createHmac("sha256", SIGNING_KEY).update(data).digest("base64url");
    const token = `${data}.${sig}`;

    // Should NOT throw — within tolerance
    expect(() => verifyJwt(token, SIGNING_KEY)).not.toThrow();
  });

  it("accepts a freshly minted token (iat = now) without triggering the future-date check", () => {
    const token = mintJwt(SIGNING_KEY, "test-agent");
    expect(() => verifyJwt(token, SIGNING_KEY)).not.toThrow();
  });

  it("accepts a token whose iat is in the past (normal operation)", () => {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const pastIat = now - 300; // 5 minutes ago
    const payload = Buffer.from(
      JSON.stringify({ agentId: "test-agent", scope: "run", iat: pastIat, exp: now + 600 }),
    ).toString("base64url");
    const data = `${header}.${payload}`;
    const sig = crypto.createHmac("sha256", SIGNING_KEY).update(data).digest("base64url");
    const token = `${data}.${sig}`;

    expect(() => verifyJwt(token, SIGNING_KEY)).not.toThrow();
  });
});
