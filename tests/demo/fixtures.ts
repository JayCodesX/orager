/**
 * Demo test fixtures — 14 small projects designed to expose two learnable skills:
 *
 * Skill A: "Early returns" → Agent uses guard-clause spaghetti instead of
 *          structured if/else/else-if control flow.
 *
 * Skill B: "Premature abstraction" → Agent creates AbstractBaseProcessorFactory
 *          for a 20-line script instead of keeping code flat and direct.
 *
 * Each fixture has:
 *   - prompt:        What the user asks the agent to build
 *   - skillExposed:  Which anti-pattern(s) this project is likely to trigger
 *   - day:           Simulated day number (1-14)
 *   - antiPatterns:  Regex patterns that detect the bad habit in generated code
 *   - goodPatterns:  Regex patterns that detect the corrected behavior
 */

export interface DemoFixture {
  day: number;
  name: string;
  prompt: string;
  skillExposed: ("early-return" | "premature-abstraction")[];
  /** Regexes that match the anti-pattern (early returns, over-abstraction) */
  antiPatterns: RegExp[];
  /** Regexes that match the desired behavior */
  goodPatterns: RegExp[];
}

// ── Anti-pattern detection ───────────────────────────────────────────────────

/** Detects guard-clause early-return spaghetti (3+ early returns in one function) */
export const EARLY_RETURN_PATTERNS = [
  /if\s*\([^)]+\)\s*return\b/g,   // bare "if (...) return"
  /if\s*\(![^)]+\)\s*return\b/g,  // negated guard "if (!x) return"
];

/** Detects premature abstraction patterns */
export const PREMATURE_ABSTRACTION_PATTERNS = [
  /\babstract\s+class\b/gi,
  /\bclass\s+\w*(Base|Abstract|Factory|Handler|Manager|Processor)\b/g,
  /\binterface\s+\w*(Strategy|Provider|Adapter)\b/g,
  /\bextends\s+\w*(Base|Abstract)\w*/g,
  /\bimplements\s+\w+/g,
];

