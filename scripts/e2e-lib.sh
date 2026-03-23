#!/usr/bin/env bash
# e2e-lib.sh — shared helpers for all repo e2e test scripts
# Source of truth: pai/scripts/e2e-lib.sh
# Sync to other repos: cp pai/scripts/e2e-lib.sh <repo>/scripts/e2e-lib.sh
#
# Usage in test-e2e.sh:
#   source "$(dirname "$0")/scripts/e2e-lib.sh"
#   setup_e2e                              # initializes TD, PASS, FAIL, trap
#   on_cleanup() { … }                     # optional: define before setup_e2e for custom cleanup
#   section "1. my test"
#   require_cmd mybin "hint to install"    # pre-flight: binary must exist or exit 1
#   run_cmd foo bar                        # runs cmd, sets $OUT and $EC
#   assert_exit0
#   assert_exit <N>
#   assert_nonzero_exit
#   assert_nonempty [$file]
#   assert_empty [$file]
#   assert_stderr_empty                    # checks $ERR after run_cmd_with_stderr
#   assert_contains "pattern" [$file]
#   assert_not_contains "pattern" [$file]
#   assert_line_count_gte <N> [$file]      # line count ≥ N (for NDJSON output)
#   assert_line_count_eq <N> [$file]       # line count = N
#   assert_file_exists "$path" "label"
#   assert_file_missing "$path" "label"
#   assert_json_array [$file]
#   assert_json_field [$file] "fieldName"
#   assert_json_array_length_lte [$file] N
#   assert_first_stderr_line_is_json       # checks first line of $ERR is valid JSON
#   json_field_from_stdin "field"          # reads stdin JSON, prints field value
#   json_path_from_stdin "a.b.c"           # reads stdin JSON, prints value at dot-separated path
#   summary_and_exit

# ── Output helpers ────────────────────────────────────────────
pass() { printf "\033[32m  ✓ %s\033[0m\n" "$*"; PASS=$((PASS+1)); }
fail() { printf "\033[31m  ✗ %s\033[0m\n" "$*"; FAIL=$((FAIL+1)); }
section() { echo ""; printf "\033[33m━━ %s ━━\033[0m\n" "$*"; }

# Convert bash path to node-readable form (handles Windows/MSYS2)
np() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else echo "$1"; fi; }

# ── Setup ─────────────────────────────────────────────────────
setup_e2e() {
  PASS=0; FAIL=0
  # Store temp files under the script's own directory (accessible to both bash and Node.js)
  local _script_dir
  _script_dir="$(cd "$(dirname "${BASH_SOURCE[1]}")" && pwd)"
  TD="$_script_dir/tmp/e2e-$$"
  mkdir -p "$TD"
  OUT=""   # populated by run_cmd
  EC=0     # populated by run_cmd

  _cleanup() {
    # call user-defined hook if present
    if declare -f on_cleanup >/dev/null 2>&1; then on_cleanup; fi
    rm -rf "$TD"
  }
  trap _cleanup EXIT
}

# ── Command runner ────────────────────────────────────────────
# run_cmd <cmd> [args…]
#   Runs command, captures stdout to $OUT (a temp file path), exit code to $EC.
#   stderr is suppressed. Use run_cmd_with_stderr to capture both.
_OUT_IDX=0
run_cmd() {
  _OUT_IDX=$((_OUT_IDX+1))
  OUT="$TD/out_${_OUT_IDX}.txt"
  "$@" >"$OUT" 2>/dev/null
  EC=$?
}

run_cmd_with_stderr() {
  _OUT_IDX=$((_OUT_IDX+1))
  OUT="$TD/out_${_OUT_IDX}.txt"
  ERR="$TD/err_${_OUT_IDX}.txt"
  "$@" >"$OUT" 2>"$ERR"
  EC=$?
}

# ── Assertions ────────────────────────────────────────────────
assert_exit0() {
  [[ $EC -eq 0 ]] && pass "exit=0" || fail "exit=$EC (expected 0)"
}

