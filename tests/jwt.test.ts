import { describe, it, expect, vi } from "vitest";
import { mintJwt, verifyJwt } from "../src/jwt.js";
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
    // Flip one char in the signature
    const badSig = parts[2]!.slice(0, -1) + (parts[2]!.slice(-1) === "a" ? "b" : "a");
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
