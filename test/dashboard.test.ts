import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
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

// ---------------------------------------------------------------------------
// Item 7 (consumer side): a refused fetch event's full payload (including
// ok:false and reason) reaches an SSE client, and a "budget" event is
// counted in /api/summary's eventCounts.
// ---------------------------------------------------------------------------

test("a refused fetch event (payload.ok === false) reaches an SSE client with its reason and detail intact", async () => {
  const ledger = makeLedger();
  const dash = await startDashboard(ledger, { port: 0 });
  try {
    const conn = await connectSSE(`${dash.url}/events`);
    ledger.append({
      session: "s",
      search_id: "search-refused",
      type: "fetch",
      payload: {
        url: "https://spamfarm.example/article",
        goal: "check the claim",
        ok: false,
        reason: "gate_refused",
        detail: 'domain "spamfarm.example" has a cached credibility score of 0.20, below the gate threshold 1',
      },
    });
    const events = await conn.waitForEvents(1);
    const parsed = JSON.parse(events[0]!.data) as {
      type: string;
      payload: { ok: boolean; reason: string; detail: string; url: string };
    };
    assert.equal(parsed.type, "fetch");
    assert.equal(parsed.payload.ok, false);
    assert.equal(parsed.payload.reason, "gate_refused");
    assert.match(parsed.payload.detail, /spamfarm\.example/);
    assert.equal(parsed.payload.url, "https://spamfarm.example/article");
    conn.destroy();
  } finally {
    await dash.close();
  }
});

test("a 'budget' ledger event is counted in /api/summary's eventCounts", async () => {
  const ledger = makeLedger();
  const dash = await startDashboard(ledger, { port: 0 });
  try {
    const before = (await fetch(`${dash.url}/api/summary`).then((r) => r.json())) as {
      eventCounts: Record<string, number>;
    };
    assert.equal(before.eventCounts.budget, 0);

    ledger.append({
      session: "s",
      search_id: "search-budget",
      type: "budget",
      payload: { limit: "calls", callsUsed: 300, spendUsd: 0.021 },
    });

    const after = (await fetch(`${dash.url}/api/summary`).then((r) => r.json())) as {
      eventCounts: Record<string, number>;
    };
    assert.equal(after.eventCounts.budget, 1);
  } finally {
    await dash.close();
  }
});

// ---------------------------------------------------------------------------
// F15: process-exit regression — the dashboard's listener and every accepted
// socket must be unref'd, so a live dashboard with an open SSE client never
// blocks the process from exiting on its own (the U7 socket-unref scenario,
// tested end-to-end via a real child process rather than just asserting the
// `.unref()` call sites exist).
// ---------------------------------------------------------------------------

test("process-exit regression: a dashboard with a live SSE client never blocks the process from exiting", async () => {
  const fixtureDir = tmpDir("f15-fixture");
  const ledgerDir = path.join(fixtureDir, "ledger");
  const scriptPath = path.join(fixtureDir, "child.ts");

  const ledgerModulePath = fileURLToPath(new URL("../src/ledger.ts", import.meta.url));
  const dashboardModulePath = fileURLToPath(new URL("../src/dashboard.ts", import.meta.url));

  // A nearby package.json with "type": "module" makes Node treat this .ts
  // entry as ESM (mirrors this repo's own package.json), so top-level
  // `import`/`await` work without any bundling step.
  fs.writeFileSync(path.join(fixtureDir, "package.json"), JSON.stringify({ type: "module" }), "utf8");

  const script = [
    `import { createLedger } from ${JSON.stringify(ledgerModulePath)};`,
    `import { startDashboard } from ${JSON.stringify(dashboardModulePath)};`,
    "",
    `const ledger = createLedger(${JSON.stringify(ledgerDir)});`,
    "const dash = await startDashboard(ledger, { port: 0 });",
    "process.stdout.write(JSON.stringify({ url: dash.url }) + \"\\n\");",
    "",
    "// Keep the event loop alive — like the real stdio MCP transport does by",
    "// listening on stdin — until the parent ends stdin. This is the only",
    "// thing standing between this process and exiting; no process.exit() is",
    "// ever called. The regression under test is that the dashboard's own",
    "// (unref'd) listener and sockets must NOT be an additional such anchor:",
    "// once stdin ends, the process must exit on its own even with a live SSE",
    "// client still connected.",
    "process.stdin.resume();",
    "process.stdin.on(\"end\", () => {});",
    "",
  ].join("\n");
  fs.writeFileSync(scriptPath, script, "utf8");

  const child = spawn(process.execPath, ["--experimental-strip-types", scriptPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderrBuf = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString("utf8");
  });

  const url = await new Promise<string>((resolve, reject) => {
    let stdoutBuf = "";
    const timer = setTimeout(() => {
      reject(new Error(`child never printed its dashboard URL; stderr:\n${stderrBuf}`));
    }, 5000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
      const nl = stdoutBuf.indexOf("\n");
      if (nl === -1) return;
      clearTimeout(timer);
      try {
        resolve((JSON.parse(stdoutBuf.slice(0, nl)) as { url: string }).url);
      } catch (err) {
        reject(err as Error);
      }
    });
    child.on("error", reject);
  });

  const conn = await connectSSE(`${url}/events`);

  // Mirrors an MCP client disconnecting: end the child's stdin. The fixture
  // never reads it, so this is not itself what lets the child exit — it
  // only stands in for "nothing is holding this process open from outside."
  child.stdin.end();

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `child did not exit within 5s with a live SSE connection still open — ` +
            `dashboard resources may not be properly unref'd; stderr:\n${stderrBuf}`,
        ),
      );
    }, 5000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  conn.destroy();
  assert.equal(exitCode, 0);
});

