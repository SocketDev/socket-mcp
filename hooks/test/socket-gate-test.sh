#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
HOOK="$ROOT_DIR/hooks/socket-gate.sh"
FIXTURES_DIR="$ROOT_DIR/hooks/test/fixtures"

fail () {
  echo "FAIL: $*" >&2
  exit 1
}

assert_eq () {
  local expected="$1"
  local actual="$2"
  local msg="${3:-}"
  if [[ "$expected" != "$actual" ]]; then
    fail "${msg} expected='$expected' actual='$actual'"
  fi
}

assert_contains () {
  local haystack="$1"
  local needle="$2"
  local msg="${3:-}"
  if ! printf '%s' "$haystack" | grep -qF "$needle"; then
    fail "${msg} missing='$needle'"
  fi
}

run_hook () {
  local cmd="$1"
  local fixture="$2"
  local api_key="${3:-test-key}"

  local input
  input="$(jq -n --arg cmd "$cmd" '{tool_name:"Bash",tool_input:{command:$cmd}}')"

  local out err
  out="$(mktemp)"
  err="$(mktemp)"

  set +e
  SOCKET_API_KEY="$api_key" SOCKET_GATE_TEST_RESPONSE="$fixture" "$HOOK" >"$out" 2>"$err" <<<"$input"
  local status=$?
  set -e

  printf '%s\n' "$status"
  printf '%s\n' "$out"
  printf '%s\n' "$err"

  rm -f "$out" "$err"
}

for fixture in allow.ndjson warn.ndjson block.ndjson pip-multi.ndjson; do
  if [[ ! -f "$FIXTURES_DIR/$fixture" ]]; then
    fail "Missing fixture: $FIXTURES_DIR/$fixture"
  fi
done

echo "1) pass-through: npm ci"
{
  input="$(jq -n '{tool_name:"Bash",tool_input:{command:"npm ci"}}')"
  set +e
  stdout="$("$HOOK" <<<"$input" 2>/dev/null)"
  status=$?
  set -e
  assert_eq "0" "$status" "npm ci should exit 0"
  assert_eq "" "$(printf '%s' "$stdout")" "npm ci should produce no stdout"
}

echo "2) pass-through: npm install (no args)"
{
  input="$(jq -n '{tool_name:"Bash",tool_input:{command:"npm install"}}')"
  set +e
  stdout="$("$HOOK" <<<"$input" 2>/dev/null)"
  status=$?
  set -e
  assert_eq "0" "$status" "npm install (no args) should exit 0"
  assert_eq "" "$(printf '%s' "$stdout")" "npm install (no args) should produce no stdout"
}

echo "3) allow: npm install express"
{
  status="$(run_hook "npm install express" "$FIXTURES_DIR/allow.ndjson" | sed -n '1p')"
  assert_eq "0" "$status" "allow should exit 0"
}

echo "4) warn: npm install colors"
{
  tmp="$(mktemp)"
  err="$(mktemp)"
  input="$(jq -n '{tool_name:"Bash",tool_input:{command:"npm install colors"}}')"
  set +e
  SOCKET_API_KEY="test-key" SOCKET_GATE_TEST_RESPONSE="$FIXTURES_DIR/warn.ndjson" "$HOOK" >"$tmp" 2>"$err" <<<"$input"
  status=$?
  set -e
  out="$(cat "$tmp")"
  assert_eq "0" "$status" "warn should exit 0"
  assert_contains "$out" "Socket WARNING" "warn context"
  rm -f "$tmp" "$err"
}

echo "5) block: npm install malicious-pkg"
{
  tmp="$(mktemp)"
  err="$(mktemp)"
  input="$(jq -n '{tool_name:"Bash",tool_input:{command:"npm install malicious-pkg"}}')"
  set +e
  SOCKET_API_KEY="test-key" SOCKET_GATE_TEST_RESPONSE="$FIXTURES_DIR/block.ndjson" "$HOOK" >"$tmp" 2>"$err" <<<"$input"
  status=$?
  set -e
  errtxt="$(cat "$err")"
  assert_eq "2" "$status" "block should exit 2"
  assert_contains "$errtxt" "BLOCKED" "block stderr"
  rm -f "$tmp" "$err"
}

echo "6) missing API key fails open with context"
{
  tmp="$(mktemp)"
  err="$(mktemp)"
  input="$(jq -n '{tool_name:"Bash",tool_input:{command:"npm install express"}}')"
  set +e
  SOCKET_API_KEY="" SOCKET_GATE_TEST_RESPONSE="$FIXTURES_DIR/allow.ndjson" "$HOOK" >"$tmp" 2>"$err" <<<"$input"
  status=$?
  set -e
  out="$(cat "$tmp")"
  errtxt="$(cat "$err")"
  assert_eq "0" "$status" "missing key should exit 0"
  assert_contains "$errtxt" "SOCKET_API_KEY is not set" "missing key stderr"
  assert_contains "$out" "skipping package security check" "missing key context"
  rm -f "$tmp" "$err"
}

echo "7) chained command extracts install portion"
{
  tmp="$(mktemp)"
  input="$(jq -n '{tool_name:"Bash",tool_input:{command:"echo hi && npm install express"}}')"
  SOCKET_API_KEY="test-key" SOCKET_GATE_TEST_RESPONSE="$FIXTURES_DIR/allow.ndjson" "$HOOK" >"$tmp" 2>/dev/null <<<"$input"
  out="$(cat "$tmp")"
  assert_contains "$out" "express" "should mention express"
  rm -f "$tmp"
}

echo "8) pip install multiple packages"
{
  tmp="$(mktemp)"
  input="$(jq -n '{tool_name:"Bash",tool_input:{command:"pip install requests flask>=2.0"}}')"
  SOCKET_API_KEY="test-key" SOCKET_GATE_TEST_RESPONSE="$FIXTURES_DIR/pip-multi.ndjson" "$HOOK" >"$tmp" 2>/dev/null <<<"$input"
  out="$(cat "$tmp")"
  assert_contains "$out" "pkg:pypi/requests@2.31.0" "requests purl"
  assert_contains "$out" "pkg:pypi/flask@2.0.0" "flask purl"
  rm -f "$tmp"
}

echo "OK"
