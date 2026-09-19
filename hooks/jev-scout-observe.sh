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
#     long, and with credentials/query strings redacted for URLs), and a
#     best-effort ok flag ever reach the ledger line
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

# Restrict permissions on everything this script creates (ledger dir, ledger
# files, the error log) to owner-only from the outset, rather than relying
# solely on later explicit chmods.
umask 077

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
export MAX_INLINE_LEN

have_jq() { command -v jq >/dev/null 2>&1; }

# --- Ledger dir safety --------------------------------------------------
#
# Never follow a symlinked ledger dir (a possible symlink-attack vector:
# something could pre-create $JEV_SCOUT_LEDGER_DIR as a symlink pointing
# somewhere this script shouldn't write), and never leave a newly created
# ledger dir group/other-accessible.
ensure_ledger_dir() {
  if [ -e "$LEDGER_DIR" ] && [ -L "$LEDGER_DIR" ]; then
    return 1
  fi
  if [ ! -d "$LEDGER_DIR" ]; then
    mkdir -p "$LEDGER_DIR" 2>/dev/null || return 1
    chmod 700 "$LEDGER_DIR" 2>/dev/null || true
  fi
  [ -d "$LEDGER_DIR" ] && [ -w "$LEDGER_DIR" ]
}

# Best-effort, single-line diagnostic for parse failures. Never allowed to
# affect this script's (always-0) exit status.
log_error() {
  local msg="$1"
  ensure_ledger_dir || return 0
  local clean
  clean="$(printf '%s' "$msg" | tr '\n\r\t' '   ')"
  printf '%s\t%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')" "$clean" \
    >>"$LEDGER_DIR/hook-errors.log" 2>/dev/null || true
  return 0
}

