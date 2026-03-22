#!/usr/bin/env bash
#
# xdb CLI End-to-End Test Script — core functionality
#
# Prerequisites:
#   - xdb installed: npm run build && npm link
#   - Embed provider configured (xdb's own config takes priority over pai fallback):
#       xdb config embed --set-provider <provider> --set-model <model>
#     Or via pai fallback:
#       pai model default --embed-provider <provider> --embed-model <model>
#
# Usage: bash test-e2e.sh
#
set -uo pipefail

source "$(dirname "$0")/scripts/e2e-lib.sh"

XDB="xdb"
TEST_COL="e2e-test"

on_cleanup() {
  $XDB col rm "$TEST_COL" >/dev/null 2>&1 || true
}

setup_e2e

# ── Pre-flight ────────────────────────────────────────────────
section "Pre-flight"

require_bin $XDB "run npm run build"

# Resolve embed config: prefer xdb's own config, fallback to pai
XDB_CFG_JSON=$($XDB config --json 2>/dev/null)
EMBED_PROVIDER=$(echo "$XDB_CFG_JSON" | json_path_from_stdin "embed.provider")
EMBED_MODEL=$(echo "$XDB_CFG_JSON" | json_path_from_stdin "embed.model")

if [[ -n "$EMBED_PROVIDER" && -n "$EMBED_MODEL" ]]; then
  pass "Embed (xdb): $EMBED_PROVIDER / $EMBED_MODEL"
else
  # Fallback: try pai
  if command -v pai &>/dev/null; then
    PAI_JSON=$(pai model default --json 2>/dev/null)
    EMBED_PROVIDER=$(echo "$PAI_JSON" | json_field_from_stdin "defaultEmbedProvider")
    EMBED_MODEL=$(echo "$PAI_JSON" | json_field_from_stdin "defaultEmbedModel")
  fi
  if [[ -n "$EMBED_PROVIDER" && -n "$EMBED_MODEL" ]]; then
    pass "Embed (pai fallback): $EMBED_PROVIDER / $EMBED_MODEL"
  else
    fail "No embed provider/model — run: xdb config embed --set-provider <p> && xdb config embed --set-model <m>"; exit 1
  fi
fi

# ══════════════════════════════════════════════════════════════
# 1. policy list
# ══════════════════════════════════════════════════════════════
section "1. policy list"
run_cmd $XDB policy list
assert_exit0
assert_contains "hybrid"

# ══════════════════════════════════════════════════════════════
# 2. col init
# ══════════════════════════════════════════════════════════════
section "2. col init"
run_cmd $XDB col init "$TEST_COL" --policy hybrid
assert_exit0

# ══════════════════════════════════════════════════════════════
# 3. col list
# ══════════════════════════════════════════════════════════════
section "3. col list"
run_cmd $XDB col list
assert_exit0
assert_contains "e2e-test"

# ══════════════════════════════════════════════════════════════
# 4. col info
# ══════════════════════════════════════════════════════════════
section "4. col info"
run_cmd $XDB col info "$TEST_COL"
assert_exit0
assert_contains "hybrid"

# ══════════════════════════════════════════════════════════════
# 5. embed — single text
# ══════════════════════════════════════════════════════════════
section "5. embed — single text"
run_cmd $XDB embed "hello world"
assert_exit0
assert_nonempty
assert_contains "^\["

# ══════════════════════════════════════════════════════════════
# 6. embed --json
# ══════════════════════════════════════════════════════════════
section "6. embed --json"
run_cmd $XDB embed "test embedding" --json
assert_exit0
assert_json_field "$OUT" "embedding"
assert_json_field "$OUT" "model"

# ══════════════════════════════════════════════════════════════
# 7. put — single record
# ══════════════════════════════════════════════════════════════
section "7. put — single record"
run_cmd $XDB put "$TEST_COL" '{"id":"doc1","content":"How to use tar for file compression"}'
assert_exit0

# ══════════════════════════════════════════════════════════════
# 8. put — second record
# ══════════════════════════════════════════════════════════════
section "8. put — second record"
run_cmd $XDB put "$TEST_COL" '{"id":"doc2","content":"Network debugging with curl and wget"}'
assert_exit0

# ══════════════════════════════════════════════════════════════
# 9. find --similar
# ══════════════════════════════════════════════════════════════
section "9. find --similar"
run_cmd $XDB find "$TEST_COL" "compress archive" --similar
assert_exit0
assert_nonempty
assert_contains "tar\|compress"

# ══════════════════════════════════════════════════════════════
# 10. find --match
# ══════════════════════════════════════════════════════════════
section "10. find --match"
run_cmd $XDB find "$TEST_COL" "curl" --match
assert_exit0
assert_contains "curl\|network"

# ══════════════════════════════════════════════════════════════
# 11. put --batch (stdin JSONL)
# ══════════════════════════════════════════════════════════════
section "11. put --batch"
printf '{"id":"doc3","content":"Git branching and merging strategies"}\n{"id":"doc4","content":"Docker container lifecycle management"}\n' \
  | $XDB put "$TEST_COL" --batch --json >"$TD/out_batch.txt" 2>/dev/null
EC=$?; OUT="$TD/out_batch.txt"
assert_exit0
assert_contains '"inserted"'

# ══════════════════════════════════════════════════════════════
# 12. col rm
# ══════════════════════════════════════════════════════════════
section "12. col rm"
run_cmd $XDB col rm "$TEST_COL"
assert_exit0
run_cmd $XDB col list
assert_not_contains "e2e-test"

summary_and_exit
