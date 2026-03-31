import type { ToolExecutor, ToolResult } from "../types.js";
import { promises as dnsPromises } from "node:dns";
import { isIP } from "node:net";

const DEFAULT_MAX_CHARS = 50_000;
const FETCH_TIMEOUT_MS = 20_000;
const USER_AGENT =
  "Mozilla/5.0 (compatible; orager/1.0; +https://paperclip.ai)";

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);

/**
 * Convert HTML to readable plain text.
 * - Strips <script>, <style>, <noscript>, <head> blocks entirely (with content)
 * - Replaces block-level elements with newlines for readable layout
 * - Strips remaining tags
 * - Decodes common HTML entities
 * - Collapses excessive whitespace
 */
function htmlToText(html: string): string {
  return html
    // Remove entire block content for non-visible elements
    .replace(/<(script|style|noscript|head)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    // Replace closing block elements with a newline
    .replace(
      /<\/?(p|div|h[1-6]|li|dt|dd|tr|td|th|blockquote|pre|article|section|aside|header|footer|main|nav|figure|figcaption)\b[^>]*>/gi,
      "\n",
    )
    // Standalone <br> / <hr>
    .replace(/<br\b[^>]*\/?>/gi, "\n")
    .replace(/<hr\b[^>]*\/?>/gi, "\n---\n")
    // Strip remaining tags
    .replace(/<[^>]+>/g, "")
    // Decode HTML entities
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n: string) =>
      String.fromCharCode(parseInt(n, 10)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) =>
      String.fromCharCode(parseInt(h, 16)),
    )
    .replace(/&[a-z]{2,8};/gi, " ") // remaining unknown entities → space
    // Normalise whitespace
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── SSRF protection ───────────────────────────────────────────────────────────

const BLOCKED_IPV4 = [
  /^127\./,                              // loopback
  /^10\./,                               // RFC1918
  /^192\.168\./,                         // RFC1918
  /^172\.(1[6-9]|2\d|3[01])\./,         // RFC1918
  /^169\.254\./,                         // link-local / AWS IMDS
  /^0\./,                                // unspecified
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT RFC6598
  /^224\./, /^240\./,                    // multicast / reserved
];

const BLOCKED_IPV6 = [
  /^::1$/,                               // loopback
  /^(fc|fd)/i,                           // unique-local (ULA)
  /^fe[89ab]/i,                          // link-local
];

/**
 * Convert a 16-bit hex value to a decimal number.
 */
function hex16(s: string): number {
  return parseInt(s, 16);
}

/**
 * Try to extract an embedded IPv4 address from an IPv4-mapped or
 * IPv4-compatible IPv6 address. Handles both dotted-decimal form
 * (::ffff:127.0.0.1) and hex-normalized form (::ffff:7f00:1).
 * Returns the IPv4 string or null if not applicable.
 */
function extractMappedIPv4(ipv6Lower: string): string | null {
  // Dotted-decimal form: ::ffff:127.0.0.1 or ::127.0.0.1
  const dottedMatch = ipv6Lower.match(/^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dottedMatch) return dottedMatch[1];

  // Hex-normalized form: ::ffff:7f00:1 (URL parser normalizes to this)
  // The last two groups encode the IPv4 as two 16-bit hex values.
  const hexMatch = ipv6Lower.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMatch) {
    const hi = hex16(hexMatch[1]);
    const lo = hex16(hexMatch[2]);
    if (hi <= 0xffff && lo <= 0xffff) {
      return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    }
  }

  return null;
}

function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return BLOCKED_IPV4.some(r => r.test(ip));
  if (v === 6) {
    const lower = ip.toLowerCase();
    // H-02: Handle IPv4-mapped IPv6 addresses in both dotted-decimal
    // (::ffff:127.0.0.1) and hex-normalized (::ffff:7f00:1) forms.
    // The URL constructor normalizes to hex form, while dns.resolve6
    // may return dotted-decimal form. Both must be caught.
    const mapped = extractMappedIPv4(lower);
    if (mapped) {
      return BLOCKED_IPV4.some(r => r.test(mapped));
    }
    return BLOCKED_IPV6.some(r => r.test(lower));
  }
  return false;
}

/**
 * Resolve a hostname to its IP addresses and check whether any of them fall
 * in a private/reserved range.
 *
 * Returns true (blocked) when:
 *  - any resolved IP is private/reserved
 *  - any DNS lookup timed out (conservative: prevents DNS-timing SSRF attacks
 *    where an attacker deliberately slows their DNS to bypass this check)
 *
 * Returns false (not blocked) on NXDOMAIN/other DNS errors — letting fetch()
 * surface the network error naturally.
 */