# --- Credential/query redaction (WebFetch URLs only) --------------------
#
# Strip "user:pass@" userinfo and collapse any query string to a fixed
# "?<redacted>" marker, keeping only scheme+host+path. WebSearch queries are
# not URLs and aren't run through this — they rely solely on the 300-char
# hash rule below.
redact_url() {
  local u="$1"
  if [[ "$u" =~ ^([a-zA-Z][a-zA-Z0-9+.-]*://)([^/?#@]*@)?(.*)$ ]]; then
    u="${BASH_REMATCH[1]}${BASH_REMATCH[3]}"
  fi
  if [[ "$u" == *'?'* ]]; then
    u="${u%%\?*}?<redacted>"
  fi
  printf '%s' "$u"
}

sha256_hex() {
  local s="$1"
  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "$s" | shasum -a 256 | cut -d' ' -f1
  elif command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$s" | sha256sum | cut -d' ' -f1
  else
    printf '%s' "unavailable"
  fi
}

input="$(cat 2>/dev/null || true)"
[ -z "${input:-}" ] && exit 0

line=""

if have_jq; then
  # --- jq path -------------------------------------------------------
  #
  # Each field is extracted with its own `jq -r` call (no multi-field TSV
  # round-trip) so a value containing a tab, newline, or anything else can
  # never be mistaken for a field separator or shift subsequent fields.
  if ! printf '%s' "$input" | jq -e . >/dev/null 2>&1; then
    log_error "jq: invalid JSON on stdin"
    exit 0
  fi

  tool_name="$(printf '%s' "$input" | jq -r '(.tool_name? // "")' 2>/dev/null)" || tool_name=""

  case "$tool_name" in
    WebSearch)
      type_field="search"
      value="$(printf '%s' "$input" | jq -r '(.tool_input.query? // "")' 2>/dev/null)" || value=""
      ;;
    WebFetch)
      type_field="fetch"
      value="$(printf '%s' "$input" | jq -r '(.tool_input.url? // "")' 2>/dev/null)" || value=""
      ;;
    *)
      exit 0
      ;;
  esac

  [ -z "$value" ] && exit 0

  # Total (never-fails) probe: only a genuine JSON *object* tool_response is
  # inspected for .error/.is_error — a string, array, number, bool, or null
  # tool_response is treated as "no error" rather than throwing.
  has_error="$(printf '%s' "$input" | jq -r '
      (.tool_response | if type == "object" then (.error // .is_error // false) else false end)
      | if . then "true" else "false" end
    ' 2>/dev/null)" || has_error="false"

  ok="true"
  [ "$has_error" = "true" ] && ok="false"

  if [ "$type_field" = "fetch" ]; then
    value="$(redact_url "$value")"
  fi
  if [ "${#value}" -gt "$MAX_INLINE_LEN" ]; then
    value="sha256:$(sha256_hex "$value")"
  fi

  ts="$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')"
  search_id="hook-$(date +%s)-$$-${RANDOM:-0}"

  line="$(jq -nc \
    --arg ts "$ts" \
    --arg search_id "$search_id" \
    --arg type "$type_field" \
    --arg tool_name "$tool_name" \
    --arg value "$value" \
    --argjson ok "$ok" \
    '{ts: $ts, session: "hook", search_id: $search_id, type: $type, payload: {source: "claude-code-hook", tool_name: $tool_name, url_or_query: $value, ok: $ok}}' \
    2>/dev/null)" || { log_error "jq: failed to build ledger line"; exit 0; }
else
  # --- node fallback ---------------------------------------------------
  #
  # node builds and prints the *entire* final ledger JSON line itself
  # (parsing, redaction, hashing via its own crypto module, and JSON
  # assembly) rather than round-tripping intermediate fields through a
  # hand-joined TSV string back into this shell — that hand-joined TSV was
  # the injection surface: an unescaped tab or newline in a query/URL could
  # shift which value landed in which shell variable. Nothing here is ever
  # passed through a shell string built from tool-controlled input.
  node_err="$(mktemp 2>/dev/null || printf '/tmp/jev-scout-hook-err.%s' "$$")"
  line="$(printf '%s' "$input" | node -e '
      "use strict";
      const crypto = require("crypto");

      function fail(msg) {
        process.stderr.write(String(msg).split("\n")[0].slice(0, 200) + "\n");
        process.exit(1);
      }

      let raw;
      try {
        raw = require("fs").readFileSync(0, "utf8");
      } catch (e) {
        fail("stdin read failed: " + (e && e.message));
      }

      let obj;
      try {
        obj = JSON.parse(raw);
      } catch (e) {
        fail("invalid JSON on stdin: " + (e && e.message));
      }

      if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
        process.exit(0);
      }

      const toolName = typeof obj.tool_name === "string" ? obj.tool_name : "";
      const tiRaw = obj.tool_input;
      const ti = (tiRaw !== null && typeof tiRaw === "object" && !Array.isArray(tiRaw)) ? tiRaw : {};

      let typeField, value;
      if (toolName === "WebSearch") {
        typeField = "search";
        value = typeof ti.query === "string" ? ti.query : "";
      } else if (toolName === "WebFetch") {
        typeField = "fetch";
        value = typeof ti.url === "string" ? ti.url : "";
      } else {
        process.exit(0);
      }
      if (!value) process.exit(0);

      // Total probe: only a genuine object tool_response is inspected.
      const tr = obj.tool_response;
      const isPlainObject = tr !== null && typeof tr === "object" && !Array.isArray(tr);
      const hasError = isPlainObject ? Boolean(tr.error || tr.is_error) : false;

      function redactUrl(u) {
        let s = u;
        const m = s.match(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/?#@]*@)?([\s\S]*)$/);
        if (m) s = m[1] + m[3];
        const qi = s.indexOf("?");
        if (qi !== -1) s = s.slice(0, qi) + "?<redacted>";
        return s;
      }

      if (typeField === "fetch") value = redactUrl(value);

      const maxInlineLen = parseInt(process.env.MAX_INLINE_LEN || "300", 10);
      if (value.length > maxInlineLen) {
        value = "sha256:" + crypto.createHash("sha256").update(value, "utf8").digest("hex");
      }

      const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z");
      const searchId = "hook-" + Math.floor(Date.now() / 1000) + "-" + process.pid + "-" + Math.floor(Math.random() * 32768);

      process.stdout.write(JSON.stringify({
        ts: nowIso,
        session: "hook",
        search_id: searchId,
        type: typeField,
        payload: { source: "claude-code-hook", tool_name: toolName, url_or_query: value, ok: !hasError },
      }));
    ' 2>"$node_err")"
  node_status=$?
  node_stderr="$(cat "$node_err" 2>/dev/null || true)"
  rm -f "$node_err" 2>/dev/null || true

  if [ "$node_status" -ne 0 ]; then
    log_error "node: ${node_stderr:-non-zero exit with no diagnostic}"
    exit 0
  fi
  [ -z "$line" ] && exit 0
fi

[ -z "$line" ] && exit 0

ensure_ledger_dir || exit 0
ledger_file="$LEDGER_DIR/ledger-$(date -u +%Y-%m-%d).jsonl"
printf '%s\n' "$line" >>"$ledger_file" 2>/dev/null || exit 0

exit 0
