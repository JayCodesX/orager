#!/usr/bin/env bash
# License compliance check for orager dependencies.
#
# Blocks: GPL, LGPL, AGPL, SSPL, Commons Clause, proprietary
# Allows: MIT, Apache-2.0, ISC, BSD-*, 0BSD, Unlicense, CC0, Python-2.0
#
# Usage: bash scripts/check-licenses.sh
set -uo pipefail

PASS=0
FAIL=0
UNKNOWN=0
FAILED_PKGS=()

# Licenses that are explicitly allowed
ALLOWED_PATTERN="^(MIT|Apache-2\.0|ISC|BSD-2-Clause|BSD-3-Clause|0BSD|Unlicense|CC0-1\.0|Python-2\.0|BlueOak-1\.0\.0|MIT OR Apache-2\.0|Apache-2\.0 WITH LLVM-exception)$"

# Licenses that are explicitly blocked
BLOCKED_PATTERN="(GPL|LGPL|AGPL|SSPL|Commons Clause|proprietary|Artistic)"

echo "=== License compliance check ==="
echo ""

# Use node to read package licenses from node_modules
node - <<'NODEEOF'
const fs = require("fs");
const path = require("path");

const nodeModules = path.join(process.cwd(), "node_modules");

if (!fs.existsSync(nodeModules)) {
  console.error("node_modules not found — run bun install first");
  process.exit(1);
}

const results = [];

// Read all top-level packages (and scoped packages)
function readPackages(dir, prefix = "") {
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return; }

  for (const entry of entries) {
    if (entry.startsWith(".")) continue;

    // Handle scoped packages (@org/pkg)
    if (entry.startsWith("@")) {
      readPackages(path.join(dir, entry), entry + "/");
      continue;
    }

    const pkgPath = path.join(dir, entry, "package.json");
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (!pkg.name) continue;
      results.push({
        name: pkg.name,
        version: pkg.version ?? "unknown",
        license: pkg.license ?? "UNKNOWN",
      });
    } catch { /* skip */ }
  }
}

readPackages(nodeModules);

// Sort and deduplicate
const seen = new Set();
const unique = results
  .filter(r => { if (seen.has(r.name)) return false; seen.add(r.name); return true; })
  .sort((a, b) => a.name.localeCompare(b.name));

// Write to stdout as JSON for the shell to process
console.log(JSON.stringify(unique));
NODEEOF

# Re-run and process
node - <<'NODEEOF' 2>/dev/null | while IFS= read -r line; do
const fs = require("fs");
const path = require("path");
const nodeModules = path.join(process.cwd(), "node_modules");
const results = [];
function readPackages(dir) {
  let entries; try { entries = fs.readdirSync(dir); } catch { return; }
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    if (entry.startsWith("@")) { readPackages(path.join(dir, entry)); continue; }
    const pkgPath = path.join(dir, entry, "package.json");
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (pkg.name) results.push(pkg.name + "||" + (pkg.version||"?") + "||" + (pkg.license||"UNKNOWN"));
    } catch {}
  }
}
readPackages(nodeModules);
const seen = new Set();
results.filter(r => { const n=r.split("||")[0]; if(seen.has(n)) return false; seen.add(n); return true; })
  .sort().forEach(r => console.log(r));
NODEEOF
  NAME=$(echo "$line" | cut -d'|' -f1)
  VERSION=$(echo "$line" | cut -d'|' -f3)
  LICENSE=$(echo "$line" | cut -d'|' -f5)

  if echo "$LICENSE" | grep -qE "$BLOCKED_PATTERN"; then
    echo "  BLOCKED  $NAME@$VERSION  ($LICENSE)"
    FAIL=$((FAIL + 1))
    FAILED_PKGS+=("$NAME ($LICENSE)")
  elif echo "$LICENSE" | grep -qE "$ALLOWED_PATTERN"; then
    PASS=$((PASS + 1))
  else
    echo "  UNKNOWN  $NAME@$VERSION  ($LICENSE)"
    UNKNOWN=$((UNKNOWN + 1))
  fi
done

echo ""
echo "=== Results ==="
echo "  Allowed:  $PASS"
echo "  Unknown:  $UNKNOWN"
echo "  Blocked:  $FAIL"

if [ $FAIL -gt 0 ]; then
  echo ""
  echo "BLOCKED packages:"
  for pkg in "${FAILED_PKGS[@]}"; do
    echo "  - $pkg"
  done
  exit 1
fi

if [ $UNKNOWN -gt 0 ]; then
  echo ""
  echo "WARNING: $UNKNOWN packages have unrecognised licenses — review manually"
fi

echo ""
echo "✅ License check passed"