// ---------------------------------------------------------------------------
// "used vs gated" panel (deferred 4th panel): the /api/summary `gating`
// aggregate, and live SSE delivery of the "gate" events that feed it.
// ---------------------------------------------------------------------------

test("gating aggregate in /api/summary reflects a mix of pass/drop/truncation/pre-fetch-refusal events", async () => {
  const ledger = makeLedger();
  const dash = await startDashboard(ledger, { port: 0 });
  try {
    const before = (await fetch(`${dash.url}/api/summary`).then((r) => r.json())) as {
      gating: { used: number; gated: number; byReason: Record<string, number> };
    };
    assert.deepEqual(before.gating, { used: 0, gated: 0, byReason: {} });

    // Two results actually passed to the agent.
    ledger.append({
      session: "s",
      search_id: "search-1",
      type: "result",
      payload: {
        url: "https://a.example/1",
        domain: "a.example",
        rank: 0,
        cache_hit: false,
        scored: true,
        action: "pass",
      },
    });
    ledger.append({
      session: "s",
      search_id: "search-1",
      type: "result",
      payload: {
        url: "https://b.example/1",
        domain: "b.example",
        rank: 1,
        cache_hit: false,
        scored: true,
        action: "pass",
      },
    });

    // A threshold drop: both relevance and credibility below threshold —
    // the "result" event with action: "drop" plus the paired "gate" event,
    // mirroring pipeline.ts's runSearch.
    ledger.append({
      session: "s",
      search_id: "search-1",
      type: "result",
      payload: {
        url: "https://spam.example/x",
        domain: "spam.example",
        rank: 2,
        cache_hit: false,
        scored: true,
        action: "drop",
      },
    });
    ledger.append({
      session: "s",
      search_id: "search-1",
      type: "gate",
      payload: {
        url: "https://spam.example/x",
        domain: "spam.example",
        reasons: [
          "relevance 0.30 is below the gate threshold 0.5",
          "credibility 0.20 is below the gate threshold 1",
        ],
      },
    });

    // Beyond-judge-cap truncation, aggregated per search (pipeline.ts gate
    // mode: one "gate" event carrying dropped_beyond_cap).
    ledger.append({
      session: "s",
      search_id: "search-1",
      type: "gate",
      payload: { dropped_beyond_cap: 3 },
    });

    // A pre-fetch refusal (guarded_fetch's preFetchGate check, no network).
    ledger.append({
      session: "s",
      search_id: "search-2",
      type: "gate",
      payload: {
        url: "https://spamfarm.example/y",
        domain: "spamfarm.example",
        goal: "check the claim",
        reason: 'domain "spamfarm.example" has a cached credibility score of 0.20, below the gate threshold 1',
      },
    });

    const after = (await fetch(`${dash.url}/api/summary`).then((r) => r.json())) as {
      gating: { used: number; gated: number; byReason: Record<string, number> };
      // Existing fields must stay intact alongside the new `gating` field.
      totalCostUsd: number;
      jevCallCount: number;
      domains: unknown[];
      eventCounts: Record<string, number>;
    };
    assert.equal(after.gating.used, 2);
    assert.equal(after.gating.gated, 1 + 3 + 1);
    assert.deepEqual(after.gating.byReason, {
      low_relevance: 1,
      low_credibility: 1,
      judge_cap_unjudged: 3,
      pre_fetch_refused: 1,
    });
    // Existing summary fields are unaffected by the new aggregate.
    assert.equal(after.totalCostUsd, 0);
    assert.equal(after.jevCallCount, 0);
    assert.equal(after.eventCounts.gate, 3);
  } finally {
    await dash.close();
  }
});

