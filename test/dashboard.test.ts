import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import { fileURLToPath } from "node:url";

import { createLedger, type Ledger } from "../src/ledger.ts";
import { startDashboard } from "../src/dashboard.ts";
import { tmpDir } from "./support.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeLedger(): Ledger {
  return createLedger(tmpDir("dashboard"));
}

interface SSEMessage {
  readonly id?: string;
  readonly data: string;
}

interface SSEConn {
  readonly res: http.IncomingMessage;
  waitForEvents(count: number, timeoutMs?: number): Promise<SSEMessage[]>;
  destroy(): void;
}

/** Parse complete "id: X\ndata: Y\n\n" blocks out of a growing SSE buffer,
 * returning parsed messages (skipping heartbeat comment lines) and the
 * unparsed remainder to keep buffering. */
function parseSSEChunk(buffer: string): { events: SSEMessage[]; rest: string } {
  const events: SSEMessage[] = [];
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  for (const part of parts) {
    if (part.trim() === "" || part.startsWith(":")) continue;
    let id: string | undefined;
    let data = "";
    for (const line of part.split("\n")) {
      if (line.startsWith("id: ")) id = line.slice(4);
      else if (line.startsWith("data: ")) data = line.slice(6);
    }
    events.push({ id, data });
  }
  return { events, rest };
}

