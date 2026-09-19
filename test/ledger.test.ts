import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { contentHash, createLedger, type LedgerEvent } from "../src/ledger.ts";
import { tmpDir } from "./support.ts";

function readLines(dir: string): LedgerEvent[] {
  const files = fs.readdirSync(dir).filter((f) => f.startsWith("ledger-") && f.endsWith(".jsonl"));
  assert.equal(files.length, 1, "expected exactly one ledger file for today");
  const raw = fs.readFileSync(path.join(dir, files[0]!), "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as LedgerEvent);
}

test("dir is created on demand and lines parse as JSON carrying search_id", () => {
  const dir = path.join(tmpDir("ledger"), "nested", "does-not-exist-yet");
  assert.equal(fs.existsSync(dir), false);

  const ledger = createLedger(dir);
  ledger.append({
    session: "sess-1",
    search_id: "search-abc",
    type: "search",
    payload: { query: "weather today" },
  });

  assert.equal(fs.existsSync(dir), true);
  const lines = readLines(dir);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.search_id, "search-abc");
  assert.equal(lines[0]!.type, "search");
  assert.equal(typeof lines[0]!.ts, "string");
});

test("page content is hashed, never logged raw — contentHash appears, raw text does not", () => {
  const dir = tmpDir("ledger");
  const ledger = createLedger(dir);
  const pageText = "SECRET RAW PAGE BODY that must never reach the ledger file";
  const hash = contentHash(pageText);

  ledger.append({
    session: "sess-1",
    search_id: "search-1",
    type: "fetch",
    payload: { url: "https://example.com/page", excerpt_hash: hash },
  });

  const raw = fs.readFileSync(
    path.join(dir, fs.readdirSync(dir).find((f) => f.startsWith("ledger-"))!),
    "utf8",
  );
  assert.ok(raw.includes(hash), "hash should be present");
  assert.ok(!raw.includes(pageText), "raw page body must never appear in the ledger file");
  assert.equal(hash.length, 64, "sha256 hex digest");
  assert.match(hash, /^[0-9a-f]{64}$/);
});

test("todaySpend sums jev.cost_usd across two separate createLedger instances (simulated restart)", () => {
  const dir = tmpDir("ledger");

  const first = createLedger(dir);
  first.append({
    session: "sess-1",
    search_id: "search-1",
    type: "result",
    payload: {},
    jev: { cost_usd: 0.0001, rubric_version: "1.0.0" },
  });
  first.append({
    session: "sess-1",
    search_id: "search-1",
    type: "result",
    payload: {},
    jev: { cost_usd: 0.0002, rubric_version: "1.0.0" },
  });

  // Simulate a process restart: a brand-new ledger instance, same dir, no
  // shared in-memory state with `first`.
  const second = createLedger(dir);
  second.append({
    session: "sess-2",
    search_id: "search-2",
    type: "result",
    payload: {},
    jev: { cost_usd: 0.0005, rubric_version: "1.0.0" },
  });

  // todaySpend() re-scans the file from disk, so both instances agree and
  // both see the full cumulative total, including events from "before" the
  // simulated restart.
  assert.ok(Math.abs(first.todaySpend() - 0.0008) < 1e-9);
  assert.ok(Math.abs(second.todaySpend() - 0.0008) < 1e-9);
});

test("todaySpend is 0 before any events (file does not exist yet)", () => {
  const ledger = createLedger(tmpDir("ledger"));
  assert.equal(ledger.todaySpend(), 0);
});

test("todaySpend ignores events with no jev field", () => {
  const dir = tmpDir("ledger");
  const ledger = createLedger(dir);
  ledger.append({ session: "s", search_id: "id", type: "gate", payload: { action: "drop" } });
  assert.equal(ledger.todaySpend(), 0);
});

test("size guard: past the byte cap, payload is omitted but counters/fields survive", () => {
  const dir = tmpDir("ledger");
  // Tiny injectable cap so the guard trips almost immediately.
  const ledger = createLedger(dir, { maxBytesPerDay: 200 });

  const bigPayload = { note: "x".repeat(500) };
  for (let i = 0; i < 5; i++) {
    ledger.append({
      session: "sess-1",
      search_id: `search-${i}`,
      type: "result",
      payload: bigPayload,
      jev: { cost_usd: 0.0001 },
    });
  }

  const lines = readLines(dir);
  assert.equal(lines.length, 5);
  assert.equal(
    (lines[0]!.payload as { note: string }).note,
    bigPayload.note,
    "first event fits under the cap",
  );

  const later = lines[lines.length - 1]!;
  assert.deepEqual(later.payload, { omitted: true }, "later event's payload is omitted");
  assert.equal(later.search_id, "search-4", "search_id survives omission");
  assert.equal(later.type, "result", "type survives omission");
  assert.equal(later.jev?.cost_usd, 0.0001, "jev cost survives omission — counters keep working");

  // todaySpend must still work correctly after the size guard kicks in,
  // since jev.cost_usd is preserved even when payload is omitted.
  assert.ok(ledger.todaySpend() > 0);
});

test("append emits an 'event' for each appended record, matching what was written", () => {
  const dir = tmpDir("ledger");
  const ledger = createLedger(dir);
  const seen: LedgerEvent[] = [];
  ledger.on("event", (record: LedgerEvent) => seen.push(record));

  const written = ledger.append({
    session: "sess-1",
    search_id: "search-1",
    type: "budget",
    payload: { limit: "calls" },
  });

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], written);
});

test("multiple appends each emit their own event, in order", () => {
  const dir = tmpDir("ledger");
  const ledger = createLedger(dir);
  const seenTypes: string[] = [];
  ledger.on("event", (record: LedgerEvent) => seenTypes.push(record.type));

  ledger.append({ session: "s", search_id: "1", type: "search", payload: {} });
  ledger.append({ session: "s", search_id: "1", type: "result", payload: {} });
  ledger.append({ session: "s", search_id: "1", type: "gate", payload: {} });

  assert.deepEqual(seenTypes, ["search", "result", "gate"]);
});