test("a late-joining dashboard's /api/summary gating aggregate matches events that occurred before any client connected", async () => {
  const ledger = makeLedger();
  const dash = await startDashboard(ledger, { port: 0 });
  try {
    // Events fire before any browser/SSE client ever subscribes -- exactly
    // the scenario the /api/summary seed exists to cover.
    ledger.append({
      session: "s",
      search_id: "search-1",
      type: "result",
      payload: {
        url: "https://ok.example/1",
        domain: "ok.example",
        rank: 0,
        cache_hit: false,
        scored: true,
        action: "pass",
      },
    });
    ledger.append({
      session: "s",
      search_id: "search-1",
      type: "gate",
      payload: {
        url: "https://bad.example/1",
        domain: "bad.example",
        reasons: ["relevance 0.10 is below the gate threshold 0.5"],
      },
    });

    const summary = (await fetch(`${dash.url}/api/summary`).then((r) => r.json())) as {
      gating: { used: number; gated: number; byReason: Record<string, number> };
    };
    assert.equal(summary.gating.used, 1);
    assert.equal(summary.gating.gated, 1);
    assert.deepEqual(summary.gating.byReason, { low_relevance: 1 });
  } finally {
    await dash.close();
  }
});

test("annotate-mode session (no drops) reports a zeroed gating aggregate", async () => {
  const ledger = makeLedger();
  const dash = await startDashboard(ledger, { port: 0 });
  try {
    ledger.append({
      session: "s",
      search_id: "search-1",
      type: "result",
      payload: {
        url: "https://a.example/1",
        domain: "a.example",
        rank: 0,
        cache_hit: false,
        scored: true,
        action: "pass",
      },
    });
    ledger.append({
      session: "s",
      search_id: "search-1",
      type: "result",
      payload: {
        url: "https://b.example/1",
        domain: "b.example",
        rank: 1,
        cache_hit: false,
        scored: false,
        action: "pass",
        judge_skipped: "judge_cap",
      },
    });

    const summary = (await fetch(`${dash.url}/api/summary`).then((r) => r.json())) as {
      gating: { used: number; gated: number; byReason: Record<string, number> };
    };
    assert.equal(summary.gating.used, 2);
    assert.equal(summary.gating.gated, 0);
    assert.deepEqual(summary.gating.byReason, {});
  } finally {
    await dash.close();
  }
});

test("a threshold-drop 'gate' event streamed live reaches an already-connected SSE client with its reasons intact", async () => {
  const ledger = makeLedger();
  const dash = await startDashboard(ledger, { port: 0 });
  try {
    const conn = await connectSSE(`${dash.url}/events`);
    ledger.append({
      session: "s",
      search_id: "search-live-gate",
      type: "gate",
      payload: {
        url: "https://spam.example/z",
        domain: "spam.example",
        reasons: ["credibility 0.10 is below the gate threshold 1"],
      },
    });
    const events = await conn.waitForEvents(1);
    const parsed = JSON.parse(events[0]!.data) as {
      type: string;
      payload: { url: string; domain: string; reasons: string[] };
    };
    assert.equal(parsed.type, "gate");
    assert.equal(parsed.payload.domain, "spam.example");
    assert.deepEqual(parsed.payload.reasons, ["credibility 0.10 is below the gate threshold 1"]);
    conn.destroy();
  } finally {
    await dash.close();
  }
});

test("a beyond-cap-truncation 'gate' event (aggregated, no url/domain) streamed live reaches an SSE client intact", async () => {
  const ledger = makeLedger();
  const dash = await startDashboard(ledger, { port: 0 });
  try {
    const conn = await connectSSE(`${dash.url}/events`);
    ledger.append({
      session: "s",
      search_id: "search-live-cap",
      type: "gate",
      payload: { dropped_beyond_cap: 4 },
    });
    const events = await conn.waitForEvents(1);
    const parsed = JSON.parse(events[0]!.data) as { type: string; payload: { dropped_beyond_cap: number } };
    assert.equal(parsed.type, "gate");
    assert.equal(parsed.payload.dropped_beyond_cap, 4);
    conn.destroy();
  } finally {
    await dash.close();
  }
});
