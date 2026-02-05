#!/usr/bin/env bash
set -euo pipefail

# Socket Security Gate for Claude Code PreToolUse hooks.
#
# - Reads hook JSON on stdin, extracts `tool_input.command`
# - Detects package install commands (npm/pnpm/yarn/npx, pip/uv/poetry/pipx, cargo, go, gem, nuget)
# - Queries Socket API for scores/alerts
# - Blocks known malware by default (supply_chain == 0) and warns on low scores

SOCKET_GATE_VERSION="${SOCKET_GATE_VERSION:-0.1.0}"
SOCKET_GATE_MODE="${SOCKET_GATE_MODE:-enforce}" # enforce | warn | off
SOCKET_GATE_FAIL_BEHAVIOR="${SOCKET_GATE_FAIL_BEHAVIOR:-open}" # open | closed
SOCKET_GATE_BLOCK_THRESHOLD="${SOCKET_GATE_BLOCK_THRESHOLD:-0}" # normalized 0.0-1.0
SOCKET_GATE_WARN_THRESHOLD="${SOCKET_GATE_WARN_THRESHOLD:-0.4}" # normalized 0.0-1.0

SOCKET_GATE_API_URL_DEFAULT="https://api.socket.dev/v0/purl?alerts=true&compact=true"
SOCKET_GATE_API_URL="${SOCKET_GATE_API_URL:-$SOCKET_GATE_API_URL_DEFAULT}"

stderr () { printf '%s\n' "$*" >&2; }

trim () {
  # shellcheck disable=SC2001
  local s
  s="$(printf '%s' "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  printf '%s' "$s"
}

strip_quotes () {
  local s="$1"
  s="${s#\"}"
  s="${s%\"}"
  s="${s#\'}"
  s="${s%\'}"
  printf '%s' "$s"
}

