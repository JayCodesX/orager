import { describe, it, expect, vi, afterEach } from "vitest";
import { webFetchTool, isBlockedHost } from "../src/tools/web-fetch.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockFetch(body: string, status = 200, contentType = "text/plain"): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(body, {
        status,
        headers: { "Content-Type": contentType },
      })
    )
  );
}

// ── Input validation ──────────────────────────────────────────────────────────

describe("web_fetch — input validation", () => {
  it("returns error for missing url", async () => {
    const result = await webFetchTool.execute({}, "/tmp");
    expect(result.isError).toBe(true);
    expect(result.content).toContain("url");
  });

  it("returns error for empty url string", async () => {
    const result = await webFetchTool.execute({ url: "" }, "/tmp");
    expect(result.isError).toBe(true);
  });

  it("returns error for invalid URL", async () => {
    const result = await webFetchTool.execute({ url: "not a url" }, "/tmp");
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid URL");
  });

  it("returns error for file:// scheme", async () => {
    const result = await webFetchTool.execute({ url: "file:///etc/passwd" }, "/tmp");
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unsupported URL scheme");
  });

  it("returns error for ftp:// scheme", async () => {
    const result = await webFetchTool.execute({ url: "ftp://example.com/file" }, "/tmp");
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unsupported URL scheme");
  });
});

// ── HTTP error responses ──────────────────────────────────────────────────────

describe("web_fetch — HTTP errors", () => {
  it("returns error for 404 response", async () => {
    mockFetch("Not found", 404);
    const result = await webFetchTool.execute({ url: "https://example.com/missing" }, "/tmp");
    expect(result.isError).toBe(true);
    expect(result.content).toContain("404");
  });

  it("returns error for 500 response", async () => {
    mockFetch("Internal Server Error", 500);
    const result = await webFetchTool.execute({ url: "https://example.com/error" }, "/tmp");
    expect(result.isError).toBe(true);
    expect(result.content).toContain("500");
  });
});

// ── Successful responses ──────────────────────────────────────────────────────

describe("web_fetch — successful responses", () => {
  it("returns plain text body on success", async () => {
    mockFetch("Hello from the server");
    const result = await webFetchTool.execute({ url: "https://example.com/" }, "/tmp");
    expect(result.isError).toBe(false);
    expect(result.content).toBe("Hello from the server");
  });

  it("strips HTML tags from text/html responses", async () => {
    mockFetch("<h1>Hello</h1><p>World</p>", 200, "text/html");
    const result = await webFetchTool.execute({ url: "https://example.com/" }, "/tmp");
    expect(result.isError).toBe(false);
    expect(result.content).not.toContain("<h1>");
    expect(result.content).not.toContain("<p>");
    expect(result.content).toContain("Hello");
    expect(result.content).toContain("World");
  });

  it("collapses whitespace in HTML responses", async () => {
    mockFetch("<p>   lots   of   spaces   </p>", 200, "text/html");
    const result = await webFetchTool.execute({ url: "https://example.com/" }, "/tmp");
    expect(result.isError).toBe(false);
    // Whitespace should be collapsed, not contain multiple consecutive spaces
    expect(result.content).not.toMatch(/\s{2,}/);
  });

  it("does not strip tags from non-HTML responses", async () => {
    mockFetch("<not>actually html</not>", 200, "application/json");
    const result = await webFetchTool.execute({ url: "https://example.com/data.json" }, "/tmp");
    expect(result.isError).toBe(false);
    expect(result.content).toContain("<not>");
  });
});

// ── Truncation ────────────────────────────────────────────────────────────────

describe("web_fetch — truncation", () => {
  it("truncates body when it exceeds max_chars", async () => {
    const longBody = "x".repeat(200);
    mockFetch(longBody);
    const result = await webFetchTool.execute(
      { url: "https://example.com/", max_chars: 50 },
      "/tmp"
    );
    expect(result.isError).toBe(false);
    // Content should start with 50 truncated chars then a truncation note
    expect(result.content.startsWith("x".repeat(50))).toBe(true);
    expect(result.content).toContain("[truncated");
  });

  it("applies default truncation limit when max_chars is 0", async () => {
    // max_chars=0 is invalid and should fall back to default (10_000)
    const body = "short body";
    mockFetch(body);
    const result = await webFetchTool.execute(
      { url: "https://example.com/", max_chars: 0 },
      "/tmp"
    );
    expect(result.isError).toBe(false);
    expect(result.content).toBe("short body");
  });

  it("applies default truncation limit when max_chars is negative", async () => {
    const body = "short body";
    mockFetch(body);
    const result = await webFetchTool.execute(
      { url: "https://example.com/", max_chars: -100 },
      "/tmp"
    );
    expect(result.isError).toBe(false);
    expect(result.content).toBe("short body");
  });

  it("does not truncate body when it is within max_chars", async () => {
    const body = "short";
    mockFetch(body);
    const result = await webFetchTool.execute(
      { url: "https://example.com/", max_chars: 1000 },
      "/tmp"
    );
    expect(result.isError).toBe(false);
    expect(result.content).toBe("short");
    expect(result.content).not.toContain("[truncated]");
  });
});