export async function isBlockedHost(hostname: string): Promise<boolean> {
  // URL.hostname wraps IPv6 addresses in brackets (e.g. "[::1]") which
  // isIP() does not recognise. Strip them so the check works correctly.
  const bare = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  if (isIP(bare)) return isPrivateIp(bare);
  try {
    const DNS_TIMEOUT_MS = 5_000;
    function withDnsTimeout<T>(p: Promise<T>): Promise<T> {
      return Promise.race([
        p,
        new Promise<T>((_, reject) =>
          setTimeout(() => reject(new Error("DNS timeout")), DNS_TIMEOUT_MS),
        ),
      ]);
    }
    const [v4, v6] = await Promise.allSettled([
      withDnsTimeout(dnsPromises.resolve4(hostname)),
      withDnsTimeout(dnsPromises.resolve6(hostname)),
    ]);
    const addrs = [
      ...(v4.status === "fulfilled" ? v4.value : []),
      ...(v6.status === "fulfilled" ? v6.value : []),
    ];
    if (addrs.length === 0) {
      // Block conservatively if any lookup timed out — an attacker can delay
      // DNS responses past our timeout window then serve a private IP at fetch
      // time. On NXDOMAIN the fetch itself will also fail, so passing through
      // is safe there.
      const anyTimedOut = [v4, v6].some(
        (r) =>
          r.status === "rejected" &&
          r.reason instanceof Error &&
          r.reason.message === "DNS timeout",
      );
      return anyTimedOut;
    }
    return addrs.some(isPrivateIp);
  } catch {
    return false;
  }
}

/**
 * Fetch a URL while manually following redirects and SSRF-checking each hop.
 * Using redirect: "manual" means we control every redirect step and can
 * validate the Location header before following it.
 */
const MAX_REDIRECTS = 10;

async function safeFetch(
  initialUrl: string,
  method: string,
  body: string | undefined,
  headers: Record<string, string>,
  signal: AbortSignal,
  allowPrivate: boolean,
): Promise<Response> {
  let currentUrl = initialUrl;
  let currentMethod = method;
  let currentBody: string | undefined = body;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(currentUrl, {
      method: currentMethod,
      body: currentBody,
      signal,
      headers,
      redirect: "manual",
    });

    // Non-redirect response — return it directly
    if (res.status < 300 || res.status >= 400) return res;

    const location = res.headers.get("location");
    if (!location) return res; // no Location header, treat as final

    if (hop === MAX_REDIRECTS) {
      throw new Error(`Too many redirects (max ${MAX_REDIRECTS})`);
    }

    // Resolve relative redirect URLs against the current URL
    let nextUrl: string;
    try {
      nextUrl = new URL(location, currentUrl).href;
    } catch {
      throw new Error(`Invalid redirect Location: ${location}`);
    }
    const parsedNext = new URL(nextUrl);

    // SSRF check on every redirect hop — the initial check only covers the
    // original URL; without this a public → private redirect bypasses it.
    if (!allowPrivate) {
      const blocked = await isBlockedHost(parsedNext.hostname);
      if (blocked) {
        throw new Error(
          `SSRF blocked: redirect to '${parsedNext.hostname}' resolves to a private or internal IP address`,
        );
      }
    }

    // 301/302/303: convert to GET per RFC 7231 §6.4
    if (res.status === 301 || res.status === 302 || res.status === 303) {
      currentMethod = "GET";
      currentBody = undefined;
    }
    currentUrl = nextUrl;
  }

  throw new Error(`Too many redirects (max ${MAX_REDIRECTS})`);
}