/** Detects structured control flow (what we WANT to see) */
export const STRUCTURED_FLOW_PATTERNS = [
  /\belse\s+if\s*\(/g,
  /\belse\s*\{/g,
  /}\s*else\s/g,
];

/** Detects flat/direct code (no unnecessary abstractions) */
export const FLAT_CODE_PATTERNS = [
  /^export\s+function\s+\w+/gm,       // top-level exported functions (not methods)
  /^function\s+\w+/gm,                // plain functions
];

// ── Fixtures ─────────────────────────────────────────────────────────────────

export const DEMO_FIXTURES: DemoFixture[] = [
  // ── Days 1-4: Skill A exposed (early returns) ─────────────────────────────

  {
    day: 1,
    name: "url-shortener",
    prompt: `Write a TypeScript function called shortenUrl that takes a URL string and returns a shortened version. It should handle: null/undefined input, empty string, invalid URL format, URLs that are already short (under 20 chars), and URLs longer than 2048 chars. For valid URLs, return a base62-encoded hash of the first 8 chars.`,
    skillExposed: ["early-return"],
    antiPatterns: EARLY_RETURN_PATTERNS,
    goodPatterns: STRUCTURED_FLOW_PATTERNS,
  },
  {
    day: 2,
    name: "markdown-converter",
    prompt: `Write a TypeScript function called convertMarkdown that takes a markdown string and returns HTML. Handle: null input, empty string, string with only whitespace, string exceeding 100KB, and strings containing script tags (sanitize them). For valid input, convert headers (#, ##, ###), bold (**text**), and links ([text](url)).`,
    skillExposed: ["early-return"],
    antiPatterns: EARLY_RETURN_PATTERNS,
    goodPatterns: STRUCTURED_FLOW_PATTERNS,
  },
  {
    day: 3,
    name: "csv-parser",
    prompt: `Write a TypeScript function called parseCsv that takes a CSV string and returns an array of objects. Handle: null input, empty string, string with only headers (no data rows), malformed rows (wrong column count), rows with unescaped quotes, and files exceeding 10MB. Return typed rows with headers as keys.`,
    skillExposed: ["early-return"],
    antiPatterns: EARLY_RETURN_PATTERNS,
    goodPatterns: STRUCTURED_FLOW_PATTERNS,
  },
  {
    day: 4,
    name: "config-loader",
    prompt: `Write a TypeScript function called loadConfig that takes a file path string and returns a parsed config object. Handle: null/undefined path, empty path, file not found, file not readable (permissions), file too large (>1MB), invalid JSON, valid JSON but missing required fields (name, version). Return the parsed config or a descriptive error.`,
    skillExposed: ["early-return"],
    antiPatterns: EARLY_RETURN_PATTERNS,
    goodPatterns: STRUCTURED_FLOW_PATTERNS,
  },

  // ── Days 5-7: Skill A learned, Skill B exposed (premature abstraction) ───

  {
    day: 5,
    name: "rate-limiter",
    prompt: `Write a TypeScript module that implements a simple in-memory rate limiter. It should track request counts per IP address with a sliding window. Provide a function checkRateLimit(ip: string): boolean that returns true if the request is allowed. Keep it simple — this is a single-file utility, not a library.`,
    skillExposed: ["premature-abstraction"],
    antiPatterns: PREMATURE_ABSTRACTION_PATTERNS,
    goodPatterns: FLAT_CODE_PATTERNS,
  },
  {
    day: 6,
    name: "task-runner",
    prompt: `Write a TypeScript function called runTasks that takes an array of async functions and a concurrency limit number, then runs them with at most N concurrent tasks. Return an array of results in order. This is a one-off utility function, not a framework — keep the implementation under 40 lines.`,
    skillExposed: ["premature-abstraction"],
    antiPatterns: PREMATURE_ABSTRACTION_PATTERNS,
    goodPatterns: FLAT_CODE_PATTERNS,
  },
  {
    day: 7,
    name: "event-logger",
    prompt: `Write a TypeScript module with a function logEvent(level: "info" | "warn" | "error", message: string, meta?: Record<string, unknown>) that writes structured JSON logs to stdout. Include timestamp, level, message, and optional metadata. This is a simple utility for a small CLI tool — keep it flat and direct, no class hierarchies needed.`,
    skillExposed: ["early-return", "premature-abstraction"],
    antiPatterns: [...PREMATURE_ABSTRACTION_PATTERNS, ...EARLY_RETURN_PATTERNS],
    goodPatterns: [...FLAT_CODE_PATTERNS, ...STRUCTURED_FLOW_PATTERNS],
  },

  // ── Days 8-10: Both skills being learned/applied ──────────────────────────

  {
    day: 8,
    name: "jwt-validator",
    prompt: `Write a TypeScript function called validateJwt that takes a JWT token string and a secret string, then returns the decoded payload or an error. Handle: missing token, empty token, malformed token (not 3 dot-separated parts), expired token, invalid signature. Keep it as a single function, no class wrappers.`,
    skillExposed: ["early-return", "premature-abstraction"],
    antiPatterns: [...EARLY_RETURN_PATTERNS, ...PREMATURE_ABSTRACTION_PATTERNS],
    goodPatterns: [...STRUCTURED_FLOW_PATTERNS, ...FLAT_CODE_PATTERNS],
  },
  {
    day: 9,
    name: "http-client",
    prompt: `Write a TypeScript function called fetchJson that takes a URL and optional RequestInit options, makes a fetch request, and returns the parsed JSON response. Handle: missing URL, network errors, non-200 status codes, invalid JSON responses, and timeouts. This is a utility wrapper, not an HTTP framework — one function, no classes.`,
    skillExposed: ["early-return", "premature-abstraction"],
    antiPatterns: [...EARLY_RETURN_PATTERNS, ...PREMATURE_ABSTRACTION_PATTERNS],
    goodPatterns: [...STRUCTURED_FLOW_PATTERNS, ...FLAT_CODE_PATTERNS],
  },
  {
    day: 10,
    name: "cache-store",
    prompt: `Write a TypeScript module that implements a simple TTL cache. Provide set(key, value, ttlMs), get(key), and delete(key) as exported functions. Use a Map internally. On get(), check if the entry has expired and remove it if so. This is a small utility — keep it under 30 lines, no class needed.`,
    skillExposed: ["premature-abstraction"],
    antiPatterns: PREMATURE_ABSTRACTION_PATTERNS,
    goodPatterns: FLAT_CODE_PATTERNS,
  },

  // ── Days 11-14: Both skills should be applied — complexity increases ──────

  {
    day: 11,
    name: "cli-arg-parser",
    prompt: `Write a TypeScript function called parseArgs that takes a string array (process.argv.slice(2)) and returns a parsed object with flags (--verbose, --dry-run) as booleans and key-value pairs (--output=file.txt, --port 3000) as strings. Handle: empty args, unknown flags, duplicate flags, missing values for key-value pairs. Single function, no class.`,
    skillExposed: ["early-return", "premature-abstraction"],
    antiPatterns: [...EARLY_RETURN_PATTERNS, ...PREMATURE_ABSTRACTION_PATTERNS],
    goodPatterns: [...STRUCTURED_FLOW_PATTERNS, ...FLAT_CODE_PATTERNS],
  },
  {
    day: 12,
    name: "websocket-handler",
    prompt: `Write a TypeScript function called handleMessage that takes a raw WebSocket message string and a context object { userId: string, roomId: string }. Parse the message as JSON, validate it has a "type" field, then handle types: "ping" (respond with pong), "chat" (validate message.text exists), "join" (validate message.room exists), unknown types. Return a response object. Single function.`,
    skillExposed: ["early-return", "premature-abstraction"],
    antiPatterns: [...EARLY_RETURN_PATTERNS, ...PREMATURE_ABSTRACTION_PATTERNS],
    goodPatterns: [...STRUCTURED_FLOW_PATTERNS, ...FLAT_CODE_PATTERNS],
  },
  {
    day: 13,
    name: "plugin-loader",
    prompt: `Write a TypeScript function called loadPlugin that takes a plugin path string and a config object. It should: validate the path, dynamically import the module, check that it exports an "init" function, call init with the config, and return the plugin instance. Handle all error cases (bad path, import failure, missing init, init throws). Keep it as one function — no PluginManager class, no BasePlugin, no AbstractLoader.`,
    skillExposed: ["early-return", "premature-abstraction"],
    antiPatterns: [...EARLY_RETURN_PATTERNS, ...PREMATURE_ABSTRACTION_PATTERNS],
    goodPatterns: [...STRUCTURED_FLOW_PATTERNS, ...FLAT_CODE_PATTERNS],
  },
  {
    day: 14,
    name: "api-gateway",
    prompt: `Write a TypeScript function called routeRequest that takes a Request object with method, path, headers, and body. Route to the correct handler based on path (/users, /posts, /health). Validate authentication (Bearer token in headers) for /users and /posts but not /health. Handle: missing auth, invalid token format, unknown paths, wrong HTTP method for the route. Return a Response object. Single function with if/else routing, no AbstractRouteHandler or middleware framework.`,
    skillExposed: ["early-return", "premature-abstraction"],
    antiPatterns: [...EARLY_RETURN_PATTERNS, ...PREMATURE_ABSTRACTION_PATTERNS],
    goodPatterns: [...STRUCTURED_FLOW_PATTERNS, ...FLAT_CODE_PATTERNS],
  },
];
