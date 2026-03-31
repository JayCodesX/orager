/**
 * Browser automation tools powered by Playwright.
 *
 * These tools are only added to the agent's tool set when
 * `AgentLoopOptions.enableBrowserTools` is true.
 *
 * Requires playwright + Chromium:
 *   npm install playwright && npx playwright install chromium
 *
 * Browser state is keyed by session ID so concurrent daemon runs stay
 * isolated from each other. State is lazily created on first use and
 * cleaned up when `browser_close` is called or the process exits.
 *
 * Tools:
 *   browser_navigate   — Navigate to a URL
 *   browser_screenshot — Take a screenshot of the current page (returns image)
 *   browser_click      — Click at (x,y) coordinates or a CSS selector
 *   browser_type       — Type text (into a selector or the focused element)
 *   browser_key        — Press a keyboard key or chord
 *   browser_scroll     — Scroll the page
 *   browser_execute    — Run JavaScript in the page context
 *   browser_close      — Close the browser session
 */

import type { ToolExecuteOptions, ToolExecutor, ToolResult } from "../types.js";

// ── Minimal Playwright page interface ─────────────────────────────────────────
// We use a structural interface (not the full Playwright types) because
// playwright is an optional runtime dependency — not present at compile time.

interface PPage {
  goto(url: string, opts?: Record<string, unknown>): Promise<{ title(): Promise<string> } | void>;
  title(): Promise<string>;
  url(): string;
  screenshot(opts?: Record<string, unknown>): Promise<Buffer>;
  click(selector: string, opts?: Record<string, unknown>): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  waitForLoadState(state: string, opts?: Record<string, unknown>): Promise<void>;
  keyboard: {
    press(key: string): Promise<void>;
    type(text: string): Promise<void>;
  };
  mouse: {
    click(x: number, y: number, opts?: Record<string, unknown>): Promise<void>;
    wheel(deltaX: number, deltaY: number): Promise<void>;
  };
  evaluate<T = unknown>(script: string): Promise<T>;
}

interface PContext {
  newPage(): Promise<PPage>;
}

interface PBrowser {
  newContext(opts: Record<string, unknown>): Promise<PContext>;
  close(): Promise<void>;
}

// ── Session pool ───────────────────────────────────────────────────────────────

interface BrowserState {
  browser: PBrowser;
  page: PPage;
}

const _sessions = new Map<string, BrowserState>();

// Synchronous fallback — cannot await; see M-12 beforeExit handler for async cleanup.
process.on("exit", () => {
  for (const state of _sessions.values()) {
    try { void state.browser.close(); } catch { /* ok */ }
  }
});

// SIGTERM: async Playwright cleanup for graceful daemon shutdown.
// A 5s keepalive timeout forces exit if browser.close() hangs.
process.on("SIGTERM", () => {
  const forceExit = setTimeout(() => process.exit(0), 5_000);
  void Promise.all(
    Array.from(_sessions.keys()).map((sid) => closeSession(sid).catch(() => {}))
  ).then(() => {
    clearTimeout(forceExit);
    process.exit(0);
  });
});

let _beforeExitCalled = false;
process.on("beforeExit", () => {
  if (_beforeExitCalled || _sessions.size === 0) return;
  _beforeExitCalled = true;
  // M-12: beforeExit allows async cleanup unlike the synchronous "exit" event.
  void Promise.all(
    Array.from(_sessions.keys()).map((sid) => closeSession(sid).catch(() => {}))
  );
});

async function getPlaywright(): Promise<{ chromium: { launch(opts: Record<string, unknown>): Promise<PBrowser> } }> {
  try {
    return (await import("playwright")) as unknown as { chromium: { launch(opts: Record<string, unknown>): Promise<PBrowser> } };
  } catch {
    throw new Error(
      "Playwright is not installed. " +
      "Run: npm install playwright && npx playwright install chromium",
    );
  }
}

async function getSession(sessionId: string): Promise<BrowserState> {
  const existing = _sessions.get(sessionId);
  if (existing) return existing;

  const pw = await getPlaywright();
  const browser = await pw.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();

  const state: BrowserState = { browser, page };
  _sessions.set(sessionId, state);
  return state;
}

async function closeSession(sessionId: string): Promise<void> {
  const state = _sessions.get(sessionId);
  if (!state) return;
  _sessions.delete(sessionId);
  try { await state.browser.close(); } catch { /* ok */ }
}

