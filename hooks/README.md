# jev-scout Claude Code hooks

`jev-scout-observe.sh` gives jev-scout **passive coverage** of Claude Code's
built-in `WebSearch` and `WebFetch` tools, for the case where an agent
bypasses jev-scout's own MCP tools (`guarded_search` / `guarded_fetch`) and
uses the built-ins directly. Without this hook, that activity is invisible
to jev-scout entirely; with it, a lightweight metadata record still lands in
the same ledger the dashboard and `research_report` already read.

## What it does

Registered as a Claude Code `PostToolUse` hook matching `WebSearch|WebFetch`,
the script:

1. Reads the hook's JSON payload from stdin (`tool_name`, `tool_input`,
   `tool_response` — see [Claude Code's hooks
   docs](https://docs.claude.com/en/docs/claude-code/hooks) for the full
   contract).
2. For `WebSearch`/`WebFetch` events only, appends one JSONL line to
   `$JEV_SCOUT_LEDGER_DIR/ledger-YYYY-MM-DD.jsonl` (default
   `~/.jev-scout/ledger-YYYY-MM-DD.jsonl` — the same directory and filename
   convention jev-scout's own `src/ledger.ts` uses):

   ```json
   {
     "ts": "2026-09-19T21:17:41.000Z",
     "session": "hook",
     "search_id": "hook-1789852661-3989-17388",
     "type": "fetch",
     "payload": {
       "source": "claude-code-hook",
       "tool_name": "WebFetch",
       "url_or_query": "https://example.com/page",
       "ok": true
     }
   }
   ```

   `type` is `"search"` for `WebSearch` and `"fetch"` for `WebFetch`.
   `url_or_query` is the query text or URL — hashed (`sha256:<hex>`) instead
   of stored raw when it's longer than 300 characters, mirroring
   `src/ledger.ts`'s own `contentHash()` convention.
3. Any other `tool_name`, and malformed or empty stdin, produce no ledger
   line at all. A malformed/unparseable stdin payload additionally appends
   one single-line diagnostic to `$JEV_SCOUT_LEDGER_DIR/hook-errors.log`
   (still exiting `0` — see below).
4. Exits `0` unconditionally — a hook must never block the tool call it's
   observing, so every failure path (bad JSON, missing `jq`, a ledger write
   error) is swallowed rather than surfaced as a nonzero exit.

Parsing prefers `jq` when it's on `PATH`, and falls back to `node` (already
a jev-scout prerequisite) when it isn't. Both paths implement the same
extraction, redaction, and hashing rules and are expected to produce
identical ledger lines (aside from the inherently per-invocation `ts` /
`search_id` fields) for the same input — see `test/hooks.test.ts`'s
jq-vs-node parity test. Neither path ever builds a shell command string out
of tool-controlled input (query text, URLs), so control characters,
`$(...)`, backticks, and the like in a query or URL cannot be interpreted
by the shell — they round-trip into the ledger line as literal text (or get
hashed, per the 300-char rule above) rather than being executed.

### Credential redaction

Before a `WebFetch` URL is logged (raw or hashed), it's redacted:

- **Userinfo is stripped.** `https://user:pass@host/path` is logged as
  `https://host/path` — a URL's embedded username/password never reaches
  the ledger.
- **Query strings are collapsed.** Any `?...` component is replaced with
  the fixed marker `?<redacted>`, so a `?token=...`, `?api_key=...`, or any
  other query parameter never reaches the ledger either. Only
  scheme+host+path survive.

This redaction applies to `WebFetch` URLs only. `WebSearch` queries are
free text, not URLs, so they are not parsed or redacted this way — they
rely solely on the 300-character inline/hash threshold above. (A query that
happens to look like a credential-bearing URL is therefore logged verbatim
if it's under 300 characters — search queries are Claude Code's own
argument to `WebSearch`, not something jev-scout constructs or resolves.)

### A note on the ledger filename's date

`ledger-YYYY-MM-DD.jsonl` uses **UTC**, not local time (see the `date -u`
call above), matching `src/ledger.ts`. Near local midnight — specifically
whenever local time and UTC fall on different calendar dates — an event
observed by this hook can land in a ledger file dated "yesterday" or
"tomorrow" relative to your local wall clock. This is expected and
consistent with how jev-scout's own ledger writer names files; if you're
hunting for an event that "isn't showing up" in the file you expected right
after local midnight, check the adjacent day's file too.

## What it does *not* do

This is **observation only**:

- **No Jev judging.** No relevance, credibility, or steering-risk score is
  computed — the hook only ever writes `ok: true/false` (a best-effort
  success signal read off `tool_response`), never a Jev decision.
- **No gating.** The hook cannot block, delay, or alter the tool call it's
  reacting to — it runs after the call already completed and only appends a
  line to a file.
- **No page content, ever.** Only the tool name and the query/URL (hashed if
  long) are written. Fetched page bodies, search result bodies, and
  `tool_response` contents are never logged.

To get real per-result/per-page Jev scoring and optional gating, an agent
has to route its research through jev-scout's MCP tools
(`guarded_search` / `guarded_fetch`) — see the main
[README](../README.md). This hook exists purely so that when an agent
*doesn't* do that, the activity still shows up in the same dashboard/report
stream instead of vanishing entirely.

## Registering the hook

Add a `PostToolUse` hook entry to Claude Code's `settings.json` (project
`.claude/settings.json` or user `~/.claude/settings.json`), pointing at this
script's **absolute** path:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "WebSearch|WebFetch",
        "hooks": [
          {
            "type": "command",
            "command": "/ABS/PATH/jev-scout/hooks/jev-scout-observe.sh"
          }
        ]
      }
    ]
  }
}
```

`scripts/install.sh` does not write this snippet for you — hooks are
opt-in and can be scoped per-project or user-wide, so wire it in wherever
makes sense for your setup.

### Configuration

| Env var | Default | Meaning |
|---|---|---|
| `JEV_SCOUT_LEDGER_DIR` | `~/.jev-scout` | Directory the hook appends `ledger-YYYY-MM-DD.jsonl` lines to (and, on parse failures, `hook-errors.log`). Set this if jev-scout's own ledger lives somewhere non-default. Created with `0700` permissions if it doesn't already exist; a pre-existing symlink at this path is refused (the hook exits `0` without writing) rather than followed. |

## Testing it standalone

```sh
echo '{"tool_name":"WebFetch","tool_input":{"url":"https://example.com"},"tool_response":{}}' \
  | JEV_SCOUT_LEDGER_DIR=/tmp/jev-scout-test hooks/jev-scout-observe.sh
cat /tmp/jev-scout-test/ledger-*.jsonl
```

Automated coverage lives in
[`test/hooks.test.ts`](../test/hooks.test.ts), which spawns this script
against fixture hook payloads (valid `WebFetch`/`WebSearch`, a long query
that should hash, malformed stdin, an unrelated tool name) and asserts on
the ledger lines it does or doesn't produce.
