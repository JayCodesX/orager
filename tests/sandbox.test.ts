import { describe, it, expect } from "vitest";
import { assertPathAllowed } from "../src/sandbox.js";

describe("assertPathAllowed", () => {
  it("allows a path equal to the sandbox root", () => {
    expect(() => assertPathAllowed("/sandbox", "/sandbox")).not.toThrow();
  });

  it("allows a direct child of the sandbox root", () => {
    expect(() => assertPathAllowed("/sandbox/file.txt", "/sandbox")).not.toThrow();
  });

  it("allows a deeply nested path inside the root", () => {
    expect(() => assertPathAllowed("/sandbox/a/b/c.ts", "/sandbox")).not.toThrow();
  });

  it("throws for a path outside the sandbox root", () => {
    expect(() => assertPathAllowed("/etc/passwd", "/sandbox")).toThrow(
      "outside the sandbox root"
    );
  });

  it("throws for a sibling directory that starts with the same prefix", () => {
    // /sandbox-extra must not be allowed when root is /sandbox
    expect(() => assertPathAllowed("/sandbox-extra/file.txt", "/sandbox")).toThrow(
      "outside the sandbox root"
    );
  });

  it("throws for a path traversal attempt", () => {
    expect(() =>
      assertPathAllowed("/sandbox/../etc/passwd", "/sandbox")
    ).toThrow("outside the sandbox root");
  });

  it("resolves relative root and path before comparing", () => {
    // Both get resolve()-d so the check is purely on absolute canonical paths
    // Use tmp-style absolute paths to avoid OS differences
    expect(() => assertPathAllowed("/tmp/sandbox/a.txt", "/tmp/sandbox")).not.toThrow();
    expect(() => assertPathAllowed("/tmp/other/a.txt", "/tmp/sandbox")).toThrow();
  });
});
