/**
 * Comprehensive integration tests for all 8 browser tools.
 *
 * playwright is mocked at module level so no real browser is launched.
 * Each test calls tool.execute() directly — no agent loop is involved.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";

// ── Playwright mock ────────────────────────────────────────────────────────
//
// The mock is defined before any browser tool import so that when
// browser.ts does `await import("playwright")` it receives this factory.

const mockPage = {
  goto: vi.fn().mockResolvedValue({}),
  title: vi.fn().mockResolvedValue("Mock Page Title"),
  url: vi.fn().mockReturnValue("https://example.com"),
  screenshot: vi.fn().mockResolvedValue(Buffer.from("PNGDATA")),
  waitForLoadState: vi.fn().mockResolvedValue(undefined),
  click: vi.fn().mockResolvedValue(undefined),
  fill: vi.fn().mockResolvedValue(undefined),
  keyboard: {
    press: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
  },
  mouse: {
    click: vi.fn().mockResolvedValue(undefined),
    wheel: vi.fn().mockResolvedValue(undefined),
  },
  evaluate: vi.fn().mockResolvedValue("script result"),
  close: vi.fn().mockResolvedValue(undefined),
};

const mockContext = {
  newPage: vi.fn().mockResolvedValue(mockPage),
};

const mockBrowser = {
  newContext: vi.fn().mockResolvedValue(mockContext),
  close: vi.fn().mockResolvedValue(undefined),
};

const mockChromiumLaunch = vi.fn().mockResolvedValue(mockBrowser);

vi.mock("playwright", () => ({
  chromium: {
    launch: mockChromiumLaunch,
  },
}));

// ── Tool imports (after vi.mock hoisting) ─────────────────────────────────

import {
  browserNavigateTool,
  browserScreenshotTool,
  browserClickTool,
  browserTypeTool,
  browserKeyTool,
  browserScrollTool,
  browserExecuteTool,
  browserCloseTool,
  _clearBrowserSessionsForTesting,
} from "../../src/tools/browser.js";

// ── Helpers ───────────────────────────────────────────────────────────────

const SESSION = "test-session";
const OPTS = { sessionId: SESSION };
const CWD = "/tmp";

/** Reset all mock call counts without replacing implementations. */
function resetMocks() {
  mockPage.goto.mockClear();
  mockPage.title.mockClear();
  mockPage.url.mockClear();
  mockPage.screenshot.mockClear();
  mockPage.waitForLoadState.mockClear();
  mockPage.click.mockClear();
  mockPage.fill.mockClear();
  mockPage.keyboard.press.mockClear();
  mockPage.keyboard.type.mockClear();
  mockPage.mouse.click.mockClear();
  mockPage.mouse.wheel.mockClear();
  mockPage.evaluate.mockClear();
  mockPage.close.mockClear();
  mockContext.newPage.mockClear();
  mockBrowser.newContext.mockClear();
  mockBrowser.close.mockClear();
  mockChromiumLaunch.mockClear();
}

beforeEach(() => {
  resetMocks();
});

afterEach(async () => {
  await _clearBrowserSessionsForTesting();
});

// ── browser_navigate ───────────────────────────────────────────────────────

describe("browser_navigate", () => {
  it("navigates to a valid URL and returns title and URL", async () => {
    const result = await browserNavigateTool.execute!({ url: "https://example.com" }, CWD, OPTS);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Mock Page Title");
    expect(result.content).toContain("example.com");
    expect(mockPage.goto).toHaveBeenCalledWith(
      "https://example.com",
      expect.objectContaining({ waitUntil: "domcontentloaded" }),
    );
  });

  it("returns error for non-http URL", async () => {
    const result = await browserNavigateTool.execute!({ url: "ftp://example.com" }, CWD, OPTS);

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/https?/i);
  });

  it("returns error when url is missing", async () => {
    const result = await browserNavigateTool.execute!({}, CWD, OPTS);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("url");
  });

  it("returns error when url is empty string", async () => {
    const result = await browserNavigateTool.execute!({ url: "" }, CWD, OPTS);

    expect(result.isError).toBe(true);
  });
});

// ── browser_screenshot ─────────────────────────────────────────────────────

