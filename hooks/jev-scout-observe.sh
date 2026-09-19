#!/usr/bin/env bash
#
# jev-scout-observe.sh — Claude Code PostToolUse hook.
#
# Passive coverage for jev-scout: when an agent uses Claude Code's built-in
# WebSearch or WebFetch tools directly (bypassing jev-scout's guarded_search /
# guarded_fetch MCP tools), this hook appends a ledger-compatible metadata
# record to the same JSONL ledger jev-scout's own dashboard and
# research_report read from, so hook-observed activity shows up in the same
# stream.
#
# OBSERVATION ONLY:
#   - no Jev judging happens here — no relevance/credibility/steering_risk
#     score is computed, this is a raw metadata record
#   - no gating — this hook cannot block or alter the tool call it observes
#   - NEVER writes page content: only tool name, the query/URL (hashed if
#     long), and a best-effort ok flag ever reach the ledger line
#
# For real judging and gating, an agent has to route through jev-scout's MCP
# tools (guarded_search / guarded_fetch) — see the main README.
#
# Claude Code hook contract: a PostToolUse hook receives one JSON object on
# stdin with (among other fields) tool_name, tool_input, and tool_response.
# A hook's exit code / stdout must never block the tool call that already
# ran — so this script exits 0 unconditionally, including on malformed
# stdin, missing jq/node, or a ledger write failure. See the trap below.
#
# Ledger directory: $JEV_SCOUT_LEDGER_DIR, defaulting to ~/.jev-scout — the
# same directory jev-scout's own src/ledger.ts writes to, so hook-observed
# events land in the exact daily file the dashboard/report already read.

set -u
set -o pipefail

# Whatever happens below, always exit 0 — a hook must never block the user's
# tool call. This trap is the backstop for bugs in this script itself (an
# unset variable under `set -u`, a pipefail'd command, etc.); every
# deliberate exit path below also calls `exit 0` directly.
trap 'exit 0' EXIT

LEDGER_DIR="${JEV_SCOUT_LEDGER_DIR:-$HOME/.jev-scout}"
# url/query text longer than this many characters is hashed instead of
# stored raw — matching src/ledger.ts's own contentHash() convention that
# payload never carries raw page bodies or arbitrary long text.
MAX_INLINE_LEN=300

have_jq() { command -v jq >/dev/null 2>&1; }

input="$(cat 2>/dev/null || true)"
[ -z "${input:-}" ] && exit 0

# --- 1. Parse: extract tool_name, the relevant tool_input field (query for
#     WebSearch, url for WebFetch), and a best-effort error signal from
#     tool_response. jq is preferred when present; node (already required by
#     jev-scout itself) is the fallback. Any parse failure — malformed
#     stdin — is swallowed here; the EXIT trap still guarantees exit 0.

tool_name=""
value=""
has_error="false"

if have_jq; then
  if ! parsed="$(printf '%s' "$input" | jq -e -r '
      [
        (.tool_name // ""),
        (if .tool_name == "WebSearch" then (.tool_input.query // "")
         elif .tool_name == "WebFetch" then (.tool_input.url // "")
         else "" end),
        (if (.tool_response.error // .tool_response.is_error // false) then "true" else "false" end)
      ] | @tsv
    ' 2>/dev/null)"; then
    exit 0
  fi
  IFS=$'\t' read -r tool_name value has_error <<<"$parsed"
else
  if ! parsed="$(printf '%s' "$input" | node -e '
      try {
        const raw = require("fs").readFileSync(0, "utf8");
        const obj = JSON.parse(raw);
        const toolName = obj.tool_name || "";
        let value = "";
        if (toolName === "WebSearch") value = (obj.tool_input && obj.tool_input.query) || "";
        if (toolName === "WebFetch") value = (obj.tool_input && obj.tool_input.url) || "";
        const tr = obj.tool_response || {};
        const err = Boolean(tr.error || tr.is_error);
        process.stdout.write([toolName, value, err ? "true" : "false"].join("\t"));
      } catch (e) {
        process.exit(1);
      }
    ' 2>/dev/null)"; then
    exit 0
  fi
  IFS=$'\t' read -r tool_name value has_error <<<"$parsed"
fi

case "$tool_name" in
  WebSearch) type_field="search" ;;
  WebFetch) type_field="fetch" ;;
  *) exit 0 ;;
esac

# Nothing meaningful to log if extraction came up empty.
[ -z "$value" ] && exit 0

ok="true"
[ "$has_error" = "true" ] && ok="false"

# --- 2. Hash long content instead of storing it raw.
value_len=${#value}
if [ "$value_len" -gt "$MAX_INLINE_LEN" ]; then
  if command -v shasum >/dev/null 2>&1; then
    value="sha256:$(printf '%s' "$value" | shasum -a 256 | cut -d' ' -f1)"
  elif command -v sha256sum >/dev/null 2>&1; then
    value="sha256:$(printf '%s' "$value" | sha256sum | cut -d' ' -f1)"
  else
    value="sha256:unavailable"
  fi
fi

# --- 3. Compose + append the ledger line. jq builds/escapes the JSON when
#     available; node (JSON.stringify) is the fallback — same escaping
#     guarantee either way. search_id is a fresh id per firing: this is
#     passive hook observation, not tied to a jev-scout MCP session.
ts="$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')"
search_id="hook-$(date +%s)-$$-${RANDOM:-0}"

mkdir -p "$LEDGER_DIR" 2>/dev/null || exit 0
ledger_file="$LEDGER_DIR/ledger-$(date -u +%Y-%m-%d).jsonl"

if have_jq; then
  line="$(jq -nc \
    --arg ts "$ts" \
    --arg search_id "$search_id" \
    --arg type "$type_field" \
    --arg tool_name "$tool_name" \
    --arg value "$value" \
    --argjson ok "$ok" \
    '{ts: $ts, session: "hook", search_id: $search_id, type: $type, payload: {source: "claude-code-hook", tool_name: $tool_name, url_or_query: $value, ok: $ok}}' \
    2>/dev/null)" || exit 0
else
  line="$(node -e '
    const [ts, search_id, type_field, toolName, value, ok] = process.argv.slice(1);
    process.stdout.write(JSON.stringify({
      ts,
      session: "hook",
      search_id,
      type: type_field,
      payload: { source: "claude-code-hook", tool_name: toolName, url_or_query: value, ok: ok === "true" },
    }));
  ' "$ts" "$search_id" "$type_field" "$tool_name" "$value" "$ok" 2>/dev/null)" || exit 0
fi

[ -z "$line" ] && exit 0
printf '%s\n' "$line" >>"$ledger_file" 2>/dev/null || exit 0

exit 0