assert_exit() {
  local expected=$1
  [[ $EC -eq $expected ]] && pass "exit=$expected" || fail "exit=$EC (expected $expected)"
}

assert_nonzero_exit() {
  [[ $EC -ne 0 ]] && pass "non-zero exit ($EC)" || fail "expected non-zero exit, got 0"
}

assert_nonempty() {
  local file=${1:-$OUT}
  [[ -s "$file" ]] && pass "output non-empty" || fail "output empty"
}

assert_contains() {
  local pattern=$1 file=${2:-$OUT}
  grep -qi "$pattern" "$file" \
    && pass "contains '$pattern'" \
    || fail "missing '$pattern'"
}

assert_not_contains() {
  local pattern=$1 file=${2:-$OUT}
  grep -qi "$pattern" "$file" \
    && fail "should not contain '$pattern'" \
    || pass "does not contain '$pattern'"
}

assert_file_exists() {
  local path=$1 label=${2:-"$1"}
  if node -e "process.exit(require('fs').existsSync(process.argv[1])?0:1)" "$(np "$path")" 2>/dev/null; then
    pass "$label exists"
  else
    fail "$label missing"
  fi
}

assert_file_missing() {
  local path=$1 label=${2:-"$1"}
  if node -e "process.exit(require('fs').existsSync(process.argv[1])?1:0)" "$(np "$path")" 2>/dev/null; then
    pass "$label absent"
  else
    fail "$label should not exist"
  fi
}

assert_json_array() {
  local file=${1:-$OUT}
  if node -e "const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); if(!Array.isArray(d)) throw 0" "$(np "$file")" 2>/dev/null; then
    pass "valid JSON array"
  else
    fail "invalid JSON or not an array"
  fi
}

assert_json_field() {
  local file=${1:-$OUT} field=$2
  if node -e "const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); if(d['$field']===undefined && d['$field']!==0 && d['$field']!==false) throw 0" "$(np "$file")" 2>/dev/null; then
    pass "JSON has field '$field'"
  else
    fail "JSON missing field '$field'"
  fi
}

assert_json_array_length_lte() {
  local file=${1:-$OUT} max=$2
  local count
  count=$(node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).length))" "$(np "$file")" 2>/dev/null)
  [[ "$count" -le "$max" ]] \
    && pass "array length $count ≤ $max" \
    || fail "array length $count exceeds $max"
}

assert_empty() {
  local file=${1:-$OUT}
  [[ ! -s "$file" ]] && pass "output empty" || fail "expected empty output"
}

assert_stderr_empty() {
  [[ ! -s "$ERR" ]] && pass "stderr empty" || fail "stderr not empty: $(cat "$ERR")"
}

assert_line_count_gte() {
  local min=$1 file=${2:-$OUT}
  local count
  count=$(wc -l <"$file" | tr -d ' ')
  [[ "$count" -ge "$min" ]] \
    && pass "line count $count ≥ $min" \
    || fail "expected ≥$min lines, got $count"
}

assert_line_count_eq() {
  local expected=$1 file=${2:-$OUT}
  local count
  count=$(wc -l <"$file" | tr -d ' ')
  [[ "$count" -eq "$expected" ]] \
    && pass "line count = $expected" \
    || fail "expected $expected lines, got $count"
}

# assert_first_stderr_line_is_json
#   Checks that the first line of $ERR is valid JSON.
assert_first_stderr_line_is_json() {
  local line
  line=$(head -1 "$ERR")
  if echo "$line" | node -e "JSON.parse(require('fs').readFileSync(0,'utf8'))" 2>/dev/null; then
    pass "first stderr line is valid JSON"
  else
    fail "first stderr line not valid JSON: $line"
  fi
}