function connectSSE(url: string, headers: Record<string, string> = {}): Promise<SSEConn> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { headers }, (res) => {
      const received: SSEMessage[] = [];
      let buf = "";
      const waiters: { count: number; resolve: (v: SSEMessage[]) => void }[] = [];

      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buf += chunk;
        const parsed = parseSSEChunk(buf);
        buf = parsed.rest;
        for (const e of parsed.events) received.push(e);
        for (let i = waiters.length - 1; i >= 0; i--) {
          const w = waiters[i]!;
          if (received.length >= w.count) {
            w.resolve(received.slice(0, w.count));
            waiters.splice(i, 1);
          }
        }
      });

      resolve({
        res,
        waitForEvents(count: number, timeoutMs = 2000): Promise<SSEMessage[]> {
          if (received.length >= count) return Promise.resolve(received.slice(0, count));
          return new Promise((res2, rej2) => {
            const timer = setTimeout(() => rej2(new Error("timeout waiting for SSE events")), timeoutMs);
            waiters.push({
              count,
              resolve: (v) => {
                clearTimeout(timer);
                res2(v);
              },
            });
          });
        },
        destroy(): void {
          req.destroy();
        },
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("SSE replays the ring buffer to a late-joining client", async () => {
  const ledger = makeLedger();
  const dash = await startDashboard(ledger, { port: 0 });
  try {
    for (let i = 0; i < 3; i++) {
      ledger.append({ session: "s", search_id: `search-${i}`, type: "search", payload: { query: `q${i}` } });
    }
    const conn = await connectSSE(`${dash.url}/events`);
    const events = await conn.waitForEvents(3);
    assert.equal(events.length, 3);
    const parsed = events.map((e) => JSON.parse(e.data));
    assert.deepEqual(
      parsed.map((p) => p.search_id),
      ["search-0", "search-1", "search-2"],
    );
    conn.destroy();
  } finally {
    await dash.close();
  }
});

test("a new ledger event reaches an already-connected SSE client", async () => {
  const ledger = makeLedger();
  const dash = await startDashboard(ledger, { port: 0 });
  try {
    const conn = await connectSSE(`${dash.url}/events`);
    ledger.append({ session: "s", search_id: "search-live", type: "search", payload: { query: "live" } });
    const events = await conn.waitForEvents(1);
    const parsed = JSON.parse(events[0]!.data);
    assert.equal(parsed.search_id, "search-live");
    conn.destroy();
  } finally {
    await dash.close();
  }
});

test("the ring buffer is bounded at 200 events", async () => {
  const ledger = makeLedger();
  const dash = await startDashboard(ledger, { port: 0 });
  try {
    for (let i = 0; i < 210; i++) {
      ledger.append({ session: "s", search_id: `search-${i}`, type: "search", payload: { query: `q${i}` } });
    }
    const conn = await connectSSE(`${dash.url}/events`);
    const events = await conn.waitForEvents(200);
    assert.equal(events.length, 200);
    const firstId = Number(events[0]!.id);
    assert.ok(firstId > 10, `expected first replayed id > 10, got ${firstId}`);
    conn.destroy();
  } finally {
    await dash.close();
  }
});

test("Last-Event-ID resumes replay strictly after the given id", async () => {
  const ledger = makeLedger();
  const dash = await startDashboard(ledger, { port: 0 });
  try {
    for (let i = 0; i < 10; i++) {
      ledger.append({ session: "s", search_id: `search-${i}`, type: "search", payload: { query: `q${i}` } });
    }
    const conn = await connectSSE(`${dash.url}/events`, { "Last-Event-ID": "5" });
    const events = await conn.waitForEvents(5);
    assert.equal(events.length, 5);
    assert.equal(Number(events[0]!.id), 6);
    assert.equal(Number(events[4]!.id), 10);
    conn.destroy();
  } finally {
    await dash.close();
  }
});

test("port 0 binds an ephemeral port and the returned url reflects the real port", async () => {
  const ledger = makeLedger();
  const dash = await startDashboard(ledger, { port: 0 });
  try {
    const match = dash.url.match(/^http:\/\/127\.0\.0\.1:(\d+)$/);
    assert.ok(match, `url should be http://127.0.0.1:<port>, got ${dash.url}`);
    assert.notEqual(match![1], "0");
  } finally {
    await dash.close();
  }
});

test("/api/summary is valid zeroed JSON before any events, and aggregates correctly after", async () => {
  const ledger = makeLedger();
  const dash = await startDashboard(ledger, { port: 0 });
  try {
    const before = (await fetch(`${dash.url}/api/summary`).then((r) => r.json())) as {
      totalCostUsd: number;
      jevCallCount: number;
      domains: unknown[];
      sessionStartTs: string;
      eventCounts: Record<string, number>;
      lastEventId: number;
    };
    assert.equal(before.totalCostUsd, 0);
    assert.equal(before.jevCallCount, 0);
    assert.deepEqual(before.domains, []);
    assert.equal(typeof before.sessionStartTs, "string");
    assert.equal(before.lastEventId, 0);
    assert.equal(before.eventCounts.result, 0);

    ledger.append({
      session: "s",
      search_id: "search-1",
      type: "result",
      payload: {
        url: "https://docs.example.com/a",
        domain: "docs.example.com",
        rank: 0,
        cache_hit: false,
        scored: true,
        action: "pass",
        relevance: 2,
        credibility: 1.8,
        worth_fetching: 0.9,
      },
      jev: { cost_usd: 0.0001, rubric_version: "1.0.0" },
    });
    ledger.append({
      session: "s",
      search_id: "search-1",
      type: "result",
      payload: {
        url: "https://spam.example.com/b",
        domain: "spam.example.com",
        rank: 1,
        cache_hit: false,
        scored: true,
        action: "pass",
        relevance: 0.5,
        credibility: 0.2,
        worth_fetching: 0.1,
      },
      jev: { cost_usd: 0.0002, rubric_version: "1.0.0" },
    });

    const after = (await fetch(`${dash.url}/api/summary`).then((r) => r.json())) as {
      totalCostUsd: number;
      jevCallCount: number;
      eventCounts: Record<string, number>;
      domains: Array<{ domain: string; judgments: number; meanCredibility: number; lowCredibilityHits: number }>;
    };
    assert.ok(Math.abs(after.totalCostUsd - 0.0003) < 1e-9);
    assert.equal(after.jevCallCount, 2);
    assert.equal(after.eventCounts.result, 2);
    assert.equal(after.domains.length, 2);
    const spam = after.domains.find((d) => d.domain === "spam.example.com")!;
    assert.equal(spam.judgments, 1);
    assert.equal(spam.lowCredibilityHits, 1);
    assert.ok(Math.abs(spam.meanCredibility - 0.2) < 1e-9);
    const docs = after.domains.find((d) => d.domain === "docs.example.com")!;
    assert.equal(docs.lowCredibilityHits, 0);
  } finally {
    await dash.close();
  }
});

test('Host header "evil.example:1234" is rejected with 403; the correct Host succeeds', async () => {
  const ledger = makeLedger();
  const dash = await startDashboard(ledger, { port: 0 });
  try {
    const evilStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = http.request(dash.url, { headers: { Host: "evil.example:1234" } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(evilStatus, 403);

    // Also verify the "localhost" hostname variant is rejected, per the
    // dashboard.ts doc comment: only 127.0.0.1:<port> is accepted, on
    // purpose (DNS-rebinding defense), even though it's a common alias.
    const port = new URL(dash.url).port;
    const localhostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = http.request(dash.url, { headers: { Host: `localhost:${port}` } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(localhostStatus, 403);

    const goodRes = await fetch(`${dash.url}/`);
    assert.equal(goodRes.status, 200);
  } finally {
    await dash.close();
  }
});

test("close() destroys a connected SSE client's socket and the server stops accepting new connections", async () => {
  const ledger = makeLedger();
  const dash = await startDashboard(ledger, { port: 0 });
  const conn = await connectSSE(`${dash.url}/events`);

  const socketClosed = new Promise<void>((resolve) => {
    conn.res.on("close", resolve);
  });

  await dash.close();
  await socketClosed;

  await assert.rejects(
    () =>
      new Promise<void>((resolve, reject) => {
        const req = http.request(dash.url, { timeout: 500 }, () => resolve());
        req.on("error", reject);
        req.on("timeout", () => {
          req.destroy();
          reject(new Error("connection attempt timed out instead of being refused"));
        });
        req.end();
      }),
    /ECONNREFUSED|ECONNRESET/,
  );
});

test("a <script> result title never appears server-side interpolated into GET /, and dashboard.html only uses safe DOM APIs", async () => {
  const ledger = makeLedger();
  const dash = await startDashboard(ledger, { port: 0 });
  try {
    ledger.append({
      session: "s",
      search_id: "search-xss",
      type: "result",
      payload: {
        url: "https://evil.example/x",
        domain: "evil.example",
        rank: 0,
        cache_hit: false,
        scored: true,
        action: "pass",
        title: "<script>alert(1)</script>",
      },
    });

    const html = await fetch(`${dash.url}/`).then((r) => r.text());
    assert.ok(
      !html.includes("<script>alert(1)</script>"),
      "the served HTML must never interpolate ledger-derived data server-side",
    );
    assert.ok(html.includes("<title>jev-scout dashboard</title>"), "should still serve the static dashboard shell");
  } finally {
    await dash.close();
  }

  const htmlPath = fileURLToPath(new URL("../src/dashboard.html", import.meta.url));
  const source = fs.readFileSync(htmlPath, "utf8");
  assert.doesNotMatch(
    source,
    /innerHTML|insertAdjacentHTML|outerHTML\s*=/,
    "dashboard.html must never build DOM from backend-derived strings via innerHTML/insertAdjacentHTML/outerHTML",
  );
  assert.match(source, /textContent/, "dashboard.html should insert backend-derived strings via textContent");
});
