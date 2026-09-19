/**
 * Tests for hooks/jev-scout-observe.sh — the Claude Code PostToolUse hook
 * that gives passive ledger coverage to built-in WebSearch/WebFetch calls.
 *
 * These spawn the real shell script (not a reimplementation of it), feeding
 * fixture hook JSON on stdin and pointing JEV_SCOUT_LEDGER_DIR at a tmp dir,
 * exactly how Claude Code itself would invoke it.
 *
 * Both the jq path (default PATH) and the node-fallback path (PATH scrubbed
 * of jq) are exercised for the fixtures that matter security-wise, so a
 * regression in either parser is caught.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";

import { tmpDir } from "./support.ts";

const HOOK_PATH = path.join(
  path.dirname(path.dirname(url.fileURLToPath(import.meta.url))),
  "hooks",
  "jev-scout-observe.sh",
);

const BASH = "/bin/bash";

function which(bin: string): string | null {
  const result = spawnSync("/bin/bash", ["-c", `command -v ${bin}`], { encoding: "utf8" });
  const out = result.stdout.trim();
  return out.length > 0 ? out : null;
}

const HAS_JQ = which("jq") !== null;

/**
 * A PATH containing symlinks to every external command the hook script
 * needs (mkdir, date, tr, node, cat, rm, mktemp) but deliberately excluding
 * jq — used to force the node-fallback branch even on a machine that has jq
 * installed.
 */
let scrubbedPathDir: string | null = null;
function pathWithoutJq(): string {
  if (scrubbedPathDir) return scrubbedPathDir;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-scout-nojq-bin-"));
  for (const bin of ["mkdir", "date", "tr", "node", "cat", "rm", "mktemp"]) {
    const resolved = which(bin);
    if (resolved) {
      try {
        fs.symlinkSync(resolved, path.join(dir, bin));
      } catch {
        // ignore — best effort
      }
    }
  }
  scrubbedPathDir = dir;
  return dir;
}

function runHook(
  stdin: string,
  ledgerDir: string,
  opts: { forceNodeFallback?: boolean } = {},
): { status: number | null; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, JEV_SCOUT_LEDGER_DIR: ledgerDir };
  if (opts.forceNodeFallback) {
    env.PATH = pathWithoutJq();
  }
  const result = spawnSync(BASH, [HOOK_PATH], {
    input: stdin,
    encoding: "utf8",
    env,
  });
  return { status: result.status, stderr: result.stderr };
}

function ledgerLines(dir: string): Record<string, unknown>[] {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.startsWith("ledger-") && f.endsWith(".jsonl"));
  return files.flatMap((f) =>
    fs
      .readFileSync(path.join(dir, f), "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>),
  );
}

function errorLogLines(dir: string): string[] {
  const p = path.join(dir, "hook-errors.log");
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "");
}

// Run a fixture through both parser paths (or just jq's default path when
// forceBoth is false), returning a label -> result map for assertions.
function runBothPaths(stdin: string): { jq?: { dir: string; status: number | null }; node: { dir: string; status: number | null } } {
  const out: ReturnType<typeof runBothPaths> = { node: { dir: "", status: null } };
  if (HAS_JQ) {
    const dir = tmpDir("hooks-both-jq");
    const { status } = runHook(stdin, dir);
    out.jq = { dir, status };
  }
  const nodeDir = tmpDir("hooks-both-node");
  const { status: nodeStatus } = runHook(stdin, nodeDir, { forceNodeFallback: true });
  out.node = { dir: nodeDir, status: nodeStatus };
  return out;
}

// ---------------------------------------------------------------------
// Basic behavior (default PATH — exercises whichever parser is present,
// which is jq on any dev/CI machine with jq installed)
// ---------------------------------------------------------------------

