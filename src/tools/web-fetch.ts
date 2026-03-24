import type { ToolExecutor, ToolResult } from "../types.js";

const DEFAULT_MAX_CHARS = 10_000;
const FETCH_TIMEOUT_MS = 15_000;

export const webFetchTool: ToolExecutor = {
  definition: {
    type: "function",
    function: {
      name: "web_fetch",
      description:
        "Fetch the content of a URL. Returns the response body as text. Useful for reading documentation, APIs, or web pages.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The URL to fetch",
          },
          max_chars: {
            type: "number",
            description:
              "Truncate response to this many characters (default 10000)",
          },
        },
        required: ["url"],
      },
    },
  },

  async execute(
    input: Record<string, unknown>,
    _cwd: string
  ): Promise<ToolResult> {
    if (typeof input["url"] !== "string" || !input["url"]) {
      return { toolCallId: "", content: "url must be a non-empty string", isError: true };
    }
    const url = input["url"];
    const rawMaxChars =
      typeof input["max_chars"] === "number" ? (input["max_chars"] as number) : DEFAULT_MAX_CHARS;
    const maxChars = rawMaxChars > 0 ? rawMaxChars : DEFAULT_MAX_CHARS;

    // Validate scheme
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return {
        toolCallId: "",
        content: `Invalid URL: ${url}`,
        isError: true,
      };
    }

    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return {
        toolCallId: "",
        content: `Unsupported URL scheme: ${parsedUrl.protocol}. Only http and https are allowed.`,
        isError: true,
      };
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(
      () => controller.abort(),
      FETCH_TIMEOUT_MS
    );

    let response: Response;
    try {
      response = await fetch(url, { signal: controller.signal });
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

    let body: string;
    try {
      body = await response.text();
    } catch (err) {
      return {
        toolCallId: "",
        content: `Failed to read response body: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/html")) {
      // Strip HTML tags
      body = body.replace(/<[^>]+>/g, " ");
      // Collapse whitespace
      body = body.replace(/\s+/g, " ").trim();
    }

    if (body.length > maxChars) {
      body = body.slice(0, maxChars) + "[truncated]";
    }

    return { toolCallId: "", content: body, isError: false };
  },
};