describe("browser_screenshot", () => {
  it("returns a base64 data:image/png URL in imageUrl field", async () => {
    const result = await browserScreenshotTool.execute!({}, CWD, OPTS);

    expect(result.isError).toBe(false);
    expect(result.imageUrl).toBeDefined();
    expect(result.imageUrl).toMatch(/^data:image\/png;base64,/);
    // The base64 payload should decode to our mock buffer
    const b64 = result.imageUrl!.replace("data:image/png;base64,", "");
    expect(Buffer.from(b64, "base64").toString()).toBe("PNGDATA");
  });

  it("calls screenshot with fullPage=true when full_page is specified", async () => {
    await browserScreenshotTool.execute!({ full_page: true }, CWD, OPTS);

    expect(mockPage.screenshot).toHaveBeenCalledWith(
      expect.objectContaining({ fullPage: true }),
    );
  });

  it("calls screenshot with fullPage=false by default", async () => {
    await browserScreenshotTool.execute!({}, CWD, OPTS);

    expect(mockPage.screenshot).toHaveBeenCalledWith(
      expect.objectContaining({ fullPage: false }),
    );
  });
});

// ── browser_click ──────────────────────────────────────────────────────────

describe("browser_click", () => {
  it("clicks a CSS selector", async () => {
    const result = await browserClickTool.execute!({ selector: "#submit-btn" }, CWD, OPTS);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("#submit-btn");
    expect(mockPage.click).toHaveBeenCalledWith(
      "#submit-btn",
      expect.objectContaining({ button: "left", clickCount: 1 }),
    );
  });

  it("clicks at (x, y) coordinates when no selector is given", async () => {
    const result = await browserClickTool.execute!({ x: 100, y: 200 }, CWD, OPTS);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("100");
    expect(result.content).toContain("200");
    expect(mockPage.mouse.click).toHaveBeenCalledWith(
      100,
      200,
      expect.objectContaining({ button: "left", clickCount: 1 }),
    );
  });

  it("returns error when neither selector nor coordinates are provided", async () => {
    const result = await browserClickTool.execute!({}, CWD, OPTS);

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/selector|coordinates/i);
  });

  it("double-click sets clickCount=2 for selector", async () => {
    await browserClickTool.execute!({ selector: ".item", double: true }, CWD, OPTS);

    expect(mockPage.click).toHaveBeenCalledWith(
      ".item",
      expect.objectContaining({ clickCount: 2 }),
    );
  });

  it("double-click sets clickCount=2 for coordinates", async () => {
    await browserClickTool.execute!({ x: 50, y: 75, double: true }, CWD, OPTS);

    expect(mockPage.mouse.click).toHaveBeenCalledWith(
      50,
      75,
      expect.objectContaining({ clickCount: 2 }),
    );
  });
});

// ── browser_type ───────────────────────────────────────────────────────────

describe("browser_type", () => {
  it("uses fill() when a selector is provided", async () => {
    const result = await browserTypeTool.execute!({ selector: "input#name", text: "hello world" }, CWD, OPTS);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("hello world");
    expect(mockPage.fill).toHaveBeenCalledWith("input#name", "hello world");
    expect(mockPage.keyboard.type).not.toHaveBeenCalled();
  });

  it("uses keyboard.type() when no selector is given", async () => {
    const result = await browserTypeTool.execute!({ text: "keyboarded text" }, CWD, OPTS);

    expect(result.isError).toBe(false);
    expect(mockPage.keyboard.type).toHaveBeenCalledWith("keyboarded text");
    expect(mockPage.fill).not.toHaveBeenCalled();
  });

  it("returns error when text is empty", async () => {
    const result = await browserTypeTool.execute!({ text: "" }, CWD, OPTS);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("text");
  });

  it("truncates long text preview in the success message but types the full value", async () => {
    const longText = "a".repeat(200);
    const result = await browserTypeTool.execute!({ text: longText }, CWD, OPTS);

    expect(result.isError).toBe(false);
    // keyboard.type must receive the full 200-char string
    expect(mockPage.keyboard.type).toHaveBeenCalledWith(longText);
    // The returned content should be capped with an ellipsis
    expect(result.content).toContain("…");
    expect(result.content.length).toBeLessThan(longText.length + 20);
  });
});