test("WebFetch fixture appends exactly one valid ledger line with the expected fields, exit 0", () => {
  const dir = tmpDir("hooks-webfetch");
  const fixture = JSON.stringify({
    session_id: "test-session",
    transcript_path: "/tmp/transcript.jsonl",
    cwd: "/tmp",
    hook_event_name: "PostToolUse",
    tool_name: "WebFetch",
    tool_input: { url: "https://example.com/docs/page", prompt: "summarize this" },
    tool_response: { result: "page content that must never be logged" },
  });

  const { status } = runHook(fixture, dir);
  assert.equal(status, 0);

  const lines = ledgerLines(dir);
  assert.equal(lines.length, 1);
  const line = lines[0]!;

  assert.equal(typeof line.ts, "string");
  assert.equal(line.session, "hook");
  assert.equal(typeof line.search_id, "string");
  assert.equal(line.type, "fetch");

  const payload = line.payload as Record<string, unknown>;
  assert.equal(payload.source, "claude-code-hook");
  assert.equal(payload.tool_name, "WebFetch");
  assert.equal(payload.url_or_query, "https://example.com/docs/page");
  assert.equal(payload.ok, true);

  // Page content must never reach the ledger — metadata only.
  const raw = JSON.stringify(line);
  assert.ok(!raw.includes("page content that must never be logged"));
});

test("WebSearch fixture appends a search-type line with the query as url_or_query", () => {
  const dir = tmpDir("hooks-websearch");
  const fixture = JSON.stringify({
    hook_event_name: "PostToolUse",
    tool_name: "WebSearch",
    tool_input: { query: "jev-scout mcp observability" },
    tool_response: { results: [] },
  });

  const { status } = runHook(fixture, dir);
  assert.equal(status, 0);

  const lines = ledgerLines(dir);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.type, "search");
  const payload = lines[0]!.payload as Record<string, unknown>;
  assert.equal(payload.tool_name, "WebSearch");
  assert.equal(payload.url_or_query, "jev-scout mcp observability");
  assert.equal(payload.ok, true);
});

test("a long query is hashed rather than stored raw", () => {
  const dir = tmpDir("hooks-hash");
  const longQuery = "q".repeat(400);
  const fixture = JSON.stringify({
    tool_name: "WebSearch",
    tool_input: { query: longQuery },
    tool_response: {},
  });

  const { status } = runHook(fixture, dir);
  assert.equal(status, 0);

  const lines = ledgerLines(dir);
  assert.equal(lines.length, 1);
  const payload = lines[0]!.payload as Record<string, unknown>;
  const value = payload.url_or_query as string;
  assert.ok(!value.includes(longQuery), "raw long query must not appear in the ledger line");
  assert.match(value, /^sha256:[0-9a-f]{64}$/);
});

test("malformed stdin exits 0, writes no ledger line, and logs one diagnostic line", () => {
  const dir = tmpDir("hooks-malformed");
  const { status } = runHook("not valid json at all {", dir);
  assert.equal(status, 0);
  assert.deepEqual(ledgerLines(dir), []);
  const errLines = errorLogLines(dir);
  assert.equal(errLines.length, 1);
  assert.ok(!errLines[0]!.includes("\n"));
});

test("an unrelated tool_name (not WebSearch/WebFetch) writes no ledger line and no diagnostic", () => {
  const dir = tmpDir("hooks-unrelated");
  const fixture = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command: "ls" },
    tool_response: { output: "..." },
  });

  const { status } = runHook(fixture, dir);
  assert.equal(status, 0);
  assert.deepEqual(ledgerLines(dir), []);
  assert.deepEqual(errorLogLines(dir), []);
});

test("empty stdin exits 0 and writes no ledger line", () => {
  const dir = tmpDir("hooks-empty");
  const { status } = runHook("", dir);
  assert.equal(status, 0);
  assert.deepEqual(ledgerLines(dir), []);
});

// ---------------------------------------------------------------------
// tool_response shape robustness (finding: total jq/node probe)
// ---------------------------------------------------------------------