export const webFetchTool: ToolExecutor = {
  definition: {
    type: "function",
    // Only GET/HEAD requests are considered read-only for caching purposes
    readonly: false,
    function: {
      name: "web_fetch",
      description:
        "Make an HTTP request (GET, POST, PUT, PATCH, DELETE) and return the response as text. " +
        "HTML responses are converted to readable plain text. " +
        "Use for reading docs, calling REST APIs, submitting webhooks, etc.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The URL to request (http or https)",
          },
          method: {
            type: "string",
            description: "HTTP method: GET (default), POST, PUT, PATCH, DELETE, HEAD",
          },
          body: {
            type: "string",
            description:
              "Request body as a string. For JSON APIs pass a JSON string and set Content-Type in headers.",
          },
          headers: {
            type: "object",
            description:
              "Additional request headers as key-value pairs. E.g. {\"Content-Type\": \"application/json\", \"Authorization\": \"Bearer token\"}",
          },
          max_chars: {
            type: "number",
            description: `Truncate response to this many characters (default ${DEFAULT_MAX_CHARS})`,
          },
          raw: {
            type: "boolean",
            description:
              "When true, return the raw response body without HTML-to-text conversion. Useful for JSON APIs or source files.",
          },
          // H-01: allow_private_urls removed from tool schema.
          // It was LLM-controllable, meaning a prompt-injected instruction
          // could disable SSRF protection. Now only controllable via
          // ToolExecuteOptions context (server-side).
          //
          // To allow private URLs, pass allowPrivateUrls: true in the
          // tool execution context (e.g., from daemon config or CLI flag).
        },
        required: ["url"],
      },
    },
  },

  async execute(
    input: Record<string, unknown>,
    _cwd: string,
    _opts?: unknown,
    context?: Record<string, unknown>,
  ): Promise<ToolResult> {
    if (typeof input["url"] !== "string" || !input["url"]) {
      return {
        toolCallId: "",
        content: "url must be a non-empty string",
        isError: true,
      };
    }
    const url = input["url"];
    const rawMaxChars =
      typeof input["max_chars"] === "number"
        ? (input["max_chars"] as number)
        : DEFAULT_MAX_CHARS;
    const maxChars = rawMaxChars > 0 ? rawMaxChars : DEFAULT_MAX_CHARS;
    const returnRaw = input["raw"] === true;

    // Method
    const rawMethod =
      typeof input["method"] === "string"
        ? input["method"].toUpperCase()
        : "GET";
    if (!ALLOWED_METHODS.has(rawMethod)) {
      return {
        toolCallId: "",
        content: `Unsupported HTTP method: ${rawMethod}. Use one of: ${[...ALLOWED_METHODS].join(", ")}`,
        isError: true,
      };
    }
    const method = rawMethod;

    // Body
    const body =
      typeof input["body"] === "string" && input["body"]
        ? input["body"]
        : undefined;

    // Extra headers (caller-supplied)
    const extraHeaders: Record<string, string> = {};
    if (typeof input["headers"] === "object" && input["headers"] !== null) {
      for (const [k, v] of Object.entries(input["headers"] as Record<string, unknown>)) {
        if (typeof v === "string") extraHeaders[k] = v;
      }
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return { toolCallId: "", content: `Invalid URL: ${url}`, isError: true };
    }

    if (
      parsedUrl.protocol !== "http:" &&
      parsedUrl.protocol !== "https:"
    ) {
      return {
        toolCallId: "",
        content: `Unsupported URL scheme: ${parsedUrl.protocol}. Only http and https are allowed.`,
        isError: true,
      };
    }

    // H-01: allow_private_urls is now server-side only (context),
    // not controllable by the LLM via tool input.
    const allowPrivate = context?.["allowPrivateUrls"] === true;

    // Log a warning audit trail when private URL override is used
    if (allowPrivate) {
      process.stderr.write(
        `[orager] WARNING: allowPrivateUrls=true for '${parsedUrl.hostname}' — SSRF protection bypassed\n`
      );
    }

    // SSRF guard — block requests that resolve to private/internal IPs
    if (!allowPrivate) {
      let blocked = false;
      try {
        blocked = await isBlockedHost(parsedUrl.hostname);
      } catch {
        // DNS error is non-fatal here; fetch will surface network errors naturally
      }
      if (blocked) {
        return {
          toolCallId: "",
          content:
            `SSRF blocked: '${parsedUrl.hostname}' resolves to a private or internal IP address.`,
          isError: true,
        };
      }
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(
      () => controller.abort(),
      FETCH_TIMEOUT_MS,
    );

    const fetchHeaders: Record<string, string> = {
      "User-Agent": USER_AGENT,
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
      "Accept-Language": "en-US,en;q=0.9",
      ...extraHeaders,
    };

    let response: Response;
    try {
      response = await safeFetch(
        url,
        method,
        body,
        fetchHeaders,
        controller.signal,
        allowPrivate,
      );
    } catch (err) {
      clearTimeout(timeoutHandle);
      const isTimeout =
        err instanceof Error && err.name === "AbortError";
      return {
        toolCallId: "",
        content: isTimeout
          ? `Request timed out after ${FETCH_TIMEOUT_MS}ms`
          : `Fetch error: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    } finally {
      clearTimeout(timeoutHandle);
    }

    if (!response.ok) {
      return {
        toolCallId: "",
        content: `HTTP ${response.status} ${response.statusText}`,
        isError: true,
      };
    }

    let responseText: string;
    try {
      responseText = await response.text();
    } catch (err) {
      return {
        toolCallId: "",
        content: `Failed to read response body: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!returnRaw && contentType.includes("text/html")) {
      responseText = htmlToText(responseText);
    }

    let truncated = false;
    if (responseText.length > maxChars) {
      responseText = responseText.slice(0, maxChars);
      truncated = true;
    }

    const finalUrl = response.url && response.url !== url ? `\n[redirected to: ${response.url}]` : "";
    const truncNote = truncated
      ? `\n[truncated at ${maxChars} chars — pass a larger max_chars to read more]`
      : "";

    return {
      toolCallId: "",
      content: responseText + finalUrl + truncNote,
      isError: false,
    };
  },
};