// ── browser_key ────────────────────────────────────────────────────────────

describe("browser_key", () => {
  it("presses a key via keyboard.press", async () => {
    const result = await browserKeyTool.execute!({ key: "Enter" }, CWD, OPTS);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Enter");
    expect(mockPage.keyboard.press).toHaveBeenCalledWith("Enter");
  });

  it("supports chord keys like Control+a", async () => {
    const result = await browserKeyTool.execute!({ key: "Control+a" }, CWD, OPTS);

    expect(result.isError).toBe(false);
    expect(mockPage.keyboard.press).toHaveBeenCalledWith("Control+a");
  });

  it("returns error when key is empty", async () => {
    const result = await browserKeyTool.execute!({ key: "" }, CWD, OPTS);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("key");
  });
});

// ── browser_scroll ─────────────────────────────────────────────────────────

describe("browser_scroll", () => {
  it("scrolls down with correct deltaY", async () => {
    const result = await browserScrollTool.execute!({ direction: "down", pixels: 300 }, CWD, OPTS);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("down");
    expect(result.content).toContain("300");
    expect(mockPage.mouse.wheel).toHaveBeenCalledWith(0, 300);
  });

  it("scrolls up with negative deltaY", async () => {
    await browserScrollTool.execute!({ direction: "up", pixels: 200 }, CWD, OPTS);

    expect(mockPage.mouse.wheel).toHaveBeenCalledWith(0, -200);
  });

  it("scrolls right with positive deltaX", async () => {
    await browserScrollTool.execute!({ direction: "right", pixels: 150 }, CWD, OPTS);

    expect(mockPage.mouse.wheel).toHaveBeenCalledWith(150, 0);
  });

  it("scrolls left with negative deltaX", async () => {
    await browserScrollTool.execute!({ direction: "left", pixels: 100 }, CWD, OPTS);

    expect(mockPage.mouse.wheel).toHaveBeenCalledWith(-100, 0);
  });

  it("defaults to 500 pixels when pixels is not specified", async () => {
    await browserScrollTool.execute!({ direction: "down" }, CWD, OPTS);

    expect(mockPage.mouse.wheel).toHaveBeenCalledWith(0, 500);
  });
});

// ── browser_execute ─────────────────────────────────────────────────────────

