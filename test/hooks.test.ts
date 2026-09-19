/**
 * Tests for hooks/jev-scout-observe.sh — the Claude Code PostToolUse hook
 * that gives passive ledger coverage to built-in WebSearch/WebFetch calls.
 *
 * These spawn the real shell script (not a reimplementation of it), feeding
 * fixture hook JSON on stdin and pointing JEV_SCOUT_LEDGER_DIR at a tmp dir,
 * exactly how Claude Code itself would invoke it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

import { tmpDir } from "./support.ts";

const HOOK_PATH = path.join(
  path.dirname(path.dirname(url.fileURLToPath(import.meta.url))),
  "hooks",
  "jev-scout-observe.sh",
);

function runHook(stdin: string, ledgerDir: string): { status: number | null; stderr: string } {
  const result = spawnSync("bash", [HOOK_PATH], {
    input: stdin,
    encoding: "utf8",
    env: { ...process.env, JEV_SCOUT_LEDGER_DIR: ledgerDir },
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

test("malformed stdin exits 0 and writes no ledger line", () => {
  const dir = tmpDir("hooks-malformed");
  const { status } = runHook("not valid json at all {", dir);
  assert.equal(status, 0);
  assert.deepEqual(ledgerLines(dir), []);
});

test("an unrelated tool_name (not WebSearch/WebFetch) writes no ledger line", () => {
  const dir = tmpDir("hooks-unrelated");
  const fixture = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command: "ls" },
    tool_response: { output: "..." },
  });

  const { status } = runHook(fixture, dir);
  assert.equal(status, 0);
  assert.deepEqual(ledgerLines(dir), []);
});

test("empty stdin exits 0 and writes no ledger line", () => {
  const dir = tmpDir("hooks-empty");
  const { status } = runHook("", dir);
  assert.equal(status, 0);
  assert.deepEqual(ledgerLines(dir), []);
});