for (const shape of [
  { label: "string", value: "totally broken" },
  { label: "array", value: [1, 2, 3] },
]) {
  test(`tool_response as a ${shape.label} does not crash the parser — exactly one line, ok:true`, () => {
    const fixture = JSON.stringify({
      tool_name: "WebSearch",
      tool_input: { query: `resp-is-${shape.label}` },
      tool_response: shape.value,
    });
    const results = runBothPaths(fixture);
    for (const [label, r] of Object.entries(results)) {
      if (!r) continue;
      assert.equal(r.status, 0, `${label} path exit status`);
      const lines = ledgerLines(r.dir);
      assert.equal(lines.length, 1, `${label} path line count`);
      const payload = lines[0]!.payload as Record<string, unknown>;
      assert.equal(payload.ok, true, `${label} path ok flag`);
      assert.equal(payload.url_or_query, `resp-is-${shape.label}`);
    }
  });
}

// ---------------------------------------------------------------------
// Node fallback exercised directly (PATH scrubbed of jq)
// ---------------------------------------------------------------------

test("node fallback (PATH scrubbed of jq): WebFetch fixture behaves the same as the jq path", () => {
  const dir = tmpDir("hooks-nodefallback-fetch");
  const fixture = JSON.stringify({
    tool_name: "WebFetch",
    tool_input: { url: "https://example.com/docs/page" },
    tool_response: { result: "page content that must never be logged" },
  });

  const { status } = runHook(fixture, dir, { forceNodeFallback: true });
  assert.equal(status, 0);

  const lines = ledgerLines(dir);
  assert.equal(lines.length, 1);
  const line = lines[0]!;
  assert.equal(line.type, "fetch");
  const payload = line.payload as Record<string, unknown>;
  assert.equal(payload.tool_name, "WebFetch");
  assert.equal(payload.url_or_query, "https://example.com/docs/page");
  assert.equal(payload.ok, true);
  assert.ok(!JSON.stringify(line).includes("page content that must never be logged"));
});

test("node fallback: malformed stdin exits 0, writes no ledger line, and logs one diagnostic line", () => {
  const dir = tmpDir("hooks-nodefallback-malformed");
  const { status } = runHook("not valid json at all {", dir, { forceNodeFallback: true });
  assert.equal(status, 0);
  assert.deepEqual(ledgerLines(dir), []);
  const errLines = errorLogLines(dir);
  assert.equal(errLines.length, 1);
  assert.ok(!errLines[0]!.includes("\n"));
});

// ---------------------------------------------------------------------
// Adversarial query fixtures — tab, newline, double quote, command
// substitution, leading dash. None of these should ever be interpreted by
// the shell; the exact raw value must round-trip into the ledger line
// (assuming it's under the 300-char inline threshold).
// ---------------------------------------------------------------------

const ADVERSARIAL_QUERIES = [
  { label: "embedded tab", value: "weird\tquery\twith tabs" },
  { label: "embedded newline", value: "weird\nquery\nwith newlines" },
  { label: "double quote", value: 'a query with "quotes" in it' },
  { label: "command substitution", value: "$(touch /tmp/jev-scout-hook-pwned-marker) and `id`" },
  { label: "leading dash", value: "-rf / --no-preserve-root" },
];

for (const { label, value } of ADVERSARIAL_QUERIES) {
  test(`adversarial WebSearch query (${label}) round-trips exactly and injects nothing`, () => {
    const markerPath = "/tmp/jev-scout-hook-pwned-marker";
    try {
      fs.unlinkSync(markerPath);
    } catch {
      // ignore — may not exist
    }

    const fixture = JSON.stringify({
      tool_name: "WebSearch",
      tool_input: { query: value },
      tool_response: {},
    });

    const results = runBothPaths(fixture);
    for (const [pathLabel, r] of Object.entries(results)) {
      if (!r) continue;
      assert.equal(r.status, 0, `${pathLabel} path exit status`);
      const lines = ledgerLines(r.dir);
      assert.equal(lines.length, 1, `${pathLabel} path line count for ${label}`);
      const payload = lines[0]!.payload as Record<string, unknown>;
      assert.equal(payload.url_or_query, value, `${pathLabel} path value fidelity for ${label}`);
    }

    assert.ok(!fs.existsSync(markerPath), "command substitution in a query must never execute");
  });
}

