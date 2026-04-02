#!/usr/bin/env bash
# Run bun integration tests with per-file process isolation.
#
# Same rationale as test-bun.sh — bun runs all test files in a single OS
# process, so vi.mock() calls bleed across files. Each integration test
# file starts its own daemon/server, making isolation even more critical.
#
# JUnit XML is written to test-results/integration/ for CI test reporting.
set -uo pipefail

FAILED_FILES=()
TOTAL=0
JUNIT_DIR="test-results/integration"
mkdir -p "$JUNIT_DIR"

for f in ./tests/integration/*.test.ts; do
  [ -f "$f" ] || continue
  TOTAL=$((TOTAL + 1))
  BASENAME=$(basename "$f" .test.ts)
  XML_OUT="$JUNIT_DIR/${BASENAME}.xml"
  OUTPUT=$(bun test "$f" --reporter=junit --reporter-outfile="$XML_OUT" 2>&1)
  if [ $? -ne 0 ]; then
    FAILED_FILES+=("$f")
    echo "FAIL: $f"
    echo "$OUTPUT" | grep -E "(fail)|error:" | head -5
    echo "---"
  fi
done

PASSED=$((TOTAL - ${#FAILED_FILES[@]}))
echo ""
echo "=== Integration: $PASSED/$TOTAL files passed, ${#FAILED_FILES[@]} failed ==="

if [ ${#FAILED_FILES[@]} -gt 0 ]; then
  echo "Failed files:"
  for f in "${FAILED_FILES[@]}"; do
    echo "  $f"
  done
  exit 1
fi
