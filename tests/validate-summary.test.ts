/**
 * Tests for validateSummary() — Phase 2 summary validation helper.
 */
import { describe, it, expect } from "vitest";
import { validateSummary } from "../src/loop-helpers.js";
import type { Message } from "../src/types.js";

function userMsg(content: string): Message {
  return { role: "user", content };
}
function assistantMsg(content: string): Message {
  return { role: "assistant", content };
}

describe("validateSummary", () => {
  it("rejects a summary that is too short", () => {
    const result = validateSummary("Short.", [userMsg("hello")]);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/too short/);
  });

  it("accepts a summary that meets the minimum length with no key entities", () => {
    // Source with no Title-case words or numbers — coverage check is skipped
    const source = [userMsg("hello world, how are you doing today?")];
    const summary = "a".repeat(150);
    const result = validateSummary(summary, source);
    expect(result.valid).toBe(true);
  });

  it("accepts a summary with sufficient entity coverage", () => {
    const source = [
      userMsg("Set up the Pricing service with port 8080 and version 2."),
      assistantMsg("I will configure Pricing on port 8080 for version 2."),
    ];
    // Summary covers Pricing, 8080, version — all key tokens
    const summary =
      "The agent configured the Pricing service to run on port 8080. " +
      "Version 2 was used. The configuration was saved and the service started successfully.";
    const result = validateSummary(summary, source);
    expect(result.valid).toBe(true);
  });

  it("rejects a summary with poor entity coverage", () => {
    const source = [
      userMsg("Deploy the AuthService to region us-east-1 on node 42 using version 3 of Docker."),
    ];
    // Summary mentions none of the key tokens
    const summary = "a".repeat(120) + " the work was done and things are running correctly now.";
    const result = validateSummary(summary, source);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/entity coverage/);
  });

  it("returns valid when source messages have no extractable entities", () => {
    const source = [userMsg("ok sure"), assistantMsg("got it")];
    const summary = "a".repeat(120);
    expect(validateSummary(summary, source).valid).toBe(true);
  });

  it("coverage check is case-insensitive in summary", () => {
    const source = [userMsg("Connect to PostgreSQL database.")];
    // Summary uses lowercase "postgresql" — should still count as covered
    const summary =
      "The session connected to a postgresql database. " +
      "The connection was successfully established and queries ran smoothly.";
    const result = validateSummary(summary, source);
    expect(result.valid).toBe(true);
  });

  it("handles messages with array content blocks", () => {
    const source: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Check the Redis cache on port 6379." },
        ] as unknown as string,
      },
    ];
    const summary =
      "The user asked to check the Redis cache running on port 6379. " +
      "The cache was found to be healthy and responding correctly.";
    const result = validateSummary(summary, source);
    expect(result.valid).toBe(true);
  });
});
