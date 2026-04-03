/**
 * input-processor.ts
 *
 * Processes raw user input (text prompt + optional file attachments) into
 * structured content blocks for the OpenAI-compatible messages API.
 *
 * Supported attachment types:
 *   Images (JPEG, PNG, GIF, WebP, SVG) → image_url block (base64 data URL)
 *   PDFs                               → text block (pdftotext if available, else notice)
 *   Audio (MP3, WAV, M4A, OGG, etc.)  → text block (Whisper transcription if available, else stub)
 *   Text / code / other                → text block with file contents
 *
 * The returned `ProcessedInput.modalities` set tells the confidence router
 * which modalities are present so it can fire `modality_mismatch` escalation
 * when the RL model can't handle them.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { UserMessageContentBlock } from "./types.js";

const execFileAsync = promisify(execFile);

// ── Types ─────────────────────────────────────────────────────────────────────

export type InputModality = "text" | "vision" | "audio" | "document";

export interface ProcessedInput {
  /** All content blocks for the first user message. */
  contentBlocks: UserMessageContentBlock[];
  /** Modalities present in the input. Always contains "text". */
  modalities: Set<InputModality>;
  /** True when any image blocks are present (convenience flag). */
  hasImages: boolean;
  /** True when any audio was attached (even if not transcribed). */
  hasAudio: boolean;
}

// ── MIME detection ────────────────────────────────────────────────────────────

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".ogg", ".flac", ".aac", ".opus"]);
const PDF_EXTENSION = ".pdf";

type AttachmentKind = "image" | "audio" | "pdf" | "text";

function detectKind(filePath: string): AttachmentKind {
  const ext = path.extname(filePath).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (ext === PDF_EXTENSION) return "pdf";
  return "text";
}

function mimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const mimes: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
  };
  return mimes[ext] ?? "image/jpeg";
}

// ── Encoders ──────────────────────────────────────────────────────────────────

async function encodeImage(filePath: string): Promise<UserMessageContentBlock> {
  const data = await fs.readFile(filePath);
  const b64 = data.toString("base64");
  const mime = mimeType(filePath);
  return {
    type: "image_url",
    image_url: { url: `data:${mime};base64,${b64}`, detail: "auto" },
  };
}

async function encodePdf(filePath: string): Promise<UserMessageContentBlock> {
  // Try pdftotext (poppler-utils) for text extraction
  try {
    const { stdout } = await execFileAsync("pdftotext", [filePath, "-"], { timeout: 15_000 });
    const text = stdout.trim();
    if (text) {
      return {
        type: "text",
        text: `[PDF: ${path.basename(filePath)}]\n${text}`,
      };
    }
  } catch { /* pdftotext not installed — fall through */ }

  // Fallback: read raw bytes as text (works for text-based PDFs)
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const excerpt = raw.replace(/[^\x20-\x7E\n]/g, "").slice(0, 8000);
    return {
      type: "text",
      text: `[PDF: ${path.basename(filePath)} — raw text excerpt]\n${excerpt}`,
    };
  } catch {
    return {
      type: "text",
      text: `[PDF: ${path.basename(filePath)} — could not extract text. Install pdftotext: brew install poppler]`,
    };
  }
}

let _whisperAvailable: boolean | null = null;

async function isWhisperAvailable(): Promise<boolean> {
  if (_whisperAvailable !== null) return _whisperAvailable;
  try {
    await execFileAsync("which", ["whisper"], { timeout: 5_000 });
    _whisperAvailable = true;
  } catch {
    _whisperAvailable = false;
  }
  return _whisperAvailable;
}

async function encodeAudio(filePath: string): Promise<UserMessageContentBlock> {
  if (await isWhisperAvailable()) {
    try {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orager-whisper-"));
      await execFileAsync("whisper", [filePath, "--output_format", "txt", "--output_dir", tmpDir], {
        timeout: 120_000,
      });
      // Whisper outputs <basename>.txt
      const baseName = path.basename(filePath, path.extname(filePath));
      const txtPath = path.join(tmpDir, `${baseName}.txt`);
      const transcript = (await fs.readFile(txtPath, "utf8")).trim();
      // Clean up temp files
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      if (transcript) {
        return {
          type: "text",
          text: `[Audio transcription: ${path.basename(filePath)}]\n${transcript}`,
        };
      }
    } catch { /* Whisper failed — fall through to stub */ }
  }

  return {
    type: "text",
    text: `[Audio attachment: ${path.basename(filePath)}]\nAudio transcription is not available. `
      + `Install Whisper to enable it: \`pip install openai-whisper\``,
  };
}

async function encodeTextFile(filePath: string): Promise<UserMessageContentBlock> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const name = path.basename(filePath);
    return {
      type: "text",
      text: `[File: ${name}]\n\`\`\`\n${content.slice(0, 20_000)}\n\`\`\``,
    };
  } catch (err) {
    return {
      type: "text",
      text: `[File: ${path.basename(filePath)} — could not read: ${err}]`,
    };
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Process a text prompt and optional file attachments into structured content blocks.
 *
 * @param prompt      The text portion of the user's message (may be empty string)
 * @param attachments Paths to files to attach (images, PDFs, audio, text)
 * @returns ProcessedInput with content blocks and detected modalities
 */
export async function processInput(
  prompt: string,
  attachments: string[] = [],
): Promise<ProcessedInput> {
  const blocks: UserMessageContentBlock[] = [];
  const modalities = new Set<InputModality>(["text"]);

  // Text prompt first
  if (prompt.trim()) {
    blocks.push({ type: "text", text: prompt });
  }

  // Process each attachment
  for (const filePath of attachments) {
    const kind = detectKind(filePath);

    switch (kind) {
      case "image": {
        try {
          const block = await encodeImage(filePath);
          blocks.push(block);
          modalities.add("vision");
        } catch (err) {
          blocks.push({ type: "text", text: `[Image: ${path.basename(filePath)} — could not encode: ${err}]` });
        }
        break;
      }
      case "audio": {
        const block = await encodeAudio(filePath);
        blocks.push(block);
        // If Whisper transcribed successfully, modality downgrades to text (no "audio" flag)
        // Otherwise keep "audio" so the confidence router knows it's unprocessed
        if (block.type !== "text" || !block.text.startsWith("[Audio transcription:")) {
          modalities.add("audio");
        }
        break;
      }
      case "pdf": {
        const block = await encodePdf(filePath);
        blocks.push(block);
        modalities.add("document");
        break;
      }
      case "text": {
        const block = await encodeTextFile(filePath);
        blocks.push(block);
        break;
      }
    }
  }

  // Ensure at least one text block exists
  if (blocks.length === 0) {
    blocks.push({ type: "text", text: prompt });
  }

  return {
    contentBlocks: blocks,
    modalities,
    hasImages: modalities.has("vision"),
    hasAudio: modalities.has("audio"),
  };
}

/**
 * Detect modalities from an existing `UserMessageContentBlock[]` array.
 * Used when `promptContent` is pre-built (e.g. passed programmatically).
 */
export function detectModalitiesFromBlocks(
  blocks: UserMessageContentBlock[],
): Set<InputModality> {
  const modalities = new Set<InputModality>(["text"]);
  for (const block of blocks) {
    if (block.type === "image_url") modalities.add("vision");
  }
  return modalities;
}