is_path_like () {
  case "$1" in
    .|./*|../*|/*|file:*|link:*|workspace:*|npm:*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

strip_version_prefixes () {
  # Remove common version range operators.
  # Examples: ^1.2.3 -> 1.2.3, >=2.0 -> 2.0, ==3.1 -> 3.1
  local v="$1"
  v="${v#^}"
  v="${v#~}"
  v="${v#>=}"
  v="${v#<=}"
  v="${v#==}"
  v="${v#!=}"
  v="${v#>}"
  v="${v#<}"
  printf '%s' "$v"
}

normalize_pypi_name () {
  # PEP 503: lowercase and replace -, _, . with -
  local n="$1"
  n="$(printf '%s' "$n" | tr '[:upper:]' '[:lower:]' | sed -e 's/[._-]/-/g')"
  printf '%s' "$n"
}

to_purl () {
  local ecosystem="$1"
  local name="$2"
  local version="${3:-unknown}"

  version="$(strip_version_prefixes "$version")"
  if [[ -z "$version" || "$version" == "unknown" || "$version" == "1.0.0" ]]; then
    version=""
  fi

  case "$ecosystem" in
    npm)
      # Encode @ for scoped packages: @scope/name -> %40scope/name
      if [[ "$name" == @* ]]; then
        name="%40${name#@}"
      fi
      ;;
    pypi)
      name="$(normalize_pypi_name "$name")"
      ;;
  esac

  if [[ -n "$version" ]]; then
    printf 'pkg:%s/%s@%s' "$ecosystem" "$name" "$version"
  else
    printf 'pkg:%s/%s' "$ecosystem" "$name"
  fi
}

add_component () {
  local ecosystem="$1"
  local spec="$2"
  local version="${3:-unknown}"
  local name

  spec="$(strip_quotes "$spec")"
  if [[ -z "$spec" ]]; then
    return 0
  fi

  if is_path_like "$spec"; then
    return 0
  fi

  # Skip git/url installs (out of scope for this hook)
  case "$spec" in
    *://*|git+*|github:*|gitlab:*|bitbucket:*)
      return 0
      ;;
  esac

  name="$spec"

  # Split name@version for ecosystems that use @ pinning.
  # Special case for scoped npm packages: @scope/name@1.2.3 (split on last @).
  if [[ "$ecosystem" == "npm" || "$ecosystem" == "cargo" || "$ecosystem" == "go" ]]; then
    if [[ "$spec" == @* ]]; then
      local rest="${spec#@}"
      if [[ "$rest" == *@* ]]; then
        name="${spec%@*}"
        version="${spec##*@}"
      fi
    elif [[ "$spec" == *@* ]]; then
      name="${spec%@*}"
      version="${spec##*@}"
    fi
  fi

  # Split pypi version specifiers (==, >=, <=, !=, ~=, >, <)
  if [[ "$ecosystem" == "pypi" ]]; then
    case "$spec" in
      *'=='*)
        name="${spec%%==*}"
        version="${spec#*==}"
        ;;
      *'>='*)
        name="${spec%%>=*}"
        version="${spec#*>=}"
        ;;
      *'<='*)
        name="${spec%%<=*}"
        version="${spec#*<=}"
        ;;
      *'!='*)
        name="${spec%%!=*}"
        version="${spec#*!=}"
        ;;
      *'~='*)
        name="${spec%%~=*}"
        version="${spec#*~=}"
        ;;
      *'>'*)
        name="${spec%%>*}"
        version="${spec#*>}"
        ;;
      *'<'*)
        name="${spec%%<*}"
        version="${spec#*<}"
        ;;
    esac
  fi

  name="$(trim "$name")"
  if [[ -z "$name" ]]; then
    return 0
  fi

  local purl
  purl="$(to_purl "$ecosystem" "$name" "$version")"
  COMPONENT_PURLS+=("$purl")
}

parse_npm_like () {
  local ecosystem="$1"
  shift 1

  while [[ $# -gt 0 ]]; do
    local tok="${1:-}"
    shift 1
    tok="$(strip_quotes "$tok")"
    if [[ -z "$tok" ]]; then
      continue
    fi
    if [[ "$tok" == "--" ]]; then
      continue
    fi
    if [[ "$tok" == -* ]]; then
      continue
    fi
    if is_path_like "$tok"; then
      continue
    fi
    add_component "$ecosystem" "$tok" "unknown"
  done
}

extract_components_from_segment () {
  local segment="$1"
  segment="$(trim "$segment")"
  if [[ -z "$segment" ]]; then
    return 0
  fi

  local -a tokens
  # Basic whitespace tokenization; does not execute/evaluate the command.
  # Quotes (if present) remain in tokens and are stripped later.
  read -r -a tokens <<< "$segment"
  if [[ "${#tokens[@]}" -eq 0 ]]; then
    return 0
  fi

  local i=0
  while [[ $i -lt ${#tokens[@]} ]]; do
    local t="${tokens[$i]}"

    # Skip common prefixes
    if [[ "$t" == "sudo" ]]; then
      i=$((i + 1))
      continue
    fi

    # npm ecosystem
    if [[ "$t" == "npm" ]]; then
      local sub="${tokens[$((i + 1))]:-}"
      if [[ "$sub" == "ci" ]]; then
        return 0
      fi
      if [[ "$sub" == "install" || "$sub" == "i" || "$sub" == "add" ]]; then
        # If there are no args beyond flags, treat as lockfile restore and pass-through.
        local -a rest=("${tokens[@]:$((i + 2))}")
        local has_pkg="false"
        local r=0
        while [[ $r -lt ${#rest[@]} ]]; do
          local tok
          tok="$(strip_quotes "${rest[$r]}")"
          r=$((r + 1))
          if [[ -z "$tok" || "$tok" == "--" || "$tok" == -* ]]; then
            continue
          fi
          if is_path_like "$tok"; then
            continue
          fi
          has_pkg="true"
          break
        done
        if [[ "$has_pkg" == "true" ]]; then
          parse_npm_like npm "${rest[@]}"
        fi
        return 0
      fi
    fi

    if [[ "$t" == "pnpm" ]]; then
      local sub="${tokens[$((i + 1))]:-}"
      if [[ "$sub" == "add" ]]; then
        local -a rest=("${tokens[@]:$((i + 2))}")
        if [[ ${#rest[@]} -gt 0 ]]; then
          parse_npm_like npm "${rest[@]}"
        fi
        return 0
      fi
      if [[ "$sub" == "install" ]]; then
        # pnpm install with no packages should pass through
        local -a rest=("${tokens[@]:$((i + 2))}")
        local has_pkg="false"
        local r=0
        while [[ $r -lt ${#rest[@]} ]]; do
          local tok
          tok="$(strip_quotes "${rest[$r]}")"
          r=$((r + 1))
          if [[ -z "$tok" || "$tok" == "--" || "$tok" == -* ]]; then
            continue
          fi
          if is_path_like "$tok"; then
            continue
          fi
          has_pkg="true"
          break
        done
        if [[ "$has_pkg" == "true" ]]; then
          parse_npm_like npm "${rest[@]}"
        fi
        return 0
      fi
    fi

    if [[ "$t" == "yarn" ]]; then
      local sub="${tokens[$((i + 1))]:-}"
      if [[ "$sub" == "add" ]]; then
        local -a rest=("${tokens[@]:$((i + 2))}")
        if [[ ${#rest[@]} -gt 0 ]]; then
          parse_npm_like npm "${rest[@]}"
        fi
        return 0
      fi
    fi

    if [[ "$t" == "npx" ]]; then
      # Prefer explicit -p/--package flags; otherwise use first non-flag token.
      local -a rest=("${tokens[@]:$((i + 1))}")
      local j=0
      local collected="false"
      while [[ $j -lt ${#rest[@]} ]]; do
        local rt
        rt="$(strip_quotes "${rest[$j]}")"
        if [[ "$rt" == "-p" || "$rt" == "--package" ]]; then
          local pkg="${rest[$((j + 1))]:-}"
          pkg="$(strip_quotes "$pkg")"
          if [[ -n "$pkg" ]]; then
            add_component npm "$pkg" "unknown"
            collected="true"
          fi
          j=$((j + 2))
          continue
        fi
        j=$((j + 1))
      done

      if [[ "$collected" != "true" ]]; then
        local r=0
        while [[ $r -lt ${#rest[@]} ]]; do
          local rt2
          rt2="$(strip_quotes "${rest[$r]}")"
          r=$((r + 1))
          if [[ -z "$rt2" || "$rt2" == "--" || "$rt2" == -* ]]; then
            continue
          fi
          add_component npm "$rt2" "unknown"
          break
        done
      fi
      return 0
    fi

    # pypi ecosystem
    if [[ "$t" == "pip" || "$t" == "pip3" ]]; then
      local sub="${tokens[$((i + 1))]:-}"
      if [[ "$sub" == "install" ]]; then
        local -a rest=("${tokens[@]:$((i + 2))}")
        local r=0
        while [[ $r -lt ${#rest[@]} ]]; do
          local tok
          tok="$(strip_quotes "${rest[$r]}")"
          r=$((r + 1))
          if [[ "$tok" == "-r" || "$tok" == "--requirement" || "$tok" == "-e" || "$tok" == "--editable" ]]; then
            return 0
          fi
        done
        r=0
        while [[ $r -lt ${#rest[@]} ]]; do
          local tok
          tok="$(strip_quotes "${rest[$r]}")"
          r=$((r + 1))
          if [[ -z "$tok" || "$tok" == "--" || "$tok" == -* ]]; then
            continue
          fi
          if is_path_like "$tok"; then
            return 0
          fi
          add_component pypi "$tok" "unknown"
        done
        return 0
      fi
    fi

    if [[ "$t" == "uv" ]]; then
      local sub="${tokens[$((i + 1))]:-}"
      if [[ "$sub" == "add" ]]; then
        local -a rest=("${tokens[@]:$((i + 2))}")
        local r=0
        while [[ $r -lt ${#rest[@]} ]]; do
          local tok
          tok="$(strip_quotes "${rest[$r]}")"
          r=$((r + 1))
          if [[ -z "$tok" || "$tok" == "--" || "$tok" == -* ]]; then
            continue
          fi
          if is_path_like "$tok"; then
            return 0
          fi
          add_component pypi "$tok" "unknown"
        done
        return 0
      fi
      if [[ "$sub" == "pip" && "${tokens[$((i + 2))]:-}" == "install" ]]; then
        local -a rest=("${tokens[@]:$((i + 3))}")
        local r=0
        while [[ $r -lt ${#rest[@]} ]]; do
          local tok
          tok="$(strip_quotes "${rest[$r]}")"
          r=$((r + 1))
          if [[ "$tok" == "-r" || "$tok" == "--requirement" || "$tok" == "-e" || "$tok" == "--editable" ]]; then
            return 0
          fi
        done
        r=0
        while [[ $r -lt ${#rest[@]} ]]; do
          local tok
          tok="$(strip_quotes "${rest[$r]}")"
          r=$((r + 1))
          if [[ -z "$tok" || "$tok" == "--" || "$tok" == -* ]]; then
            continue
          fi
          if is_path_like "$tok"; then
            return 0
          fi
          add_component pypi "$tok" "unknown"
        done
        return 0
      fi
    fi

    if [[ "$t" == "poetry" ]]; then
      local sub="${tokens[$((i + 1))]:-}"
      if [[ "$sub" == "add" ]]; then
        local -a rest=("${tokens[@]:$((i + 2))}")
        local r=0
        while [[ $r -lt ${#rest[@]} ]]; do
          local tok
          tok="$(strip_quotes "${rest[$r]}")"
          r=$((r + 1))
          if [[ -z "$tok" || "$tok" == "--" || "$tok" == -* ]]; then
            continue
          fi
          if is_path_like "$tok"; then
            return 0
          fi
          add_component pypi "$tok" "unknown"
        done
        return 0
      fi
    fi

    if [[ "$t" == "pipx" ]]; then
      local sub="${tokens[$((i + 1))]:-}"
      if [[ "$sub" == "install" ]]; then
        local -a rest=("${tokens[@]:$((i + 2))}")
        local r=0
        while [[ $r -lt ${#rest[@]} ]]; do
          local tok
          tok="$(strip_quotes "${rest[$r]}")"
          r=$((r + 1))
          if [[ -z "$tok" || "$tok" == "--" || "$tok" == -* ]]; then
            continue
          fi
          if is_path_like "$tok"; then
            return 0
          fi
          add_component pypi "$tok" "unknown"
        done
        return 0
      fi
    fi

    # cargo ecosystem
    if [[ "$t" == "cargo" ]]; then
      local sub="${tokens[$((i + 1))]:-}"
      if [[ "$sub" == "add" || "$sub" == "install" ]]; then
        local -a rest=("${tokens[@]:$((i + 2))}")
        local r=0
        while [[ $r -lt ${#rest[@]} ]]; do
          local tok
          tok="$(strip_quotes "${rest[$r]}")"
          r=$((r + 1))
          if [[ -z "$tok" || "$tok" == "--" || "$tok" == -* ]]; then
            continue
          fi
          add_component cargo "$tok" "unknown"
        done
        return 0
      fi
    fi

    # go ecosystem
    if [[ "$t" == "go" ]]; then
      local sub="${tokens[$((i + 1))]:-}"
      if [[ "$sub" == "get" || "$sub" == "install" ]]; then
        local -a rest=("${tokens[@]:$((i + 2))}")
        local r=0
        while [[ $r -lt ${#rest[@]} ]]; do
          local tok
          tok="$(strip_quotes "${rest[$r]}")"
          r=$((r + 1))
          if [[ -z "$tok" || "$tok" == "--" || "$tok" == -* ]]; then
            continue
          fi
          add_component go "$tok" "unknown"
        done
        return 0
      fi
    fi

    # gem ecosystem
    if [[ "$t" == "gem" ]]; then
      local sub="${tokens[$((i + 1))]:-}"
      if [[ "$sub" == "install" ]]; then
        local -a rest=("${tokens[@]:$((i + 2))}")
        local j=0
        while [[ $j -lt ${#rest[@]} ]]; do
          local tok
          tok="$(strip_quotes "${rest[$j]}")"
          if [[ -z "$tok" || "$tok" == "--" ]]; then
            j=$((j + 1))
            continue
          fi
          if [[ "$tok" == "-v" || "$tok" == "--version" ]]; then
            j=$((j + 2))
            continue
          fi
          if [[ "$tok" == -* ]]; then
            j=$((j + 1))
            continue
          fi
          add_component gem "$tok" "unknown"
          j=$((j + 1))
        done
        return 0
      fi
    fi

    if [[ "$t" == "bundle" ]]; then
      local sub="${tokens[$((i + 1))]:-}"
      if [[ "$sub" == "add" ]]; then
        local -a rest=("${tokens[@]:$((i + 2))}")
        local r=0
        while [[ $r -lt ${#rest[@]} ]]; do
          local tok
          tok="$(strip_quotes "${rest[$r]}")"
          r=$((r + 1))
          if [[ -z "$tok" || "$tok" == "--" || "$tok" == -* ]]; then
            continue
          fi
          add_component gem "$tok" "unknown"
        done
        return 0
      fi
    fi

    # nuget ecosystem
    if [[ "$t" == "dotnet" && "${tokens[$((i + 1))]:-}" == "add" && "${tokens[$((i + 2))]:-}" == "package" ]]; then
      local -a rest=("${tokens[@]:$((i + 3))}")
      local j=0
      while [[ $j -lt ${#rest[@]} ]]; do
        local tok
        tok="$(strip_quotes "${rest[$j]}")"
        if [[ -z "$tok" || "$tok" == "--" ]]; then
          j=$((j + 1))
          continue
        fi
        if [[ "$tok" == "--version" ]]; then
          j=$((j + 2))
          continue
        fi
        if [[ "$tok" == -* ]]; then
          j=$((j + 1))
          continue
        fi
        add_component nuget "$tok" "unknown"
        j=$((j + 1))
      done
      return 0
    fi

    if [[ "$t" == "nuget" && "${tokens[$((i + 1))]:-}" == "install" ]]; then
      local -a rest=("${tokens[@]:$((i + 2))}")
      local r=0
      while [[ $r -lt ${#rest[@]} ]]; do
        local tok
        tok="$(strip_quotes "${rest[$r]}")"
        r=$((r + 1))
        if [[ -z "$tok" || "$tok" == "--" || "$tok" == -* ]]; then
          continue
        fi
        add_component nuget "$tok" "unknown"
      done
      return 0
    fi

    i=$((i + 1))
  done
}

hook_allow_with_context () {
  local ctx="$1"
  jq -n --arg ctx "$ctx" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      additionalContext: $ctx
    }
  }'
}

main () {
  if [[ "$SOCKET_GATE_MODE" == "off" ]]; then
    exit 0
  fi

  local payload
  payload="$(cat || true)"
  if [[ -z "$payload" ]]; then
    exit 0
  fi

  local command
  command="$(jq -r '.tool_input.command // .toolInput.command // empty' 2>/dev/null <<<"$payload" || true)"
  command="${command//$'\n'/ }"
  if [[ -z "$command" || "$command" == "null" ]]; then
    exit 0
  fi

  COMPONENT_PURLS=()

  # Split chained commands. This is a heuristic split; it does not evaluate shell syntax.
  local normalized
  normalized="$(printf '%s' "$command" | sed -e 's/&&/;/g' -e 's/||/;/g')"

  local -a segments
  IFS=';' read -r -a segments <<< "$normalized"
  local s=0
  while [[ $s -lt ${#segments[@]} ]]; do
    extract_components_from_segment "${segments[$s]}"
    s=$((s + 1))
  done

  if [[ "${#COMPONENT_PURLS[@]}" -eq 0 ]]; then
    exit 0
  fi

  local api_key="${SOCKET_API_KEY:-}"
  if [[ -z "$api_key" ]]; then
    stderr "socket-gate: SOCKET_API_KEY is not set; skipping Socket security check (fail-open)"
    hook_allow_with_context "Socket: SOCKET_API_KEY not set; skipping package security check (fail-open)."
    exit 0
  fi

  local request_body
  request_body="$(printf '%s\n' "${COMPONENT_PURLS[@]}" | jq -Rs 'split("\n") | map(select(length>0)) | map({purl: .}) | {components: .}')"

  local http_status="200"
  local response_body=""

  if [[ -n "${SOCKET_GATE_TEST_RESPONSE:-}" ]]; then
    response_body="$(cat "$SOCKET_GATE_TEST_RESPONSE")"
    http_status="${SOCKET_GATE_TEST_HTTP_STATUS:-200}"
  else
    local tmp
    tmp="$(mktemp)"
    http_status="$(curl -sS --max-time 25 \
      -o "$tmp" \
      -w '%{http_code}' \
      -H "Authorization: Bearer $api_key" \
      -H 'Content-Type: application/json' \
      -H 'Accept: application/x-ndjson' \
      -H "User-Agent: socket-gate/$SOCKET_GATE_VERSION" \
      --data-binary "$request_body" \
      "$SOCKET_GATE_API_URL" || true)"
    response_body="$(cat "$tmp" || true)"
    rm -f "$tmp"
  fi

  if [[ "$http_status" != "200" || -z "$(trim "$response_body")" ]]; then
    if [[ "$SOCKET_GATE_FAIL_BEHAVIOR" == "closed" && "$SOCKET_GATE_MODE" == "enforce" ]]; then
      stderr "socket-gate: Socket API unreachable or error (status=$http_status); blocking install (fail-closed mode)"
      stderr "Blocked by socket-gate (fail-closed)."
      exit 2
    fi

    stderr "socket-gate: Socket API unreachable or error (status=$http_status); allowing install (fail-open mode)"
    hook_allow_with_context "Socket: API check failed (status=$http_status). Install allowed under fail-open policy."
    exit 0
  fi

  # Convert NDJSON to JSON array
  local json_array
  json_array="$(printf '%s' "$response_body" | sed '/^[[:space:]]*$/d' | jq -s '.' 2>/dev/null || true)"
  if [[ -z "$json_array" || "$json_array" == "null" ]]; then
    if [[ "$SOCKET_GATE_FAIL_BEHAVIOR" == "closed" && "$SOCKET_GATE_MODE" == "enforce" ]]; then
      stderr "socket-gate: Failed to parse Socket API response; blocking install (fail-closed mode)"
      exit 2
    fi
    stderr "socket-gate: Failed to parse Socket API response; allowing install (fail-open mode)"
    hook_allow_with_context "Socket: API check failed (invalid response). Install allowed under fail-open policy."
    exit 0
  fi

  local decision_lines=""
  local blocked_lines=""
  local warnings_found="false"
  local blocks_found="false"

  # Emit tab-separated summary lines from jq:
  # type, name, version, sc_norm, sc_pct, q_pct, v_pct, m_pct, l_pct, alerts_count
  local summaries
  summaries="$(jq -r '
    def pct(x):
      if (x|type) == "number" then
        (if x <= 1 then (x * 100 | round) else (x | round) end)
      else "" end;
    def norm(x):
      if (x|type) == "number" then
        (if x <= 1 then x else (x / 100) end)
      else null end;
    .[] | [
      (.type // "unknown"),
      (.name // "unknown"),
      (.version // "unknown"),
      (norm(.score.supply_chain) // ""),
      (pct(.score.supply_chain) // ""),
      (pct(.score.quality) // ""),
      (pct(.score.vulnerability) // ""),
      (pct(.score.maintenance) // ""),
      (pct(.score.license) // ""),
      ((.alerts // []) | length)
    ] | @tsv
  ' <<<"$json_array" 2>/dev/null || true)"

  if [[ -z "$(trim "$summaries")" ]]; then
    # No usable results; allow unless fail-closed
    if [[ "$SOCKET_GATE_FAIL_BEHAVIOR" == "closed" && "$SOCKET_GATE_MODE" == "enforce" ]]; then
      stderr "socket-gate: Socket API returned no usable results; blocking install (fail-closed mode)"
      exit 2
    fi
    hook_allow_with_context "Socket: No usable results from API. Install allowed under fail-open policy."
    exit 0
  fi

  local line
  while IFS=$'\t' read -r r_type r_name r_ver r_sc_norm r_sc_pct r_q_pct r_v_pct r_m_pct r_l_pct r_alerts_count; do
    local ecosystem="$r_type"
    local name="$r_name"
    local ver="$r_ver"
    local purl
    purl="$(to_purl "$ecosystem" "$name" "$ver")"

    local sc_norm="$r_sc_norm"
    local sc_pct="$r_sc_pct"

    local is_block="false"
    local is_warn="false"

    if [[ -n "$sc_norm" ]]; then
      # Compare floats via awk for bash portability.
      local block_hit
      block_hit="$(awk -v a="$sc_norm" -v b="$SOCKET_GATE_BLOCK_THRESHOLD" 'BEGIN { print (a <= b) ? "1" : "0" }')"
      if [[ "$block_hit" == "1" ]]; then
        is_block="true"
      fi

      local warn_hit
      warn_hit="$(awk -v a="$sc_norm" -v b="$SOCKET_GATE_WARN_THRESHOLD" 'BEGIN { print (a < b) ? "1" : "0" }')"
      if [[ "$warn_hit" == "1" ]]; then
        is_warn="true"
      fi
    else
      is_warn="true"
    fi

    if [[ "$SOCKET_GATE_MODE" == "warn" ]]; then
      is_block="false"
      if [[ "$is_warn" == "false" ]]; then
        is_warn="true"
      fi
    fi

    if [[ "$is_block" == "true" && "$SOCKET_GATE_MODE" == "enforce" ]]; then
      blocks_found="true"
      blocks_found="true"
      blocked_lines="${blocked_lines}Socket security check BLOCKED: ${purl}\n  supply_chain: ${sc_pct} (threshold=${SOCKET_GATE_BLOCK_THRESHOLD})\n\n"
      continue
    fi

    if [[ "$is_warn" == "true" ]]; then
      warnings_found="true"
      decision_lines="${decision_lines}Socket WARNING: ${purl} has low supply_chain score (${sc_pct}). ${r_alerts_count} alerts found. Proceed with caution.\n"
    else
      decision_lines="${decision_lines}Socket: ${purl} passed (supply_chain=${sc_pct}, quality=${r_q_pct}, vulnerability=${r_v_pct}, maintenance=${r_m_pct}, license=${r_l_pct})\n"
    fi
  done <<< "$summaries"

  if [[ "$blocks_found" == "true" && "$SOCKET_GATE_MODE" == "enforce" ]]; then
    # Print stderr block message and exit 2 to stop execution.
    # shellcheck disable=SC2059
    stderr "$(printf "$blocked_lines")"
    stderr "Blocked by socket-gate. One or more packages are flagged as malicious."
    stderr "Do NOT install them. Find an alternative."
    exit 2
  fi

  # shellcheck disable=SC2059
  hook_allow_with_context "$(printf "$decision_lines")"
  exit 0
}

main "$@"