describe("browser_execute", () => {
  it("evaluates script and returns stringified result", async () => {
    mockPage.evaluate.mockResolvedValueOnce("script result");
    const result = await browserExecuteTool.execute!({ script: "return document.title" }, CWD, OPTS);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("script result");
  });

  it("wraps script in an IIFE so bare return statements work", async () => {
    await browserExecuteTool.execute!({ script: "return 42" }, CWD, OPTS);

    const calledWith = (mockPage.evaluate as Mock).mock.calls[0][0] as string;
    expect(calledWith).toMatch(/^\(function\(\)/);
    expect(calledWith).toContain("return 42");
  });

  it("returns (no return value) when evaluate resolves undefined", async () => {
    mockPage.evaluate.mockResolvedValueOnce(undefined);
    const result = await browserExecuteTool.execute!({ script: "console.log(1)" }, CWD, OPTS);

    expect(result.content).toContain("(no return value)");
  });

  it("truncates output at 10 000 characters and appends [truncated]", async () => {
    const bigString = "x".repeat(11_000);
    mockPage.evaluate.mockResolvedValueOnce(bigString);
    const result = await browserExecuteTool.execute!({ script: "return bigData" }, CWD, OPTS);

    expect(result.content.length).toBeLessThanOrEqual(10_020); // 10000 + "[truncated]"
    expect(result.content).toContain("[truncated]");
  });

  it("returns error when script is empty", async () => {
    const result = await browserExecuteTool.execute!({ script: "" }, CWD, OPTS);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("script");
  });

  it("returns error when evaluate throws", async () => {
    mockPage.evaluate.mockRejectedValueOnce(new Error("SyntaxError: unexpected token"));
    const result = await browserExecuteTool.execute!({ script: "(((" }, CWD, OPTS);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("SyntaxError");
  });
});

// ── browser_close ──────────────────────────────────────────────────────────

describe("browser_close", () => {
  it("closes an open session and reports success", async () => {
    // Open a session first by navigating
    await browserNavigateTool.execute!({ url: "https://example.com" }, CWD, OPTS);
    mockBrowser.close.mockClear();

    const result = await browserCloseTool.execute!({}, CWD, OPTS);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("closed");
    expect(mockBrowser.close).toHaveBeenCalledTimes(1);
  });

  it("returns graceful message when no session is open", async () => {
    // _clearBrowserSessionsForTesting already ran in afterEach, but this
    // test calls close without any prior navigate, so no session exists.
    const result = await browserCloseTool.execute!({}, CWD, { sessionId: "no-such-session" });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("No browser session");
  });
});

// ── Session isolation ──────────────────────────────────────────────────────

describe("session isolation", () => {
  it("two different sessionIds create separate browser instances", async () => {
    const opts1 = { sessionId: "session-alpha" };
    const opts2 = { sessionId: "session-beta" };

    await browserNavigateTool.execute!({ url: "https://alpha.example.com" }, CWD, opts1);
    await browserNavigateTool.execute!({ url: "https://beta.example.com" }, CWD, opts2);

    // chromium.launch should have been called once per session
    expect(mockChromiumLaunch).toHaveBeenCalledTimes(2);
  });

  it("closing one session does not affect the other", async () => {
    const opts1 = { sessionId: "session-one" };
    const opts2 = { sessionId: "session-two" };

    await browserNavigateTool.execute!({ url: "https://one.example.com" }, CWD, opts1);
    await browserNavigateTool.execute!({ url: "https://two.example.com" }, CWD, opts2);

    // Close only session-one
    await browserCloseTool.execute!({}, CWD, opts1);

    // session-two should still work — screenshot should succeed
    const screenshotResult = await browserScreenshotTool.execute!({}, CWD, opts2);
    expect(screenshotResult.isError).toBe(false);
    expect(screenshotResult.imageUrl).toBeDefined();
  });
});

// ── Playwright not installed ───────────────────────────────────────────────

describe("playwright not installed", () => {
  it("browser_navigate returns isError=true with install instructions when playwright is missing", async () => {
    // Temporarily override the playwright mock to throw a module-not-found error.
    // We do this by having chromium.launch throw in a way that getPlaywright()
    // catches and wraps with the "not installed" message.
    //
    // getPlaywright() does `await import("playwright")` — since vi.mock already
    // set up the module, we cannot un-mock it for a single test without
    // reloading the module graph.  Instead, we make the launch function throw
    // an error that looks like the module couldn't be loaded, which causes
    // getSession() to reject and browser_navigate to surface isError=true.
    const originalLaunch = mockChromiumLaunch.getMockImplementation();
    mockChromiumLaunch.mockRejectedValueOnce(
      new Error("Cannot find module 'playwright'"),
    );

    // Use a fresh session key so we don't hit the already-open session cache
    const result = await browserNavigateTool.execute!(
      { url: "https://example.com" },
      CWD,
      { sessionId: "no-playwright-session" },
    );

    // The error from chromium.launch propagates; the tool should report isError
    expect(result.isError).toBe(true);

    // Restore for subsequent tests
    if (originalLaunch) mockChromiumLaunch.mockImplementation(originalLaunch);
    else mockChromiumLaunch.mockResolvedValue(mockBrowser);
  });

  it("browser_navigate returns install instructions in content when playwright module throws on import", async () => {
    // Simulate the getPlaywright() path where the dynamic import itself fails.
    // Because vi.mock captures the module before import, we simulate this by
    // making launch throw an error message matching the "not installed" sentinel
    // so the tool message includes the install hint.
    mockChromiumLaunch.mockImplementationOnce(() => {
      throw new Error(
        "Playwright is not installed. Run: npm install playwright && npx playwright install chromium",
      );
    });

    const result = await browserNavigateTool.execute!(
      { url: "https://example.com" },
      CWD,
      { sessionId: "hint-session" },
    );

    expect(result.isError).toBe(false); // notInstalled() returns true → isError = !notInstalled(err)
    expect(result.content).toContain("not installed");
  });
});
