#!/usr/bin/env node
/**
 * scripts/build-binary.mjs
 *
 * Builds standalone orager binaries using Bun's compile mode.
 *
 * Two-pass approach needed due to Bun 1.3.x bugs:
 *
 *   Bug 1 — __promiseAll not defined:
 *     Bun's bundler replaces `Promise.all([initA(), initB()])` at the module-
 *     init level with `__promiseAll([initA(), initB()])` as a parallelism
 *     optimisation, but the helper function is not emitted into the bundle.
 *     Fix: inject `var __promiseAll = p => Promise.all(p);` at the top of the
 *     pre-bundled JS before compiling to a binary.
 *
 * Usage:
 *   node scripts/build-binary.mjs [--targets darwin-arm64,darwin-x64,linux-x64]
 *   bun run build:binary
 */

import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dir, "..");

// ── Config ───────────────────────────────────────────────────────────────────

const DEFAULT_TARGETS = ["bun-darwin-arm64", "bun-darwin-x64", "bun-linux-x64"];

// Packages that must never be bundled into the binary:
//   - playwright / playwright-core — devDep with native electron/chromium-bidi
//     deps that can't be resolved at bundle time
//   - @huggingface/transformers — optional dep, loaded via dynamic import at
//     runtime with graceful fallback when absent
const EXTERNAL_PACKAGES = [
  "playwright",
  "playwright-core",
  "@huggingface/transformers",
];

const arg = process.argv.find((a) => a.startsWith("--targets="));
const targets = arg
  ? arg.slice("--targets=".length).split(",").map((t) => t.trim())
  : DEFAULT_TARGETS;

const ENTRY_POINTS = [
  { src: "src/index.ts", bin: "orager" },
  { src: "src/mcp.ts",   bin: "orager-mcp" },
];

const BUNDLE_DIR  = path.join(root, "dist-binary");
const BIN_DIR     = path.join(root, "bin");

// ── Pre-flight: ensure bun is available ──────────────────────────────────────

const bunCheck = spawnSync("bun", ["--version"], { shell: true, stdio: "pipe" });
if (bunCheck.status !== 0) {
  console.error("Error: 'bun' not found in PATH. Install Bun from https://bun.sh and try again.");
  process.exit(1);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function run(cmd, opts = {}) {
  console.log(`  $ ${cmd}`);
  const result = spawnSync(cmd, { shell: true, stdio: "inherit", cwd: root, ...opts });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

/**
 * Patch the Bun-generated bundle to fix known issues:
 *   1. Add the missing __promiseAll helper.
 */
function patchBundle(bundlePath) {
  let src = fs.readFileSync(bundlePath, "utf8");

  // ── Fix 1: inject __promiseAll helper ─────────────────────────────────────
  // Bun generates `await __promiseAll([...])` for parallel module init but
  // omits the helper definition. Insert it right after the `// @bun` marker
  // (first line) so it is defined before any module initialisation runs.
  if (src.includes("__promiseAll") && !src.includes("var __promiseAll")) {
    src = src.replace(
      /^(\/\/\s*@bun\n)/m,
      '$1var __promiseAll = (p) => Promise.all(p);\n',
    );
    console.log("  [patch] injected __promiseAll helper");
  }

  fs.writeFileSync(bundlePath, src, "utf8");
}

// ── Main ─────────────────────────────────────────────────────────────────────

fs.mkdirSync(BUNDLE_DIR, { recursive: true });
fs.mkdirSync(BIN_DIR, { recursive: true });

for (const { src: entry, bin: binName } of ENTRY_POINTS) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`Building ${binName} from ${entry}`);
  console.log("─".repeat(60));

  const bundleOut = path.join(BUNDLE_DIR, `${binName}.js`);

  // Pass 1: bundle to JS
  console.log("\n[1/3] Bundling...");
  // Bun requires --outdir when the bundle may emit multiple files (assets).
  // We use a per-binary subdirectory then rename the entry JS to the expected path.
  const bundleSubdir = path.join(BUNDLE_DIR, binName);
  fs.mkdirSync(bundleSubdir, { recursive: true });
  const externals = EXTERNAL_PACKAGES.map((p) => `--external=${p}`).join(" ");
  run(`bun build --target=bun --outdir=${bundleSubdir} ${externals} ${entry}`);
  // Bun names the output after the entry file (e.g. index.js or mcp.js).
  const entryBasename = path.basename(entry, path.extname(entry)) + ".js";
  const bundleRaw = path.join(bundleSubdir, entryBasename);
  fs.copyFileSync(bundleRaw, bundleOut);

  // Pass 2: patch the bundle
  console.log("\n[2/3] Patching bundle...");
  patchBundle(bundleOut);

  // Pass 3: compile per target
  console.log("\n[3/3] Compiling binaries...");
  for (const target of targets) {
    const suffix = target.replace(/^bun-/, ""); // "darwin-arm64", "linux-x64", …
    const outfile = path.join(BIN_DIR, `${binName}-${suffix}`);
    run(`bun build --compile --target=${target} --outfile=${outfile} ${bundleOut}`);
    const sizeBytes = fs.statSync(outfile).size;
    console.log(`  → ${outfile}  (${Math.round(sizeBytes / 1024 / 1024)} MB)`);
  }
}

console.log(`\n✓ Done. Binaries written to: ${BIN_DIR}/`);
