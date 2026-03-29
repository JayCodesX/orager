/**
 * Tests for verifyJwtDualKey in src/daemon/context.ts.
 *
 * The dual-key verification supports key rotation by accepting tokens signed
 * with either the current signing key OR the previous key — as long as the
 * previous-key TTL window has not expired.
 *
 * Scenarios:
 *   1. Token signed with current key → accepted
 *   2. Token signed with previousKey, within TTL window → accepted
 *   3. Token signed with previousKey, TTL window already expired → rejected
 *   4. Token signed with previousKey, previousKeyExpiresAt = null → rejected
 *   5. Token signed with an unknown third key → rejected regardless of previousKey
 *   6. Token signed with previousKey when ctx.previousKey is null → rejected
 */

import { describe, it, expect } from "vitest";
import { mintJwt } from "../src/jwt.js";
import { verifyJwtDualKey } from "../src/daemon/context.js";
import type { DaemonContext } from "../src/daemon/context.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const CURRENT_KEY  = "current-key-32-bytes-long-here!!";
const PREVIOUS_KEY = "previous-key-32-bytes-long-here!";
const UNKNOWN_KEY  = "unknown-key-32-bytes-long-here!!";

function makeCtx(overrides: Partial<Pick<DaemonContext, "previousKey" | "previousKeyExpiresAt">> = {}): DaemonContext {
  return {
    port: 0,
    maxConcurrent: 3,
    perAgentMaxConcurrent: 2,
    apiKey: "test-api-key",
    model: "test-model",
    idleTimeoutMs: 60_000,
    requestTimeoutMs: 30_000,
    allowedCwdPrefixes: undefined,
    previousKeyTtlMs: 20 * 60 * 1000,
    signingKey: CURRENT_KEY,
    previousKey: null,
    previousKeyExpiresAt: null,
    activeRuns: 0,
    activeRunsByAgent: new Map(),
    activeRunControllers: new Map(),
    draining: false,
    completedRuns: 0,
    errorRuns: 0,
    daemonStartedAt: Date.now(),
    lastActivityAt: Date.now(),
    lastRealRequestAt: Date.now(),
    keepAliveTimer: null,
    usedModels: new Set(["test-model"]),
    modelLastUsedAt: new Map(),
    ...overrides,
  } as unknown as DaemonContext;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("verifyJwtDualKey — current key", () => {
  it("accepts a token signed with the current signing key", () => {
    const ctx = makeCtx();
    const token = mintJwt(CURRENT_KEY, "agent-x");
    expect(() => verifyJwtDualKey(ctx, token)).not.toThrow();
    const claims = verifyJwtDualKey(ctx, token);
    expect(claims.agentId).toBe("agent-x");
  });

  it("rejects a token signed with an unknown key when no previousKey is set", () => {
    const ctx = makeCtx();
    const token = mintJwt(UNKNOWN_KEY, "agent-x");
    expect(() => verifyJwtDualKey(ctx, token)).toThrow();
  });
});

describe("verifyJwtDualKey — previousKey within TTL window", () => {
  it("accepts a token signed with previousKey when TTL has not expired", () => {
    const ctx = makeCtx({
      previousKey: PREVIOUS_KEY,
      previousKeyExpiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes from now
    });
    const token = mintJwt(PREVIOUS_KEY, "agent-rotating");
    expect(() => verifyJwtDualKey(ctx, token)).not.toThrow();
    const claims = verifyJwtDualKey(ctx, token);
    expect(claims.agentId).toBe("agent-rotating");
  });

  it("accepts current-key token even when a valid previousKey is also present", () => {
    const ctx = makeCtx({
      previousKey: PREVIOUS_KEY,
      previousKeyExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    const token = mintJwt(CURRENT_KEY, "agent-y");
    expect(() => verifyJwtDualKey(ctx, token)).not.toThrow();
  });
});

describe("verifyJwtDualKey — previousKey outside or missing TTL window", () => {
  it("rejects a token signed with previousKey when TTL window has already expired", () => {
    const ctx = makeCtx({
      previousKey: PREVIOUS_KEY,
      previousKeyExpiresAt: new Date(Date.now() - 1), // 1 ms ago → expired
    });
    const token = mintJwt(PREVIOUS_KEY, "agent-z");
    expect(() => verifyJwtDualKey(ctx, token)).toThrow();
  });

  it("rejects a token signed with previousKey when previousKeyExpiresAt is null", () => {
    const ctx = makeCtx({
      previousKey: PREVIOUS_KEY,
      previousKeyExpiresAt: null,
    });
    const token = mintJwt(PREVIOUS_KEY, "agent-no-expiry");
    // previousKeyExpiresAt null → the overlap check fails → falls through to throw
    expect(() => verifyJwtDualKey(ctx, token)).toThrow();
  });

  it("rejects a token signed with previousKey when ctx.previousKey is null", () => {
    const ctx = makeCtx({
      previousKey: null,
      previousKeyExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    const token = mintJwt(PREVIOUS_KEY, "agent-no-prev");
    expect(() => verifyJwtDualKey(ctx, token)).toThrow();
  });

  it("rejects a token signed with a completely unknown third key regardless of previousKey", () => {
    const ctx = makeCtx({
      previousKey: PREVIOUS_KEY,
      previousKeyExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    const token = mintJwt(UNKNOWN_KEY, "agent-rogue");
    // Neither CURRENT_KEY nor PREVIOUS_KEY matches UNKNOWN_KEY
    expect(() => verifyJwtDualKey(ctx, token)).toThrow();
  });
});
