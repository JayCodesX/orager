#!/usr/bin/env bash
# Run bun tests with per-file process isolation.
#
# Bun runs all test files in a single OS process, so vi.mock() calls are
# process-wide and bleed across files. Running each file in its own process
# guarantees clean mock isolation at the cost of ~200ms startup per file.
#
# JUnit XML is written to test-results/unit/ for CI test reporting.
set -uo pipefail

FAILED_FILES=()
TOTAL=0
JUNIT_DIR="test-results/unit"
mkdir -p "$JUNIT_DIR"

for f in ./tests/*.test.ts; do
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
echo "=== $PASSED/$TOTAL files passed, ${#FAILED_FILES[@]} failed ==="

if [ ${#FAILED_FILES[@]} -gt 0 ]; then
  echo "Failed files:"
  for f in "${FAILED_FILES[@]}"; do
    echo "  $f"
  done
  exit 1
fi
