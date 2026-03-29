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
 *   Bug 2 — sqlite3.wasm not embedded:
 *     wasm-sqlite.ts loads sqlite3.wasm via `createRequire().resolve()` +
 *     `readFileSync`, relying on the node_modules directory being present
 *     alongside the entry file. In a pre-bundled single JS file, Bun's
 *     virtual FS (`$bunfs`) doesn't have a node_modules directory, so the
 *     resolve fails at runtime.
 *     Fix: base64-encode sqlite3.wasm and inline it as a Buffer literal,
 *     replacing the dynamic filesystem read.
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

const arg = process.argv.find((a) => a.startsWith("--targets="));
const targets = arg
  ? arg.slice("--targets=".length).split(",").map((t) => t.trim())
  : DEFAULT_TARGETS;

const ENTRY_POINTS = [
  { src: "src/index.ts", bin: "orager" },
  { src: "src/mcp.ts",   bin: "orager-mcp" },
];

const WASM_PATH = path.join(
  root,
  "node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm",
);

const BUNDLE_DIR  = path.join(root, "dist-binary");
const BIN_DIR     = path.join(root, "bin");

// ── Helpers ──────────────────────────────────────────────────────────────────

function run(cmd, opts = {}) {
  console.log(`  $ ${cmd}`);
  const result = spawnSync(cmd, { shell: true, stdio: "inherit", cwd: root, ...opts });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

/**
 * Patch the Bun-generated bundle to fix the two known issues:
 *   1. Add the missing __promiseAll helper.
 *   2. Embed sqlite3.wasm as a Buffer literal so no filesystem access is needed.
 */
function patchBundle(bundlePath, wasmBase64) {
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

  // ── Fix 2: inline sqlite3.wasm as base64 ──────────────────────────────────
  // wasm-sqlite.ts reads the WASM binary like this in the bundle:
  //   _wasmPkgMain = _require.resolve("@sqlite.org/sqlite-wasm");
  //   _wasmBinary = readFileSync(join(dirname(_wasmPkgMain), "sqlite3.wasm"));
  //
  // Replace both lines with a single Buffer.from(base64) literal, removing
  // the filesystem dependency entirely.
  const wasmLine1 = `_wasmPkgMain = _require.resolve("@sqlite.org/sqlite-wasm");`;
  const wasmLine2Pattern = /  _wasmBinary = readFileSync\(join\(dirname\(_wasmPkgMain\)[^)]*\)[^)]*\);/;
  if (src.includes(wasmLine1) && wasmLine2Pattern.test(src)) {
    // Remove the _wasmPkgMain line and replace the readFileSync line
    src = src.replace(`  ${wasmLine1}\n`, "");
    src = src.replace(
      wasmLine2Pattern,
      `  _wasmBinary = Buffer.from("${wasmBase64}", "base64");`,
    );
    console.log("  [patch] inlined sqlite3.wasm as base64 (" + Math.round(wasmBase64.length / 1024) + " KB)");
  } else {
    console.warn("  [warn] could not find wasm readFileSync pattern — binary may fail to initialize SQLite memory");
  }

  fs.writeFileSync(bundlePath, src, "utf8");
}

// ── Main ─────────────────────────────────────────────────────────────────────

fs.mkdirSync(BUNDLE_DIR, { recursive: true });
fs.mkdirSync(BIN_DIR, { recursive: true });

// Read and base64-encode the WASM binary once
if (!fs.existsSync(WASM_PATH)) {
  console.error(`sqlite3.wasm not found at ${WASM_PATH} — run npm install first`);
  process.exit(1);
}
const wasmBase64 = fs.readFileSync(WASM_PATH).toString("base64");
console.log(`\nWASM binary: ${WASM_PATH} (${Math.round(fs.statSync(WASM_PATH).size / 1024)} KB)`);

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
  run(`bun build --target=bun --outdir=${bundleSubdir} ${entry}`);
  // Bun names the output after the entry file (e.g. index.js or mcp.js).
  const entryBasename = path.basename(entry, path.extname(entry)) + ".js";
  const bundleRaw = path.join(bundleSubdir, entryBasename);
  fs.copyFileSync(bundleRaw, bundleOut);

  // Pass 2: patch the bundle
  console.log("\n[2/3] Patching bundle...");
  patchBundle(bundleOut, wasmBase64);

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
