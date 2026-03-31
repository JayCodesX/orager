#!/usr/bin/env bash
# Cross-repo test lockfile — prevents multiple test suites from running
# simultaneously. Uses mkdir as the atomic lock primitive.
#
# Usage:
#   bash scripts/test-lock.sh acquire   # before tests
#   bash scripts/test-lock.sh release   # after tests

set -euo pipefail

LOCK_DIR="${ORAGER_TEST_LOCK_DIR:-/tmp/orager-test.lock}"
MAX_WAIT_SEC=300       # 5 minutes max wait
STALE_SEC=600          # 10 minutes = stale lock
POLL_SEC=3

action="${1:-}"

die() { echo "[test-lock] ERROR: $1" >&2; exit 1; }

is_pid_alive() {
  kill -0 "$1" 2>/dev/null
}

read_lock_pid() {
  cat "$LOCK_DIR/pid" 2>/dev/null || echo ""
}

read_lock_time() {
  cat "$LOCK_DIR/time" 2>/dev/null || echo "0"
}

is_stale() {
  local lock_time
  lock_time="$(read_lock_time)"
  if [ "$lock_time" = "0" ]; then return 0; fi
  local now
  now="$(date +%s)"
  local age=$(( now - lock_time ))
  [ "$age" -ge "$STALE_SEC" ]
}

do_acquire() {
  local waited=0

  while true; do
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      echo "$$" > "$LOCK_DIR/pid"
      date +%s > "$LOCK_DIR/time"
      echo "[test-lock] acquired (PID $$)"
      return 0
    fi

    # Lock exists — check if holder is alive
    local holder
    holder="$(read_lock_pid)"

    if [ -n "$holder" ] && ! is_pid_alive "$holder"; then
      echo "[test-lock] stale lock from dead PID $holder — reclaiming"
      rm -rf "$LOCK_DIR"
      continue
    fi

    if is_stale; then
      echo "[test-lock] lock held >$STALE_SEC seconds — force-reclaiming"
      rm -rf "$LOCK_DIR"
      continue
    fi

    if [ "$waited" -ge "$MAX_WAIT_SEC" ]; then
      die "timed out after ${MAX_WAIT_SEC}s waiting for test lock (held by PID ${holder:-unknown})"
    fi

    echo "[test-lock] waiting for PID ${holder:-unknown} to finish (${waited}s/${MAX_WAIT_SEC}s)..."
    sleep "$POLL_SEC"
    waited=$(( waited + POLL_SEC ))
  done
}

do_release() {
  if [ -d "$LOCK_DIR" ]; then
    local holder
    holder="$(read_lock_pid)"
    # Only release if we own it
    if [ "$holder" = "$$" ] || [ -z "$holder" ]; then
      rm -rf "$LOCK_DIR"
      echo "[test-lock] released"
    else
      # Parent shell PID may differ — release anyway if the holder is dead
      if ! is_pid_alive "$holder"; then
        rm -rf "$LOCK_DIR"
        echo "[test-lock] released (stale)"
      else
        echo "[test-lock] lock held by PID $holder, not releasing"
      fi
    fi
  fi
}

case "$action" in
  acquire) do_acquire ;;
  release) do_release ;;
  *) die "usage: $0 {acquire|release}" ;;
esac
