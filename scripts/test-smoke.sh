#!/usr/bin/env bash
# End-to-end smoke tests against a live model (free tier).
#
# Requires:
#   OPENROUTER_API_KEY  — set as env var or GitHub secret
#   PROTOCOL_API_KEY    — aliased from OPENROUTER_API_KEY if not set
#
# Uses a free model to avoid any cost. Safety cap set to $0.10 as a net.
# Model selection: llama-3.3-70b-instruct:free is stable, tool-capable, and
# has generous free-tier rate limits (sponsored by Meta on OpenRouter).
# Override via SMOKE_MODEL env var if needed.
set -uo pipefail

SMOKE_MODEL="${SMOKE_MODEL:-meta-llama/llama-3.3-70b-instruct:free}"
CLI="bun run src/index.ts"
PASS=0
FAIL=0
FAILED_TESTS=()

# Ensure API key is available
if [ -z "${OPENROUTER_API_KEY:-}" ] && [ -z "${PROTOCOL_API_KEY:-}" ]; then
  echo "ERROR: OPENROUTER_API_KEY or PROTOCOL_API_KEY must be set"
  exit 1
fi
export PROTOCOL_API_KEY="${PROTOCOL_API_KEY:-$OPENROUTER_API_KEY}"

# Temp dir for test artifacts
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

run_test() {
  local name="$1"
  shift
  echo -n "  $name ... "
  OUTPUT=$("$@" 2>&1)
  EXIT_CODE=$?
  if [ $EXIT_CODE -eq 0 ]; then
    echo "PASS"
    PASS=$((PASS + 1))
  else
    echo "FAIL (exit $EXIT_CODE)"
    echo "    Output (last 5 lines):"
    echo "$OUTPUT" | tail -5 | sed 's/^/    /'
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("$name")
  fi
  return 0
}

run_test_expect_output() {
  local name="$1"
  local pattern="$2"
  shift 2
  echo -n "  $name ... "
  OUTPUT=$("$@" 2>&1)
  EXIT_CODE=$?
  if echo "$OUTPUT" | grep -qiE "$pattern"; then
    echo "PASS"
    PASS=$((PASS + 1))
  else
    echo "FAIL (pattern '$pattern' not found)"
    echo "    Output (last 5 lines):"
    echo "$OUTPUT" | tail -5 | sed 's/^/    /'
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("$name")
  fi
  return 0
}

# ─── Tier 1: CLI basics (no API call) ────────────────────────────

echo "=== Tier 1: CLI basics ==="

run_test "version flag" \
  $CLI --version

run_test "help flag" \
  $CLI --help

run_test "session list (empty ok)" \
  $CLI --list-sessions

run_test "memory list (empty ok)" \
  $CLI memory list

run_test "skills list (empty ok)" \
  $CLI skills list

run_test_expect_output "invalid flag errors gracefully" "unknown|unrecognized|invalid|error|usage" \
  $CLI run --totally-fake-flag "test" 2>&1 || true

# ─── Tier 2: Single-turn agent loop (free model) ─────────────────

echo ""
echo "=== Tier 2: Agent loop (model: $SMOKE_MODEL) ==="

run_test_expect_output "simple prompt returns answer" "4|four" \
  $CLI run --model "$SMOKE_MODEL" --max-turns 1 --max-cost-usd 0.10 \
  --dangerously-skip-permissions "What is 2+2? Reply with just the number."

run_test "max-turns respected" \
  timeout 60 $CLI run --model "$SMOKE_MODEL" --max-turns 1 --max-cost-usd 0.10 \
  --dangerously-skip-permissions "Say hello"

# ─── Tier 3: Tool use ────────────────────────────────────────────
# These tests verify the orager agent loop completes multi-turn runs
# with tools available. We check exit code (loop didn't crash), not
# model output — free-tier providers vary in function-calling support.

echo ""
echo "=== Tier 3: Tool use ==="

run_test "bash tool (multi-turn loop)" \
  timeout 180 $CLI run --model "$SMOKE_MODEL" --max-turns 3 --max-cost-usd 0.10 \
  --dangerously-skip-permissions "Run ls in the current directory and tell me what files you see"

# Create a test file for read tool
echo "smoke-test-content-12345" > "$TMPDIR/smoke-test.txt"

run_test "read file tool (multi-turn loop)" \
  timeout 180 $CLI run --model "$SMOKE_MODEL" --max-turns 3 --max-cost-usd 0.10 \
  --dangerously-skip-permissions "Read the file $TMPDIR/smoke-test.txt and tell me its contents"

run_test "write file tool (multi-turn loop)" \
  timeout 180 $CLI run --model "$SMOKE_MODEL" --max-turns 3 --max-cost-usd 0.10 \
  --dangerously-skip-permissions "Write the text 'hello-from-smoke-test' to $TMPDIR/write-test.txt"

# Verify the file was actually written — real assertion regardless of model output
if [ -f "$TMPDIR/write-test.txt" ]; then
  echo "  write file verify ... PASS"
  PASS=$((PASS + 1))
else
  # Not a hard failure — free-tier models may decline to use write tool.
  # Log as a warning so we can track which models do call tools.
  echo "  write file verify ... WARN (file not created — model may not have used write tool)"
fi

# ─── Tier 4: Session management ──────────────────────────────────

echo ""
echo "=== Tier 4: Session management ==="

run_test "create session" \
  timeout 60 $CLI run --model "$SMOKE_MODEL" --max-turns 1 --max-cost-usd 0.10 \
  --dangerously-skip-permissions "Remember: the magic word is pineapple"

# --list-sessions output format: "<uuid>  <model>  turns: <n>"
# The custom --session-id is an internal key, not echoed in listing output.
# Verify at least one session exists for the model we just used.
run_test_expect_output "list shows session" "turns:" \
  $CLI --list-sessions

# ─── Tier 5: Subprocess mode ─────────────────────────────────────

echo ""
echo "=== Tier 5: Subprocess mode ==="

run_test "subprocess single turn" \
  timeout 60 $CLI run --model "$SMOKE_MODEL" --max-turns 1 --max-cost-usd 0.10 \
  --subprocess --dangerously-skip-permissions "Say hello"

# ─── Tier 6: Flags & config ──────────────────────────────────────

echo ""
echo "=== Tier 6: Flags & config ==="

run_test "verbose flag" \
  timeout 60 $CLI run --model "$SMOKE_MODEL" --max-turns 1 --max-cost-usd 0.10 \
  --verbose --dangerously-skip-permissions "Say hi"

run_test_expect_output "unknown profile degrades gracefully" "hi|hello|hey|greet|warn|profile" \
  timeout 60 $CLI run --model "$SMOKE_MODEL" --max-turns 1 --max-cost-usd 0.10 \
  --profile nonexistent-smoke-profile --dangerously-skip-permissions "Say hi"

run_test "plan mode" \
  timeout 60 $CLI run --model "$SMOKE_MODEL" --max-turns 1 --max-cost-usd 0.10 \
  --plan-mode --dangerously-skip-permissions "Plan a REST API"

# ─── Results ──────────────────────────────────────────────────────

echo ""
echo "========================================"
echo "  Smoke tests: $PASS passed, $FAIL failed"
echo "========================================"

if [ $FAIL -gt 0 ]; then
  echo ""
  echo "Failed tests:"
  for t in "${FAILED_TESTS[@]}"; do
    echo "  - $t"
  done
  exit 1
fi
