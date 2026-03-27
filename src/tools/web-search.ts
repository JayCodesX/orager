import type { ToolExecutor, ToolResult } from "../types.js";

const SEARCH_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESULTS = 5;

interface SearchResult {
  title: string;
  url: string;
  description: string;
}

// ── Brave Search ──────────────────────────────────────────────────────────────

async function braveSearch(
  query: string,
  maxResults: number,
  apiKey: string,
): Promise<SearchResult[]> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.min(maxResults, 20)));
  url.searchParams.set("text_decorations", "false");

  const res = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": apiKey,
    },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });

  if (!res.ok) throw new Error(`Brave Search API: HTTP ${res.status} ${res.statusText}`);

  const json = await res.json() as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
  };

  return (json.web?.results ?? []).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    description: r.description ?? "",
  }));
}

// ── DuckDuckGo Instant Answer fallback ────────────────────────────────────────

async function duckduckgoSearch(query: string): Promise<SearchResult[]> {
  const url = new URL("https://api.duckduckgo.com/");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("no_redirect", "1");
  url.searchParams.set("no_html", "1");
  url.searchParams.set("skip_disambig", "1");

  const res = await fetch(url.toString(), {
    headers: { "User-Agent": "orager/1.0" },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });

  if (!res.ok) throw new Error(`DuckDuckGo: HTTP ${res.status} ${res.statusText}`);

  const json = await res.json() as {
    AbstractText?: string;
    AbstractURL?: string;
    AbstractSource?: string;
    RelatedTopics?: Array<{
      Text?: string;
      FirstURL?: string;
      Result?: string;
      Topics?: Array<{ Text?: string; FirstURL?: string }>;
    }>;
    Results?: Array<{ Text?: string; FirstURL?: string }>;
  };

  const results: SearchResult[] = [];

  // Abstract (main answer)
  if (json.AbstractText && json.AbstractURL) {
    results.push({
      title: json.AbstractSource ?? "DuckDuckGo",
      url: json.AbstractURL,
      description: json.AbstractText,
    });
  }

  // Related topics (nested or flat)
  for (const topic of json.RelatedTopics ?? []) {
    if (topic.FirstURL && topic.Text) {
      results.push({ title: topic.Text.slice(0, 80), url: topic.FirstURL, description: topic.Text });
    }
    for (const sub of topic.Topics ?? []) {
      if (sub.FirstURL && sub.Text) {
        results.push({ title: sub.Text.slice(0, 80), url: sub.FirstURL, description: sub.Text });
      }
    }
  }

  // Results section
  for (const r of json.Results ?? []) {
    if (r.FirstURL && r.Text) {
      results.push({ title: r.Text.slice(0, 80), url: r.FirstURL, description: r.Text });
    }
  }

  return results;
}

// ── Tool definition ───────────────────────────────────────────────────────────

export const webSearchTool: ToolExecutor = {
  definition: {
    type: "function",
    readonly: true,
    function: {
      name: "web_search",
      description:
        "Search the web and return a list of relevant results (title, URL, description). " +
        "Use this when you need to find documentation, APIs, packages, or up-to-date information. " +
        "Set BRAVE_SEARCH_API_KEY env var for full results; otherwise uses DuckDuckGo instant answers.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query",
          },
          max_results: {
            type: "number",
            description: `Maximum number of results to return (default ${DEFAULT_MAX_RESULTS}, max 20)`,
          },
        },
        required: ["query"],
      },
    },
  },

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    if (typeof input["query"] !== "string" || !input["query"]) {
      return { toolCallId: "", content: "query must be a non-empty string", isError: true };
    }

    const query = input["query"] as string;
    const maxResults = Math.min(
      Math.max(1, typeof input["max_results"] === "number" ? (input["max_results"] as number) : DEFAULT_MAX_RESULTS),
      20,
    );

    let results: SearchResult[];
    let provider: string;

    const braveKey = process.env["BRAVE_SEARCH_API_KEY"];
    try {
      if (braveKey) {
        results = await braveSearch(query, maxResults, braveKey);
        provider = "Brave Search";
      } else {
        results = await duckduckgoSearch(query);
        provider = "DuckDuckGo";
      }
    } catch (err) {
      return {
        toolCallId: "",
        content: `Search failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }

    if (results.length === 0) {
      return {
        toolCallId: "",
        content: `No results found for: ${query}`,
        isError: false,
      };
    }

    const formatted = results
      .slice(0, maxResults)
      .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.description}`)
      .join("\n\n");

    return {
      toolCallId: "",
      content: `[${provider}] Results for: ${query}\n\n${formatted}`,
      isError: false,
    };
  },
};