# require_cmd <binary> <fix-hint>
#   Pre-flight check: binary must exist on PATH, else fail + exit 1.
require_cmd() {
  local bin=$1 hint=$2
  if command -v "$bin" >/dev/null 2>&1; then
    pass "$bin found"
  else
    fail "$bin not found — $hint"; exit 1
  fi
}

# require_bin <binary> <fix-hint>
#   Pre-flight check: run `binary --version`, fail + exit 1 if it errors.
require_bin() {
  local bin=$1 hint=$2
  if "$bin" --version >/dev/null 2>&1; then
    pass "$bin binary OK"
  else
    fail "$bin binary broken — $hint"; exit 1
  fi
}

# json_field_from_stdin <field>
#   Reads JSON from stdin, prints the value of <field> (empty string if missing).
#   Usage: VALUE=$(some_cmd | json_field_from_stdin "myField")
json_field_from_stdin() {
  local field=$1
  node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(0,'utf8'))['$field'] ?? '')" 2>/dev/null
}

# json_path_from_stdin <path>
#   Reads JSON from stdin, prints the value at a dot-separated path (empty string if missing).
#   Usage: VALUE=$(some_cmd | json_path_from_stdin "embed.provider")
json_path_from_stdin() {
  local path=$1
  node -e "
    const d = JSON.parse(require('fs').readFileSync(0,'utf8'));
    const val = '$path'.split('.').reduce((o,k) => o?.[k], d);
    process.stdout.write(val ?? '');
  " 2>/dev/null
}

# ── Async wait helper ────────────────────────────────────────
# wait_for <desc> <timeout_secs> <bash_check_expr> [diag_cmd...]
#   Polls every 1s until <bash_check_expr> is true or timeout.
#   On timeout: dumps diag output (remaining args as a command), then calls fail().
#   On success: calls pass().
#
# Usage:
#   wait_for "inbox has event" 5 \
#     'thread peek --thread "$AGENT_DIR/inbox" --last-event-id 0 2>/dev/null | grep -q .'
#
#   wait_for "reply in thread" 60 \
#     'thread peek --thread "$THREAD_PATH" --last-event-id 0 2>/dev/null | grep -q "\"source\":\"self\""' \
#     -- "tail -20 $NOTIFIER_LOG" "tail -20 $AGENT_LOG"
#
# Diag commands are separated by '--' and each is a quoted string.
wait_for() {
  local desc=$1 timeout=$2 check=$3
  shift 3

  # collect diag commands (everything after optional '--')
  local diag_cmds=()
  local in_diag=0
  for arg in "$@"; do
    if [[ "$arg" == "--" ]]; then in_diag=1; continue; fi
    [[ $in_diag -eq 1 ]] && diag_cmds+=("$arg")
  done

  local i
  for i in $(seq 1 "$timeout"); do
    sleep 1
    if eval "$check" 2>/dev/null; then
      pass "$desc (${i}s)"
      return 0
    fi
  done

  # timeout — dump diagnostics
  printf "\033[33m  ⚠ DIAG for: %s\033[0m\n" "$desc"
  for cmd in "${diag_cmds[@]}"; do
    printf "\033[33m  $ %s\033[0m\n" "$cmd"
    eval "$cmd" 2>&1 | sed 's/^/    /' || true
  done

  fail "$desc (timeout ${timeout}s)"
  return 1
}

# ── Summary ───────────────────────────────────────────────────
summary_and_exit() {
  section "Results"
  echo ""
  local total=$((PASS + FAIL))
  printf "  Passed: \033[32m%d\033[0m\n" "$PASS"
  printf "  Failed: %s\n" "$([[ $FAIL -gt 0 ]] && printf "\033[31m%d\033[0m" "$FAIL" || echo 0)"
  echo "  Total:  $total"
  echo ""
  if [[ $FAIL -eq 0 ]]; then
    printf "\033[32mAll tests passed!\033[0m\n"
    exit 0
  else
    printf "\033[31mSome tests failed.\033[0m\n"
    exit 1
  fi
}
