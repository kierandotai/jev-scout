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
   line at all.
4. Exits `0` unconditionally — a hook must never block the tool call it's
   observing, so every failure path (bad JSON, missing `jq`, a ledger write
   error) is swallowed rather than surfaced as a nonzero exit.

Parsing prefers `jq` when it's on `PATH`, and falls back to `node` (already
a jev-scout prerequisite) when it isn't — either way the JSON line it writes
is escaped correctly.

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
| `JEV_SCOUT_LEDGER_DIR` | `~/.jev-scout` | Directory the hook appends `ledger-YYYY-MM-DD.jsonl` lines to. Set this if jev-scout's own ledger lives somewhere non-default. |

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