// ── SSRF protection (H-01 / H-02) ────────────────────────────────────────────

describe("web_fetch — SSRF protection", () => {
  it("H-01: tool schema does not expose allow_private_urls parameter", () => {
    const params = webFetchTool.definition.function.parameters as {
      properties: Record<string, unknown>;
    };
    expect(params.properties).not.toHaveProperty("allow_private_urls");
    expect(params.properties).not.toHaveProperty("allowPrivateUrls");
  });

  it("H-01: LLM-supplied allow_private_urls in input is ignored", async () => {
    // Even if the LLM injects allow_private_urls, SSRF should still block 127.x
    const result = await webFetchTool.execute(
      { url: "http://127.0.0.1:8080/admin", allow_private_urls: true },
      "/tmp"
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("SSRF blocked");
  });

  it("H-01: server-side context allowPrivateUrls=true bypasses SSRF", async () => {
    mockFetch("private ok");
    const result = await webFetchTool.execute(
      { url: "http://127.0.0.1:8080/" },
      "/tmp",
      undefined,
      { allowPrivateUrls: true }
    );
    // Should succeed when context says it's allowed
    expect(result.isError).toBe(false);
    expect(result.content).toContain("private ok");
  });

  it("H-02: blocks IPv4-mapped IPv6 address (::ffff:127.0.0.1)", async () => {
    const result = await webFetchTool.execute(
      { url: "http://[::ffff:127.0.0.1]:8080/" },
      "/tmp"
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("SSRF blocked");
  });

  it("H-02: blocks IPv4-compatible IPv6 address (::10.0.0.1)", async () => {
    const result = await webFetchTool.execute(
      { url: "http://[::10.0.0.1]:8080/" },
      "/tmp"
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("SSRF blocked");
  });

  it("H-02: blocks ::ffff:169.254.169.254 (AWS IMDS via IPv6)", async () => {
    const result = await webFetchTool.execute(
      { url: "http://[::ffff:169.254.169.254]/" },
      "/tmp"
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("SSRF blocked");
  });

  it("blocks plain IPv4 private addresses (127.0.0.1)", async () => {
    const result = await webFetchTool.execute(
      { url: "http://127.0.0.1/" },
      "/tmp"
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("SSRF blocked");
  });

  it("blocks plain IPv4 private addresses (10.0.0.1)", async () => {
    const result = await webFetchTool.execute(
      { url: "http://10.0.0.1/" },
      "/tmp"
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("SSRF blocked");
  });

  it("blocks plain IPv4 private addresses (192.168.1.1)", async () => {
    const result = await webFetchTool.execute(
      { url: "http://192.168.1.1/" },
      "/tmp"
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("SSRF blocked");
  });

  it("blocks IPv6 loopback (::1)", async () => {
    const result = await webFetchTool.execute(
      { url: "http://[::1]/" },
      "/tmp"
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("SSRF blocked");
  });
});

// ── isBlockedHost unit tests (H-02) ──────────────────────────────────────────

describe("isBlockedHost — IPv4-mapped IPv6 handling", () => {
  it("blocks ::ffff:127.0.0.1", async () => {
    expect(await isBlockedHost("::ffff:127.0.0.1")).toBe(true);
  });

  it("blocks ::ffff:10.0.0.1", async () => {
    expect(await isBlockedHost("::ffff:10.0.0.1")).toBe(true);
  });

  it("blocks ::ffff:192.168.1.1", async () => {
    expect(await isBlockedHost("::ffff:192.168.1.1")).toBe(true);
  });

  it("blocks ::ffff:169.254.169.254 (AWS IMDS)", async () => {
    expect(await isBlockedHost("::ffff:169.254.169.254")).toBe(true);
  });

  it("blocks ::10.0.0.1 (IPv4-compatible)", async () => {
    expect(await isBlockedHost("::10.0.0.1")).toBe(true);
  });

  it("does not block public IPv4", async () => {
    expect(await isBlockedHost("8.8.8.8")).toBe(false);
  });

  it("blocks IPv6 loopback ::1", async () => {
    expect(await isBlockedHost("::1")).toBe(true);
  });
});

// ── Network errors ────────────────────────────────────────────────────────────

describe("web_fetch — network errors", () => {
  it("returns error when fetch throws (network failure)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const result = await webFetchTool.execute({ url: "https://example.com/" }, "/tmp");
    expect(result.isError).toBe(true);
    expect(result.content).toContain("ECONNREFUSED");
  });

  it("returns 'timed out' when fetch aborts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        return Promise.reject(err);
      })
    );
    const result = await webFetchTool.execute({ url: "https://example.com/" }, "/tmp");
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/timed out/i);
  });
});
