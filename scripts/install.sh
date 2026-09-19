#!/usr/bin/env bash
#
# scripts/install.sh — one-command jev-scout install.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/kierandotai/jev-scout/main/scripts/install.sh | bash
#   # or, safer (review before running):
#   git clone https://github.com/kierandotai/jev-scout.git && bash jev-scout/scripts/install.sh
#
# What it does, in order:
#   1. Clones jev-scout (piped/curl mode) or reuses the checkout it's
#      already running from (clone-then-run mode).
#   2. Clones/updates the jev-client sibling repo (jev-scout depends on it
#      as `file:../jev-client`), then `npm install && npm run build` there.
#   3. `npm install` in jev-scout.
#   4. Prints the `claude mcp add` command with this checkout's resolved
#      absolute path, and runs it if the `claude` CLI is on PATH.
#   5. Creates .env from .env.example if missing, and checks it for a Jev
#      key — printing blocked-on-key guidance if neither is set.
#
# Idempotent: safe to re-run. No sudo, ever.

set -euo pipefail

# Overridable via env for testing; default to the real repos.
JEV_SCOUT_REPO_URL="${JEV_SCOUT_REPO_URL:-https://github.com/kierandotai/jev-scout.git}"
JEV_CLIENT_REPO_URL="${JEV_CLIENT_REPO_URL:-https://github.com/kierandotai/jev-client.git}"

log() { printf '==> %s\n' "$*"; }
note() { printf '    note: %s\n' "$*"; }

command -v git >/dev/null 2>&1 || {
  echo "error: git is required and was not found on PATH." >&2
  exit 1
}
command -v npm >/dev/null 2>&1 || {
  echo "error: npm is required and was not found on PATH." >&2
  exit 1
}

# --- 1. Locate (or fetch) the jev-scout checkout ----------------------------
#
# When this script is run as `bash scripts/install.sh` from inside an
# existing checkout, BASH_SOURCE[0] resolves to a real file and we reuse
# that checkout in place. When piped via `curl | bash`, BASH_SOURCE[0]
# isn't a real path on disk, so we clone (or reuse an existing) ./jev-scout
# in the current directory instead.

JEV_SCOUT_DIR=""
script_source="${BASH_SOURCE[0]:-}"
if [ -n "$script_source" ] && [ -f "$script_source" ]; then
  script_dir="$(cd "$(dirname "$script_source")" && pwd -P)"
  candidate_dir="$(dirname "$script_dir")"
  if [ -f "$candidate_dir/package.json" ] && grep -Eq '"name"[[:space:]]*:[[:space:]]*"jev-scout"' "$candidate_dir/package.json" 2>/dev/null; then
    JEV_SCOUT_DIR="$candidate_dir"
  fi
fi

if [ -z "$JEV_SCOUT_DIR" ]; then
  if [ -d "jev-scout" ]; then
    JEV_SCOUT_DIR="$(cd jev-scout && pwd -P)"
    if [ -d "$JEV_SCOUT_DIR/.git" ]; then
      log "jev-scout already present at $JEV_SCOUT_DIR — updating"
      git -C "$JEV_SCOUT_DIR" pull --ff-only || note "could not fast-forward jev-scout; leaving local changes as-is"
    else
      note "./jev-scout exists but isn't a git checkout — using it as-is"
    fi
  else
    log "Cloning jev-scout..."
    git clone "$JEV_SCOUT_REPO_URL" jev-scout
    JEV_SCOUT_DIR="$(cd jev-scout && pwd -P)"
  fi
fi
log "jev-scout: $JEV_SCOUT_DIR"

# --- 2. jev-client sibling ---------------------------------------------------
#
# jev-scout consumes jev-client as `file:../jev-client` (see package.json),
# so it must exist as a sibling of the jev-scout checkout, built.

JEV_CLIENT_DIR="$(dirname "$JEV_SCOUT_DIR")/jev-client"

if [ -d "$JEV_CLIENT_DIR/.git" ]; then
  log "jev-client already present at $JEV_CLIENT_DIR — updating"
  git -C "$JEV_CLIENT_DIR" pull --ff-only || note "could not fast-forward jev-client; leaving local changes as-is"
elif [ -d "$JEV_CLIENT_DIR" ]; then
  note "$JEV_CLIENT_DIR exists but isn't a git checkout — using it as-is"
else
  log "Cloning jev-client..."
  git clone "$JEV_CLIENT_REPO_URL" "$JEV_CLIENT_DIR"
fi

log "Building jev-client..."
(cd "$JEV_CLIENT_DIR" && npm install && npm run build)

# --- 3. jev-scout deps --------------------------------------------------------

log "Installing jev-scout dependencies..."
(cd "$JEV_SCOUT_DIR" && npm install)

# --- 4. Register the MCP server ----------------------------------------------

SERVER_ENTRY="$JEV_SCOUT_DIR/src/server-mcp.ts"
MCP_ADD_CMD=(claude mcp add --scope project --transport stdio jev-scout -- node --experimental-strip-types "$SERVER_ENTRY")

print_mcp_cmd() {
  printf '  %s' "${MCP_ADD_CMD[0]}"
  local i
  for ((i = 1; i < ${#MCP_ADD_CMD[@]}; i++)); do
    printf ' %s' "${MCP_ADD_CMD[$i]}"
  done
  printf '\n'
}

if command -v claude >/dev/null 2>&1; then
  log "Registering jev-scout with the Claude Code CLI..."
  if "${MCP_ADD_CMD[@]}"; then
    log "Registered."
  else
    note "'claude mcp add' failed (it may already be registered). The command was:"
    print_mcp_cmd
  fi
else
  log "Claude Code CLI ('claude') not found on PATH — register jev-scout manually:"
  print_mcp_cmd
fi

# --- 5. .env / Jev key check --------------------------------------------------

ENV_FILE="$JEV_SCOUT_DIR/.env"
ENV_EXAMPLE="$JEV_SCOUT_DIR/.env.example"

if [ ! -f "$ENV_FILE" ] && [ -f "$ENV_EXAMPLE" ]; then
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  log "Created $ENV_FILE from .env.example"
fi

has_key() {
  local var="$1"
  [ -f "$ENV_FILE" ] && grep -Eq "^${var}=.+" "$ENV_FILE" 2>/dev/null
}

if has_key OPENROUTER_API_KEY || has_key TYPESAFE_API_KEY; then
  log "Jev key found in .env."
else
  cat <<EOF

BLOCKED ON KEY: no OPENROUTER_API_KEY or TYPESAFE_API_KEY set in
$ENV_FILE.

jev-scout still runs end-to-end without one — search, fetch, and
research_report all work — but every relevance/credibility/steering_risk
score comes from a mock heuristic, not a real Jev decision. Set one of:

  OPENROUTER_API_KEY=...   # via OpenRouter's alpha Decisions API
  TYPESAFE_API_KEY=...     # direct TypeSafe access (currently waitlisted)

in $ENV_FILE before relying on any score for a real decision.
EOF
fi

log "Done."
echo
echo "Next steps:"
echo "  - jev-scout: $JEV_SCOUT_DIR"
echo "  - jev-client: $JEV_CLIENT_DIR"
echo "  - Start SearXNG (recommended free backend) — see README.md Quickstart."
echo "  - Optional: register hooks/jev-scout-observe.sh for passive built-in"
echo "    WebSearch/WebFetch coverage — see hooks/README.md."