function sessionKey(opts?: ToolExecuteOptions): string {
  return typeof opts?.sessionId === "string" && opts.sessionId
    ? opts.sessionId
    : "default";
}

function notInstalled(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("not installed");
}

// ── Tool: browser_navigate ─────────────────────────────────────────────────────

export const browserNavigateTool: ToolExecutor = {
  definition: {
    type: "function",
    function: {
      name: "browser_navigate",
      description:
        "Open a URL in the browser. Creates a new browser session if one does not exist. " +
        "Returns the page title and final URL after navigation.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "URL to navigate to (must include scheme, e.g. https://)",
          },
          timeout_ms: {
            type: "number",
            description: "Navigation timeout in milliseconds (default 30000)",
          },
        },
        required: ["url"],
      },
    },
  },

  async execute(input, _cwd, opts): Promise<ToolResult> {
    const url = typeof input["url"] === "string" ? input["url"].trim() : "";
    if (!url) return { toolCallId: "", content: "url must be a non-empty string", isError: true };
    if (!/^https?:\/\//i.test(url)) return { toolCallId: "", content: "url must start with http:// or https://", isError: true };
    const timeoutMs = typeof input["timeout_ms"] === "number" ? input["timeout_ms"] : 30_000;

    let state: BrowserState;
    try {
      state = await getSession(sessionKey(opts));
    } catch (err) {
      return { toolCallId: "", content: String(err), isError: !notInstalled(err) };
    }

    try {
      await state.page.goto(url, { timeout: timeoutMs, waitUntil: "domcontentloaded" });
      await state.page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {/* timeout ok */});
      const title = await state.page.title();
      const finalUrl = state.page.url();
      return { toolCallId: "", content: `Navigated to: ${finalUrl}\nTitle: ${title}`, isError: false };
    } catch (err) {
      return { toolCallId: "", content: `Navigation failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  },
};

// ── Tool: browser_screenshot ───────────────────────────────────────────────────

export const browserScreenshotTool: ToolExecutor = {
  definition: {
    type: "function",
    function: {
      name: "browser_screenshot",
      description:
        "Take a screenshot of the current browser page. " +
        "Returns an image so you can see the current state of the page. " +
        "Call browser_navigate first if no session is open.",
      parameters: {
        type: "object",
        properties: {
          full_page: {
            type: "boolean",
            description: "Capture the full scrollable page height (default false — viewport only)",
          },
        },
        required: [],
      },
    },
  },

  async execute(input, _cwd, opts): Promise<ToolResult> {
    let state: BrowserState;
    try {
      state = await getSession(sessionKey(opts));
    } catch (err) {
      return { toolCallId: "", content: String(err), isError: true };
    }

    try {
      const fullPage = input["full_page"] === true;
      const buf = await state.page.screenshot({ fullPage: fullPage ?? false });
      const MAX_SCREENSHOT_BYTES = 3 * 1024 * 1024; // 3MB — ~2250 tokens at typical rates
      if (buf.length > MAX_SCREENSHOT_BYTES) {
        // Retry with jpeg at lower quality to fit under the limit
        const jpegBuf = await state.page.screenshot({
          fullPage: fullPage ?? false,
          type: "jpeg" as "png",  // cast needed for minimal type interface
          quality: 50 as number,
        }).catch(async () => buf); // fallback to original if jpeg fails
        if (jpegBuf.length > MAX_SCREENSHOT_BYTES) {
          return {
            toolCallId: "",
            content: `Screenshot too large (${(buf.length / 1024 / 1024).toFixed(1)} MB). Try full_page: false to reduce size.`,
            isError: true,
          };
        }
        const b64 = jpegBuf.toString("base64");
        return { toolCallId: "", content: `Screenshot captured (JPEG, ${(jpegBuf.length / 1024).toFixed(0)} KB)`, imageUrl: `data:image/jpeg;base64,${b64}`, isError: false };
      }
      const b64 = buf.toString("base64");
      const title = await state.page.title();
      const url = state.page.url();
      return {
        toolCallId: "",
        content: `Screenshot of: ${url}\nTitle: ${title}`,
        imageUrl: `data:image/png;base64,${b64}`,
        isError: false,
      };
    } catch (err) {
      return { toolCallId: "", content: `Screenshot failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  },
};

// ── Tool: browser_click ────────────────────────────────────────────────────────

export const browserClickTool: ToolExecutor = {
  definition: {
    type: "function",
    function: {
      name: "browser_click",
      description:
        "Click on the page. Provide either (x, y) pixel coordinates or a CSS selector. " +
        "When using a selector, clicks the first matching element.",
      parameters: {
        type: "object",
        properties: {
          x: { type: "number", description: "X coordinate in pixels from left edge of viewport" },
          y: { type: "number", description: "Y coordinate in pixels from top edge of viewport" },
          selector: { type: "string", description: "CSS selector of the element to click" },
          button: {
            type: "string",
            enum: ["left", "right", "middle"],
            description: "Mouse button (default: left)",
          },
          double: { type: "boolean", description: "Double-click (default false)" },
        },
        required: [],
      },
    },
  },

  async execute(input, _cwd, opts): Promise<ToolResult> {
    const selector = typeof input["selector"] === "string" ? input["selector"] : null;
    const x = typeof input["x"] === "number" ? input["x"] : null;
    const y = typeof input["y"] === "number" ? input["y"] : null;
    if (!selector && (x === null || y === null)) {
      return { toolCallId: "", content: "Provide either (x, y) coordinates or a CSS selector", isError: true };
    }

    let state: BrowserState;
    try {
      state = await getSession(sessionKey(opts));
    } catch (err) {
      return { toolCallId: "", content: String(err), isError: true };
    }

    const button = (typeof input["button"] === "string" ? input["button"] : "left") as "left" | "right" | "middle";
    const clickCount = input["double"] === true ? 2 : 1;

    try {
      if (selector) {
        await state.page.click(selector, { button, clickCount });
        return { toolCallId: "", content: `Clicked selector: ${selector}`, isError: false };
      } else {
        await state.page.mouse.click(x!, y!, { button, clickCount });
        return { toolCallId: "", content: `Clicked at (${x}, ${y})`, isError: false };
      }
    } catch (err) {
      return { toolCallId: "", content: `Click failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  },
};

// ── Tool: browser_type ─────────────────────────────────────────────────────────

export const browserTypeTool: ToolExecutor = {
  definition: {
    type: "function",
    function: {
      name: "browser_type",
      description:
        "Type text. If a selector is given, fills that input (replacing existing content). " +
        "Without a selector, types into the currently focused element (appends). " +
        "For form submission, follow with browser_key({ key: 'Enter' }).",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to type" },
          selector: { type: "string", description: "CSS selector of the input to fill (optional)" },
        },
        required: ["text"],
      },
    },
  },

  async execute(input, _cwd, opts): Promise<ToolResult> {
    const text = typeof input["text"] === "string" ? input["text"] : "";
    if (!text) return { toolCallId: "", content: "text must be a non-empty string", isError: true };

    let state: BrowserState;
    try {
      state = await getSession(sessionKey(opts));
    } catch (err) {
      return { toolCallId: "", content: String(err), isError: true };
    }

    try {
      const selector = typeof input["selector"] === "string" ? input["selector"] : null;
      if (selector) {
        // fill() replaces the entire content of the input
        await state.page.fill(selector, text);
      } else {
        // keyboard.type() appends to the currently focused element
        await state.page.keyboard.type(text);
      }
      const preview = text.length > 80 ? text.slice(0, 80) + "…" : text;
      return { toolCallId: "", content: `Typed: ${preview}`, isError: false };
    } catch (err) {
      return { toolCallId: "", content: `Type failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  },
};

// ── Tool: browser_key ──────────────────────────────────────────────────────────

export const browserKeyTool: ToolExecutor = {
  definition: {
    type: "function",
    function: {
      name: "browser_key",
      description:
        "Press a keyboard key or chord, e.g. 'Enter', 'Tab', 'Escape', 'Control+a', 'Meta+c'. " +
        "Uses Playwright key names.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "Key name or chord to press (e.g. 'Enter', 'Control+a')" },
        },
        required: ["key"],
      },
    },
  },

  async execute(input, _cwd, opts): Promise<ToolResult> {
    const key = typeof input["key"] === "string" ? input["key"].trim() : "";
    if (!key) return { toolCallId: "", content: "key must be a non-empty string", isError: true };

    let state: BrowserState;
    try {
      state = await getSession(sessionKey(opts));
    } catch (err) {
      return { toolCallId: "", content: String(err), isError: true };
    }

    try {
      await state.page.keyboard.press(key);
      return { toolCallId: "", content: `Pressed: ${key}`, isError: false };
    } catch (err) {
      return { toolCallId: "", content: `Key press failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  },
};

// ── Tool: browser_scroll ───────────────────────────────────────────────────────

export const browserScrollTool: ToolExecutor = {
  definition: {
    type: "function",
    function: {
      name: "browser_scroll",
      description: "Scroll the page in a direction by a given number of pixels.",
      parameters: {
        type: "object",
        properties: {
          direction: {
            type: "string",
            enum: ["up", "down", "left", "right"],
            description: "Direction to scroll",
          },
          pixels: { type: "number", description: "Pixels to scroll (default 500)" },
        },
        required: ["direction"],
      },
    },
  },

  async execute(input, _cwd, opts): Promise<ToolResult> {
    const direction = typeof input["direction"] === "string" ? input["direction"] : "down";
    const pixels = typeof input["pixels"] === "number" ? input["pixels"] : 500;

    let state: BrowserState;
    try {
      state = await getSession(sessionKey(opts));
    } catch (err) {
      return { toolCallId: "", content: String(err), isError: true };
    }

    const deltaX = direction === "left" ? -pixels : direction === "right" ? pixels : 0;
    const deltaY = direction === "up" ? -pixels : direction === "down" ? pixels : 0;

    try {
      await state.page.mouse.wheel(deltaX, deltaY);
      return { toolCallId: "", content: `Scrolled ${direction} ${pixels}px`, isError: false };
    } catch (err) {
      return { toolCallId: "", content: `Scroll failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  },
};

// ── Tool: browser_execute ──────────────────────────────────────────────────────

export const browserExecuteTool: ToolExecutor = {
  definition: {
    type: "function",
    function: {
      name: "browser_execute",
      description:
        "Run JavaScript in the current page context and return the result. " +
        "Use this to read DOM state, extract text, or perform complex interactions. " +
        "`document` and `window` are available. Use `return` to send a value back.",
      parameters: {
        type: "object",
        properties: {
          script: {
            type: "string",
            description: "JavaScript to execute. Use `return` to produce output.",
          },
        },
        required: ["script"],
      },
    },
  },

  async execute(input, _cwd, opts): Promise<ToolResult> {
    const script = typeof input["script"] === "string" ? input["script"].trim() : "";
    if (!script) return { toolCallId: "", content: "script must be a non-empty string", isError: true };

    let state: BrowserState;
    try {
      state = await getSession(sessionKey(opts));
    } catch (err) {
      return { toolCallId: "", content: String(err), isError: true };
    }

    try {
      // Wrap in IIFE so bare `return` statements work
      const result = await state.page.evaluate(`(function() { ${script} })()`);
      const output = result === undefined || result === null
        ? "(no return value)"
        : typeof result === "object"
          ? JSON.stringify(result, null, 2)
          : String(result);
      const capped = output.length > 10_000 ? output.slice(0, 10_000) + "\n[truncated]" : output;
      return { toolCallId: "", content: capped, isError: false };
    } catch (err) {
      return { toolCallId: "", content: `Script failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  },
};

// ── Tool: browser_close ────────────────────────────────────────────────────────

export const browserCloseTool: ToolExecutor = {
  definition: {
    type: "function",
    function: {
      name: "browser_close",
      description:
        "Close the browser and release all resources. " +
        "Call this when browser automation is complete.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },

  async execute(_input, _cwd, opts): Promise<ToolResult> {
    const key = sessionKey(opts);
    if (!_sessions.has(key)) {
      return { toolCallId: "", content: "No browser session is open", isError: false };
    }
    await closeSession(key);
    return { toolCallId: "", content: "Browser session closed", isError: false };
  },
};

// ── Test helpers ──────────────────────────────────────────────────────────────

/**
 * Close all open browser sessions and clear the session pool.
 * Only intended for use in tests — call in afterEach to prevent leaks.
 */
export async function _clearBrowserSessionsForTesting(): Promise<void> {
  const keys = Array.from(_sessions.keys());
  await Promise.all(keys.map((k) => closeSession(k)));
}

// ── Exported tool set ──────────────────────────────────────────────────────────

export const BROWSER_TOOLS: ToolExecutor[] = [
  browserNavigateTool,
  browserScreenshotTool,
  browserClickTool,
  browserTypeTool,
  browserKeyTool,
  browserScrollTool,
  browserExecuteTool,
  browserCloseTool,
];