// ---------------------------------------------------------------------
// Credential / query-string redaction for WebFetch URLs
// ---------------------------------------------------------------------

const REDACTION_CASES = [
  {
    label: "userinfo (user:pass@)",
    url: "https://alice:hunter2@example.com/path/to/page",
    expected: "https://example.com/path/to/page",
  },
  {
    label: "query string with a token param",
    url: "https://example.com/search?token=SUPERSECRET&q=abc",
    expected: "https://example.com/search?<redacted>",
  },
  {
    label: "both userinfo and query string",
    url: "https://alice:hunter2@example.com/path?token=SUPERSECRET",
    expected: "https://example.com/path?<redacted>",
  },
  {
    label: "no credentials or query — unchanged",
    url: "https://example.com/plain/path",
    expected: "https://example.com/plain/path",
  },
];

for (const { label, url: fetchUrl, expected } of REDACTION_CASES) {
  test(`WebFetch URL redaction: ${label}`, () => {
    const fixture = JSON.stringify({
      tool_name: "WebFetch",
      tool_input: { url: fetchUrl },
      tool_response: {},
    });
    const results = runBothPaths(fixture);
    for (const [pathLabel, r] of Object.entries(results)) {
      if (!r) continue;
      assert.equal(r.status, 0);
      const lines = ledgerLines(r.dir);
      assert.equal(lines.length, 1, `${pathLabel} path line count`);
      const payload = lines[0]!.payload as Record<string, unknown>;
      assert.equal(payload.url_or_query, expected, `${pathLabel} path redaction for ${label}`);
      assert.ok(!(payload.url_or_query as string).includes("hunter2"), `${pathLabel} path must never leak the password`);
      assert.ok(!(payload.url_or_query as string).includes("SUPERSECRET"), `${pathLabel} path must never leak the token`);
    }
  });
}

test("WebSearch queries are NOT run through URL redaction — a URL-shaped query stays raw (below the hash threshold)", () => {
  const query = "http://alice:hunter2@example.com/?token=SUPERSECRET";
  const fixture = JSON.stringify({
    tool_name: "WebSearch",
    tool_input: { query },
    tool_response: {},
  });
  const dir = tmpDir("hooks-search-not-redacted");
  const { status } = runHook(fixture, dir);
  assert.equal(status, 0);
  const lines = ledgerLines(dir);
  assert.equal(lines.length, 1);
  const payload = lines[0]!.payload as Record<string, unknown>;
  assert.equal(payload.url_or_query, query);
});

// ---------------------------------------------------------------------
// 300/301-char boundary for the inline-vs-hash rule
// ---------------------------------------------------------------------

test("a 300-char query is stored raw (inline threshold is inclusive)", () => {
  const query = "q".repeat(300);
  const fixture = JSON.stringify({ tool_name: "WebSearch", tool_input: { query }, tool_response: {} });
  const results = runBothPaths(fixture);
  for (const [pathLabel, r] of Object.entries(results)) {
    if (!r) continue;
    assert.equal(r.status, 0);
    const lines = ledgerLines(r.dir);
    assert.equal(lines.length, 1, pathLabel);
    const payload = lines[0]!.payload as Record<string, unknown>;
    assert.equal(payload.url_or_query, query, `${pathLabel} path: 300-char boundary must stay raw`);
  }
});

test("a 301-char query is hashed (just past the inline threshold)", () => {
  const query = "q".repeat(301);
  const fixture = JSON.stringify({ tool_name: "WebSearch", tool_input: { query }, tool_response: {} });
  const results = runBothPaths(fixture);
  for (const [pathLabel, r] of Object.entries(results)) {
    if (!r) continue;
    assert.equal(r.status, 0);
    const lines = ledgerLines(r.dir);
    assert.equal(lines.length, 1, pathLabel);
    const payload = lines[0]!.payload as Record<string, unknown>;
    const value = payload.url_or_query as string;
    assert.match(value, /^sha256:[0-9a-f]{64}$/, `${pathLabel} path: 301-char boundary must hash`);
  }
});

