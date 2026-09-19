/**
 * F14: ONE real-chain test. Every other suite stubs at least one layer
 * (a scripted Judge, a hand-wired Pipeline, ...) — this file wires the real
 * thing end to end: `createPipeline` -> real `createJudge` bound to a real
 * `JevClient` (on jev-client's own deterministic MockProvider, so it runs
 * with no network/API key and no per-test scripting) -> real
 * `createBudget`/`createCache`/`createLedger` (a tmp dir) -> `buildServer`,
 * driven over a real MCP `InMemoryTransport`. Only the search backend (never
 * hit the real internet for search results) and `guarded_fetch`'s page fetch
 * (via `withStubbedFetch`, same as pipeline.test.ts) are stubbed — both are
 * I/O boundaries, not jev-scout logic.
 *
 * The point is to catch drift between the pipeline's real output shapes and
 * the MCP layer's schemas/aggregation that per-layer unit tests, each
 * stubbing the layer below it, structurally cannot: nothing here hand-builds
 * a `ResultJudgment` or a ledger event — every one of them is produced by
 * the real judge/pipeline/ledger code this session's other fixes touch.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { JevClient } from "jev-client";
import { z } from "zod";

import {
  buildServer,
  guardedFetchOutputShape,
  guardedSearchOutputShape,
  researchReportOutputShape,
} from "../src/server-mcp.ts";
import { loadConfig } from "../src/config.ts";
import { createJudge } from "../src/judge.ts";
import { createBudget } from "../src/budget.ts";
import { createCache } from "../src/cache.ts";
import { createLedger } from "../src/ledger.ts";
import { createPipeline } from "../src/pipeline.ts";
import type { RawResult, SearchBackend } from "../src/backends/types.ts";
import { tmpDir, withStubbedFetch } from "./support.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURE_RESULTS: RawResult[] = [
  {
    title: "HTTP 103 Early Hints",
    url: "https://docs.example.com/103-early-hints",
    snippet: "The HTTP 103 Early Hints status code is a preliminary response.",
    domain: "docs.example.com",
  },
  {
    title: "Early Hints explained",
    url: "https://developer.example.org/early-hints",
    snippet: "A guide to the 103 Early Hints informational response.",
    domain: "developer.example.org",
  },
];

/** IP-literal URL: fetchPage's SSRF guard checks it directly, no DNS involved — safe offline. */
const SAFE_FETCH_URL = "https://93.184.216.34/early-hints";

function stubDdg(results: RawResult[]): SearchBackend {
  return { name: "ddg", search: async () => results };
}

function htmlResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
}

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

test("real chain: createPipeline + real createJudge(JevClient mock) + buildServer agree end to end", async () => {
  const ledgerDir = tmpDir("integration");
  const ledger = createLedger(ledgerDir);
  const budget = createBudget({ maxCalls: 100, maxSpendUsd: 10, maxJudgedPerSearch: 8 });
  const cache = createCache();
  const config = loadConfig({ JEV_SCOUT_MODE: "annotate" } as NodeJS.ProcessEnv);
  const session = randomUUID();

  // Real JevClient, explicitly on the deterministic offline MockProvider —
  // no network, no API key, but a genuine jev-client decide() round trip
  // (question building, answer normalization, cost estimation) rather than a
  // hand-scripted Judge.
  const client = new JevClient({ provider: "mock" });
  const judge = createJudge(client);

  const pipeline = createPipeline({
    backends: { ddg: stubDdg(FIXTURE_RESULTS) },
    judge,
    budget,
    cache,
    ledger,
    config,
    session,
  });

  const server = buildServer({ pipeline, budget, ledger, config, dashboardUrl: null, session });

  const mcpClient = new Client({ name: "jev-scout-integration", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);

  const goal = "understand the HTTP 103 Early Hints status code";

  try {
    // --- guarded_search -----------------------------------------------------

    const searchRes = await callTool(mcpClient, "guarded_search", {
      query: "http 103 early hints",
      goal,
    });
    assert.notEqual(searchRes.isError, true, `guarded_search failed: ${JSON.stringify(searchRes)}`);
    const search = z.object(guardedSearchOutputShape).strict().parse(searchRes.structuredContent);

    assert.equal(search.results.length, 2, "both fixture results survive annotate mode");
    assert.deepEqual(search.dropped, []);
    for (const result of search.results) {
      assert.equal(result.scored, true, "the real mock-provider judge must score every result");
      assert.ok(result.relevance !== undefined, "relevance judgment present");
      assert.ok(result.credibility !== undefined, "credibility judgment present");
      assert.ok(result.worth_fetching !== undefined, "worth_fetching judgment present");
      assert.ok(
        result.relevance!.score >= 0 && result.relevance!.score <= 2,
        "relevance score is on the 0-2 rubric",
      );
    }
    assert.deepEqual(
      search.results.map((r) => r.domain).sort(),
      ["developer.example.org", "docs.example.com"],
    );

    // --- guarded_fetch --------------------------------------------------------

    const fetchRes = await withStubbedFetch(
      (async () =>
        htmlResponse(
          "<html><body><h1>HTTP 103 Early Hints</h1><p>A preliminary informational response.</p></body></html>",
        )) as typeof fetch,
      () => callTool(mcpClient, "guarded_fetch", { url: SAFE_FETCH_URL, goal }),
    );
    assert.notEqual(fetchRes.isError, true, `guarded_fetch failed: ${JSON.stringify(fetchRes)}`);
    const fetched = z.object(guardedFetchOutputShape).strict().parse(fetchRes.structuredContent);
    assert.equal(fetched.ok, true);
    assert.equal(fetched.scored, true, "the real mock-provider judge must score the fetched page");
    assert.match(fetched.text, /HTTP 103 Early Hints/);
    assert.ok(fetched.answered !== undefined);
    assert.ok(fetched.content_class !== undefined);

    // --- research_report --------------------------------------------------------

    const reportRes = await callTool(mcpClient, "research_report", {});
    assert.notEqual(reportRes.isError, true);
    const report = z.object(researchReportOutputShape).strict().parse(reportRes.structuredContent);

    assert.equal(report.mode, "annotate");
    assert.deepEqual(report.thresholds, { min_relevance: 1, min_credibility: 1 });

    const goalGroup = report.goals.find((g) => g.goal === goal);
    assert.ok(goalGroup !== undefined, "the search's goal must appear as its own report group");
    assert.equal(goalGroup!.searches, 1);
    assert.equal(goalGroup!.results_judged, 2);
    assert.deepEqual(
      goalGroup!.domains.map((d) => d.domain).sort(),
      ["developer.example.org", "docs.example.com"],
    );

    assert.ok(report.session_spend_usd > 0, "real judge calls (via mock provider) must record real spend");
    assert.ok(report.today_spend_usd > 0);
    assert.equal(
      report.budget.callsUsed,
      4,
      "1 on_task query judgment + 2 result judgments + 1 page judgment",
    );
  } finally {
    await mcpClient.close();
    await server.close();
    fs.rmSync(ledgerDir, { recursive: true, force: true });
  }
});
