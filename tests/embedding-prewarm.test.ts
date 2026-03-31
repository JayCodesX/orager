/**
 * P2-7: Embedding cold-start prewarm tests.
 *
 * Verifies that the embedding prewarm logic:
 *   - is skipped when apiKey is not set
 *   - calls callEmbeddings for sessions with memoryEmbeddingModel
 *   - does not crash on failure
 *   - stores results in the embedding cache via setCachedQueryEmbedding
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

const TEST_SESSIONS_DIR = path.join(os.tmpdir(), `orager-test-prewarm-${process.pid}`);

beforeEach(async () => {
  await fs.mkdir(TEST_SESSIONS_DIR, { recursive: true, mode: 0o700 });
  process.env["ORAGER_SESSIONS_DIR"] = TEST_SESSIONS_DIR;
  vi.resetModules();
});

afterEach(async () => {
  delete process.env["ORAGER_SESSIONS_DIR"];
  await fs.rm(TEST_SESSIONS_DIR, { recursive: true, force: true });
  vi.resetModules();
  vi.restoreAllMocks();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function writeSessionFile(sessionId: string, data: object): Promise<void> {
  await fs.writeFile(
    path.join(TEST_SESSIONS_DIR, `${sessionId}.json`),
    JSON.stringify(data),
    { mode: 0o600 },
  );
}

// Minimal prewarm function extracted from daemon.ts logic for unit testing
async function runEmbeddingPrewarm(
  apiKey: string,
  sessionsDir: string,
  callEmbeddingsFn: (key: string, model: string, texts: string[]) => Promise<number[][]>,
  setCachedFn: (model: string, text: string, vec: number[]) => void,
): Promise<void> {
  if (!apiKey) return;
  try {
    let sessionFiles: string[] = [];
    try {
      const allFiles = await fs.readdir(sessionsDir);
      sessionFiles = allFiles.filter((f) => f.endsWith(".json") && !f.includes(".run.lock"));
    } catch {
      return;
    }

    const withMtime: Array<{ file: string; mtimeMs: number }> = [];
    for (const f of sessionFiles) {
      try {
        const stat = await fs.stat(path.join(sessionsDir, f));
        withMtime.push({ file: f, mtimeMs: stat.mtimeMs });
      } catch {
        withMtime.push({ file: f, mtimeMs: 0 });
      }
    }
    withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const candidates = withMtime.slice(0, 5);

    const tasks: Promise<void>[] = [];
    for (const { file } of candidates) {
      tasks.push((async () => {
        try {
          const raw = await fs.readFile(path.join(sessionsDir, file), "utf8");
          const session = JSON.parse(raw) as {
            opts?: { memoryEmbeddingModel?: string };
            messages?: Array<{ role: string; content?: string }>;
          };
          const embeddingModel = session.opts?.memoryEmbeddingModel;
          if (!embeddingModel) return;
          const msgs = session.messages ?? [];
          let lastPrompt = "";
          for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i];
            if (m.role === "user" && typeof m.content === "string" && m.content.trim()) {
              lastPrompt = m.content.trim().slice(0, 1000);
              break;
            }
          }
          if (!lastPrompt) return;
          const [vec] = await callEmbeddingsFn(apiKey, embeddingModel, [lastPrompt]);
          setCachedFn(embeddingModel, lastPrompt, vec);
        } catch {
          // silently ignore
        }
      })());
    }
    await Promise.all(tasks);
  } catch {
    // silently ignore
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("P2-7: embedding cold-start prewarm", () => {
  it("prewarm is skipped when apiKey is not set", async () => {
    const callEmbeddings = vi.fn();
    const setCached = vi.fn();

    await runEmbeddingPrewarm("", TEST_SESSIONS_DIR, callEmbeddings, setCached);

    expect(callEmbeddings).not.toHaveBeenCalled();
    expect(setCached).not.toHaveBeenCalled();
  });

  it("prewarm calls callEmbeddings for sessions with memoryEmbeddingModel", async () => {
    const sessionId = `test-${Date.now()}`;
    await writeSessionFile(sessionId, {
      sessionId,
      model: "test-model",
      opts: { memoryEmbeddingModel: "openai/text-embedding-3-small" },
      messages: [
        { role: "system", content: "System prompt" },
        { role: "user", content: "Hello, help me with this task" },
        { role: "assistant", content: "Sure!" },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      turnCount: 1,
      cwd: "/tmp",
    });

    const mockVec = [0.1, 0.2, 0.3];
    const callEmbeddings = vi.fn().mockResolvedValue([mockVec]);
    const setCached = vi.fn();

    await runEmbeddingPrewarm("test-api-key", TEST_SESSIONS_DIR, callEmbeddings, setCached);

    expect(callEmbeddings).toHaveBeenCalledTimes(1);
    expect(callEmbeddings).toHaveBeenCalledWith(
      "test-api-key",
      "openai/text-embedding-3-small",
      ["Hello, help me with this task"],
    );
    expect(setCached).toHaveBeenCalledWith(
      "openai/text-embedding-3-small",
      "Hello, help me with this task",
      mockVec,
    );
  });

  it("prewarm failure does not crash", async () => {
    const sessionId = `test-${Date.now()}`;
    await writeSessionFile(sessionId, {
      sessionId,
      model: "test-model",
      opts: { memoryEmbeddingModel: "openai/text-embedding-3-small" },
      messages: [{ role: "user", content: "What is the weather today?" }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      turnCount: 1,
      cwd: "/tmp",
    });

    // callEmbeddings throws — prewarm should silently catch it
    const callEmbeddings = vi.fn().mockRejectedValue(new Error("Network error"));
    const setCached = vi.fn();

    // Should not throw
    await runEmbeddingPrewarm("test-api-key", TEST_SESSIONS_DIR, callEmbeddings, setCached);

    // setCached should not have been called since callEmbeddings threw
    expect(setCached).not.toHaveBeenCalled();
  });

  it("sessions without memoryEmbeddingModel are skipped", async () => {
    const sessionId = `test-${Date.now()}`;
    await writeSessionFile(sessionId, {
      sessionId,
      model: "test-model",
      opts: {}, // no memoryEmbeddingModel
      messages: [{ role: "user", content: "Hello" }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      turnCount: 1,
      cwd: "/tmp",
    });

    const callEmbeddings = vi.fn();
    const setCached = vi.fn();

    await runEmbeddingPrewarm("test-api-key", TEST_SESSIONS_DIR, callEmbeddings, setCached);

    expect(callEmbeddings).not.toHaveBeenCalled();
    expect(setCached).not.toHaveBeenCalled();
  });

  it("setCachedQueryEmbedding is called with correct model and text", async () => {
    const sessionId = `test-${Date.now()}`;
    const expectedText = "What is the meaning of life?";
    const expectedModel = "openai/text-embedding-3-large";
    const expectedVec = [1.0, 2.0, 3.0, 4.0];

    await writeSessionFile(sessionId, {
      sessionId,
      model: "test-model",
      opts: { memoryEmbeddingModel: expectedModel },
      messages: [
        { role: "user", content: expectedText },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      turnCount: 1,
      cwd: "/tmp",
    });

    const callEmbeddings = vi.fn().mockResolvedValue([expectedVec]);
    const setCached = vi.fn();

    await runEmbeddingPrewarm("my-api-key", TEST_SESSIONS_DIR, callEmbeddings, setCached);

    expect(setCached).toHaveBeenCalledWith(expectedModel, expectedText, expectedVec);
  });
});