// ---------------------------------------------------------------------
// jq vs. node: identical output for the same input (modulo ts/search_id,
// which are inherently time/pid dependent). Skipped gracefully if this
// machine has no jq.
// ---------------------------------------------------------------------

test("jq and node paths produce identical ledger lines for the same input", { skip: !HAS_JQ }, () => {
  const fixture = JSON.stringify({
    tool_name: "WebFetch",
    tool_input: { url: "https://alice:hunter2@example.com/path?token=SECRET&x=1" },
    tool_response: { is_error: false },
  });

  const jqDir = tmpDir("hooks-parity-jq");
  const nodeDir = tmpDir("hooks-parity-node");
  const jqRes = runHook(fixture, jqDir);
  const nodeRes = runHook(fixture, nodeDir, { forceNodeFallback: true });
  assert.equal(jqRes.status, 0);
  assert.equal(nodeRes.status, 0);

  const jqLine = ledgerLines(jqDir)[0]!;
  const nodeLine = ledgerLines(nodeDir)[0]!;

  assert.match(jqLine.ts as string, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
  assert.match(nodeLine.ts as string, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
  assert.match(jqLine.search_id as string, /^hook-\d+-\d+-\d+$/);
  assert.match(nodeLine.search_id as string, /^hook-\d+-\d+-\d+$/);

  // Normalize the inherently non-deterministic fields before comparing.
  const normalize = (l: Record<string, unknown>) => ({ ...l, ts: "TS", search_id: "ID" });
  assert.deepEqual(normalize(jqLine), normalize(nodeLine));
});

// ---------------------------------------------------------------------
// Ledger dir hardening: symlink refusal, unwritable dir, permissions
// ---------------------------------------------------------------------

test("a symlinked JEV_SCOUT_LEDGER_DIR is refused: exit 0, no ledger file written through it", () => {
  const parent = tmpDir("hooks-symlink-parent");
  const target = tmpDir("hooks-symlink-target");
  const linkPath = path.join(parent, "ledger-link");
  fs.symlinkSync(target, linkPath);

  const fixture = JSON.stringify({ tool_name: "WebSearch", tool_input: { query: "hi" }, tool_response: {} });
  const { status } = runHook(fixture, linkPath);
  assert.equal(status, 0);

  // Nothing should have been written through the symlink into the target dir.
  assert.deepEqual(ledgerLines(target), []);
  const targetFiles = fs.readdirSync(target);
  assert.deepEqual(targetFiles, []);
});

test("an unwritable JEV_SCOUT_LEDGER_DIR exits 0 with no partial write", () => {
  const dir = tmpDir("hooks-unwritable");
  fs.chmodSync(dir, 0o500); // read+execute, no write, for the owner

  try {
    const fixture = JSON.stringify({ tool_name: "WebSearch", tool_input: { query: "hi" }, tool_response: {} });
    const { status } = runHook(fixture, dir);
    assert.equal(status, 0);

    const files = fs.readdirSync(dir).filter((f) => f.startsWith("ledger-"));
    assert.deepEqual(files, []);
  } finally {
    fs.chmodSync(dir, 0o700); // restore so the test runner can clean it up
  }
});

test("a freshly created ledger dir is chmod 700", () => {
  const parent = tmpDir("hooks-newdir-parent");
  const freshDir = path.join(parent, "fresh-ledger-dir");
  assert.ok(!fs.existsSync(freshDir));

  const fixture = JSON.stringify({ tool_name: "WebSearch", tool_input: { query: "hi" }, tool_response: {} });
  const { status } = runHook(fixture, freshDir);
  assert.equal(status, 0);

  assert.ok(fs.existsSync(freshDir));
  const mode = fs.statSync(freshDir).mode & 0o777;
  assert.equal(mode, 0o700);
});
