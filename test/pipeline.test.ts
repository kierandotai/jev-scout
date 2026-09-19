import { test } from "node:test";
import assert from "node:assert/strict";

import { createPipeline, type RunFetchResult } from "../src/pipeline.ts";
import { createBudget, type Budget } from "../src/budget.ts";
import { createCache } from "../src/cache.ts";
import { createLedger, type LedgerEvent } from "../src/ledger.ts";
import { loadConfig, type Config } from "../src/config.ts";
import {
  RUBRIC_VERSION,
  type Judge,
  type JudgeCallOptions,
  type JudgePageInput,
  type JudgeResultInput,
  type PageJudgment,
  type ResultJudgment,
} from "../src/judge.ts";
import type { RawResult, SearchBackend } from "../src/backends/types.ts";
import { tmpDir, withStubbedFetch } from "./support.ts";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function ddgReturning(results: RawResult[]): SearchBackend {
  return { name: "ddg", search: async () => results };
}

interface JudgeState {
  resultCalls: JudgeResultInput[];
  pageCalls: JudgePageInput[];
}

/** A hand-wired Judge (not MockProvider, not even JevClient) — full control over answers/throws. */
function scriptedJudge(handlers: {
  judgeResult?: (input: JudgeResultInput, opts?: JudgeCallOptions) => Promise<ResultJudgment>;
  judgePage?: (input: JudgePageInput, opts?: JudgeCallOptions) => Promise<PageJudgment>;
}): { judge: Judge; state: JudgeState } {
  const state: JudgeState = { resultCalls: [], pageCalls: [] };
  const judge: Judge = {
    rubricVersion: RUBRIC_VERSION,
    async judgeResult(input, opts) {
      state.resultCalls.push(input);
      if (handlers.judgeResult === undefined) throw new Error("no judgeResult handler configured");
      return handlers.judgeResult(input, opts);
    },
    async judgeQuery() {
      return null;
    },
    async judgePage(input, opts) {
      state.pageCalls.push(input);
      if (handlers.judgePage === undefined) throw new Error("no judgePage handler configured");
      return handlers.judgePage(input, opts);
    },
  };
  return { judge, state };
}

/** Never resolves on its own — rejects only when the caller's AbortSignal fires, like a real client under a timeout. */
function neverResolvesUntilAborted<T>(opts?: JudgeCallOptions): Promise<T> {
  return new Promise((_resolve, reject) => {
    opts?.signal?.addEventListener("abort", () => reject(new DOMException("The operation timed out.", "TimeoutError")));
  });
}

function resultJudgment(relevance: number, credibility: number, worthFetching = 0.5): ResultJudgment {
  return {
    relevance: { score: relevance, confidence: 0.9, probabilities: {} },
    credibility: { score: credibility, confidence: 0.9, probabilities: {} },
    worth_fetching: { probability: worthFetching },
    rubric_version: RUBRIC_VERSION,
    usage: { input_tokens: 100, output_tokens: 0 },
    cost_usd: 0.0001,
  };
}

function pageJudgment(): PageJudgment {
  return {
    answered: { probability: 0.8 },
    content_class: { choice: "docs", confidence: 0.7, probabilities: { docs: 0.7 } },
    steering_risk: { probability: 0.02 },
    rubric_version: RUBRIC_VERSION,
    usage: { input_tokens: 50, output_tokens: 0 },
    cost_usd: 0.00005,
  };
}

const SAMPLE: RawResult = {
  title: "Example Docs",
  url: "https://docs.example.com/guide",
  snippet: "Official guide to Example.",
  domain: "docs.example.com",
};

function rawResult(n: number): RawResult {
  return {
    title: `Result ${n}`,
    url: `https://example${n}.com/page`,
    snippet: `Snippet ${n}`,
    domain: `example${n}.com`,
  };
}

function htmlResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
}

/** IP-literal URL: fetchPage's SSRF guard checks it directly, no DNS involved — safe for offline tests. */
const SAFE_URL = "https://93.184.216.34/page";

interface Setup {
  readonly pipeline: ReturnType<typeof createPipeline>;
  readonly budget: Budget;
  readonly events: LedgerEvent[];
}

function setup(opts: {
  judge: Judge;
  mode?: "annotate" | "gate";
  maxCalls?: number;
  minRelevance?: number;
  minCredibility?: number;
  maxJudged?: number;
  results?: RawResult[];
  judgeTimeoutMs?: number;
}): Setup {
  const config: Config = loadConfig({
    JEV_SCOUT_MODE: opts.mode ?? "annotate",
    JEV_SCOUT_MIN_RELEVANCE: String(opts.minRelevance ?? 1.0),
    JEV_SCOUT_MIN_CREDIBILITY: String(opts.minCredibility ?? 1.0),
    JEV_SCOUT_MAX_JUDGED: String(opts.maxJudged ?? 8),
  } as NodeJS.ProcessEnv);

  const budget = createBudget({
    maxCalls: opts.maxCalls ?? 100,
    maxSpendUsd: 10,
    maxJudgedPerSearch: opts.maxJudged ?? 8,
  });
  const cache = createCache();
  const ledger = createLedger(tmpDir("pipeline"));
  const events: LedgerEvent[] = [];
  ledger.on("event", (e: LedgerEvent) => events.push(e));

  const pipeline = createPipeline({
    backends: { ddg: ddgReturning(opts.results ?? [SAMPLE]) },
    judge: opts.judge,
    budget,
    cache,
    ledger,
    config,
    ...(opts.judgeTimeoutMs === undefined ? {} : { judgeTimeoutMs: opts.judgeTimeoutMs }),
  });

  return { pipeline, budget, events };
}

// ---------------------------------------------------------------------------
// runSearch: gate vs annotate
// ---------------------------------------------------------------------------

test("gate mode drops a low-relevance result and ledgers a gate event with reasons", async () => {
  const { judge } = scriptedJudge({ judgeResult: async () => resultJudgment(0.4, 2.0) });
  const { pipeline, events } = setup({ judge, mode: "gate" });

  const res = await pipeline.runSearch({ query: "q", goal: "g", maxResults: 5 });

  assert.equal(res.results.length, 0, "the low-relevance result must be dropped from the output");
  const gateEvents = events.filter((e) => e.type === "gate");
  assert.equal(gateEvents.length, 1);
  const payload = gateEvents[0]!.payload as { url: string; reasons: string[] };
  assert.equal(payload.url, SAMPLE.url);
  assert.match(payload.reasons[0]!, /relevance/);
});

test("annotate mode passes the same low-relevance result through, scored, no gate event", async () => {
  const { judge } = scriptedJudge({ judgeResult: async () => resultJudgment(0.4, 2.0) });
  const { pipeline, events } = setup({ judge, mode: "annotate" });

  const res = await pipeline.runSearch({ query: "q", goal: "g", maxResults: 5 });

  assert.equal(res.results.length, 1);
  const result = res.results[0]!;
  assert.equal(result.scored, true);
  assert.equal(result.relevance?.score, 0.4);
  assert.equal(events.some((e) => e.type === "gate"), false, "annotate mode must not gate anything");
});

// ---------------------------------------------------------------------------
// Cache-first: identical query+goal+url -> second search skips Jev entirely
// ---------------------------------------------------------------------------

test("cache-first: a repeated search for the same query/goal/url makes no second Jev call", async () => {
  const { judge, state } = scriptedJudge({ judgeResult: async () => resultJudgment(2.0, 2.0) });
  const { pipeline } = setup({ judge, mode: "annotate" });

  const first = await pipeline.runSearch({ query: "http 103 early hints", goal: "spec", maxResults: 5 });
  const second = await pipeline.runSearch({ query: "http 103 early hints", goal: "spec", maxResults: 5 });

  assert.equal(state.resultCalls.length, 1, "the second identical search must be served entirely from cache");
  assert.equal(first.results[0]!.relevance?.score, 2.0);
  assert.equal(second.results[0]!.relevance?.score, 2.0);
  assert.equal(second.results[0]!.scored, true);
});

// ---------------------------------------------------------------------------
// Budget exhaustion vs Jev failure — distinct, both fail open
// ---------------------------------------------------------------------------

test("budget exhausted: result passes unscored with budget_exhausted:true (no Jev call made)", async () => {
  const { judge, state } = scriptedJudge({ judgeResult: async () => resultJudgment(2.0, 2.0) });
  const { pipeline } = setup({ judge, mode: "gate", maxCalls: 0 });

  const res = await pipeline.runSearch({ query: "q", goal: "g", maxResults: 5 });

  assert.equal(state.resultCalls.length, 0, "reserve() must fail before judge is ever called");
  assert.equal(res.results.length, 1, "budget exhaustion fails open — the result still passes");
  assert.equal(res.results[0]!.scored, false);
  assert.equal(res.results[0]!.budget_exhausted, true);
});

test("Jev failure: search result passes unscored WITHOUT budget_exhausted, and budget is refunded", async () => {
  const { judge } = scriptedJudge({
    judgeResult: async () => {
      throw new Error("Jev provider exploded");
    },
  });
  const { pipeline, budget } = setup({ judge, mode: "gate", maxCalls: 100 });

  const res = await pipeline.runSearch({ query: "q", goal: "g", maxResults: 5 });

  assert.equal(res.results.length, 1, "Jev failure fails open — the result still passes");
  assert.equal(res.results[0]!.scored, false);
  assert.equal(res.results[0]!.budget_exhausted, undefined, "budget_exhausted must be distinct from a Jev failure");
  assert.equal(budget.state().callsUsed, 0, "the failed reservation must be refunded");
});

test("Jev failure: fetch still delivers the page text, unscored, no budget_exhausted", async () => {
  const { judge } = scriptedJudge({
    judgePage: async () => {
      throw new Error("Jev provider exploded");
    },
  });
  const { pipeline, budget } = setup({ judge, mode: "annotate" });

  const result = await withStubbedFetch(
    (async () => htmlResponse("<p>Real page content</p>")) as typeof fetch,
    () => pipeline.runFetch({ url: SAFE_URL, goal: "g" }),
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.scored, false);
  assert.equal(result.budget_exhausted, undefined);
  assert.equal(result.text, "Real page content");
  assert.equal(budget.state().callsUsed, 0, "the failed reservation must be refunded");
});

test("budget exhausted on fetch: content still delivered with budget_exhausted:true", async () => {
  const { judge, state } = scriptedJudge({ judgePage: async () => pageJudgment() });
  const { pipeline } = setup({ judge, mode: "annotate", maxCalls: 0 });

  const result = await withStubbedFetch(
    (async () => htmlResponse("<p>Content</p>")) as typeof fetch,
    () => pipeline.runFetch({ url: SAFE_URL }),
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(state.pageCalls.length, 0);
  assert.equal(result.scored, false);
  assert.equal(result.budget_exhausted, true);
  assert.equal(result.text, "Content");
});

// ---------------------------------------------------------------------------
// preFetchGate integration: refuse without any network call
// ---------------------------------------------------------------------------

test("gate-mode preFetchGate refuses a fetch to a domain cached below threshold, with no network call", async () => {
  const { judge } = scriptedJudge({ judgePage: async () => pageJudgment() });
  const config = loadConfig({
    JEV_SCOUT_MODE: "gate",
    JEV_SCOUT_MIN_CREDIBILITY: "1.0",
  } as NodeJS.ProcessEnv);
  const budget = createBudget({ maxCalls: 100, maxSpendUsd: 10, maxJudgedPerSearch: 8 });
  const cache = createCache();
  const ledger = createLedger(tmpDir("pipeline"));
  const events: LedgerEvent[] = [];
  ledger.on("event", (e: LedgerEvent) => events.push(e));

  cache.putCredibility("spamfarm.example", RUBRIC_VERSION, {
    scores: { credibility: { score: 0.2, confidence: 0.8, probabilities: {} } },
    confidence: 0.8,
    rubric_version: RUBRIC_VERSION,
    judged_at: Date.now(),
  });

  const pipeline = createPipeline({ backends: { ddg: ddgReturning([]) }, judge, budget, cache, ledger, config });

  let fetchCalled = false;
  const result: RunFetchResult = await withStubbedFetch(
    (async () => {
      fetchCalled = true;
      throw new Error("fetchPage must never be reached once preFetchGate refuses");
    }) as typeof fetch,
    () => pipeline.runFetch({ url: "https://spamfarm.example/article" }),
  );

  assert.equal(fetchCalled, false, "no network call may happen on a preFetchGate refusal");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "gate_refused");
  assert.match(result.detail, /spamfarm\.example/);
  assert.match(result.detail, /0\.20/);

  const gateEvents = events.filter((e) => e.type === "gate");
  assert.equal(gateEvents.length, 1);
  assert.match((gateEvents[0]!.payload as { reason: string }).reason, /spamfarm\.example/);
});

test("gate-mode preFetchGate allows a fetch when there is no cached credibility for the domain", async () => {
  const { judge } = scriptedJudge({ judgePage: async () => pageJudgment() });
  const { pipeline } = setup({ judge, mode: "gate" });

  const result = await withStubbedFetch(
    (async () => htmlResponse("<p>Fresh content</p>")) as typeof fetch,
    () => pipeline.runFetch({ url: SAFE_URL }),
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.scored, true);
  assert.equal(result.text, "Fresh content");
});

// ---------------------------------------------------------------------------
// search_id stamping, backends_tried, budget surfacing
// ---------------------------------------------------------------------------

test("every call gets its own distinct search_id, and backends_tried is reported", async () => {
  const { judge } = scriptedJudge({ judgeResult: async () => resultJudgment(2.0, 2.0) });
  const { pipeline } = setup({ judge });

  const a = await pipeline.runSearch({ query: "q1", maxResults: 5 });
  const b = await pipeline.runSearch({ query: "q2", maxResults: 5 });

  assert.notEqual(a.search_id, b.search_id);
  assert.deepEqual(a.backends_tried, ["ddg"]);
});

test("budget field is omitted well under 80% usage and present once a limit crosses 80%", async () => {
  const { judge } = scriptedJudge({ judgeResult: async () => resultJudgment(2.0, 2.0) });
  const { pipeline: roomy } = setup({ judge, maxCalls: 100 });
  const roomyRes = await roomy.runSearch({ query: "q", maxResults: 5 });
  assert.equal(roomyRes.budget, undefined);

  const { judge: judge2 } = scriptedJudge({ judgeResult: async () => resultJudgment(2.0, 2.0) });
  const { pipeline: tight } = setup({ judge: judge2, maxCalls: 1 });
  const tightRes = await tight.runSearch({ query: "q", maxResults: 5 });
  assert.notEqual(tightRes.budget, undefined);
  assert.equal(tightRes.budget!.over80.calls, true);
});

// ---------------------------------------------------------------------------
// Zero results is a valid answer
// ---------------------------------------------------------------------------

test("zero backend results is a valid answer: empty results array, still ledgers the search", async () => {
  const { judge } = scriptedJudge({ judgeResult: async () => resultJudgment(2.0, 2.0) });
  const { pipeline, events } = setup({ judge, results: [] });

  const res = await pipeline.runSearch({ query: "q", maxResults: 5 });

  assert.deepEqual(res.results, []);
  assert.equal(events.some((e) => e.type === "search"), true);
});

// ---------------------------------------------------------------------------
// Fix 1: the "budget" ledger event, emitted once per session, on exhaustion
// ---------------------------------------------------------------------------

test("budget ledger event fires exactly once per session, across both runSearch and runFetch", async () => {
  const { judge } = scriptedJudge({
    judgeResult: async () => resultJudgment(2.0, 2.0),
    judgePage: async () => pageJudgment(),
  });
  const { pipeline, events } = setup({ judge, mode: "annotate", maxCalls: 0 });

  const searchRes = await pipeline.runSearch({ query: "q", goal: "g", maxResults: 5 });
  assert.equal(searchRes.results[0]!.budget_exhausted, true);

  const fetchRes = await withStubbedFetch(
    (async () => htmlResponse("<p>Content</p>")) as typeof fetch,
    () => pipeline.runFetch({ url: SAFE_URL, goal: "g" }),
  );
  assert.equal(fetchRes.ok, true);
  if (!fetchRes.ok) return;
  assert.equal(fetchRes.budget_exhausted, true);

  const budgetEvents = events.filter((e) => e.type === "budget");
  assert.equal(budgetEvents.length, 1, "only the FIRST budget-reserve failure this session emits a budget event");
  const payload = budgetEvents[0]!.payload as { limit: string; callsUsed: number; spendUsd: number };
  assert.equal(payload.limit, "calls");
  assert.equal(typeof payload.callsUsed, "number");
  assert.equal(typeof payload.spendUsd, "number");
});

test("fetch ledger event carries budget_exhausted and goal", async () => {
  const { judge } = scriptedJudge({ judgePage: async () => pageJudgment() });
  const { pipeline, events } = setup({ judge, mode: "annotate", maxCalls: 0 });

  await withStubbedFetch(
    (async () => htmlResponse("<p>Content</p>")) as typeof fetch,
    () => pipeline.runFetch({ url: SAFE_URL, goal: "find the spec" }),
  );

  const fetchEvents = events.filter((e) => e.type === "fetch");
  assert.equal(fetchEvents.length, 1);
  const payload = fetchEvents[0]!.payload as { budget_exhausted: boolean; goal: string };
  assert.equal(payload.budget_exhausted, true);
  assert.equal(payload.goal, "find the spec");
});

// ---------------------------------------------------------------------------
// Fix 4/5: failed fetches are ledgered, with reason and goal
// ---------------------------------------------------------------------------

test("a failed fetch (SSRF-refused) is still ledgered, with its reason, detail, and goal", async () => {
  const { judge } = scriptedJudge({});
  const { pipeline, events } = setup({ judge, mode: "annotate" });

  const result = await pipeline.runFetch({ url: "https://127.0.0.1/secret", goal: "recon" });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "ssrf");

  const fetchEvents = events.filter((e) => e.type === "fetch");
  assert.equal(fetchEvents.length, 1, "a failed fetch must still be ledgered");
  const payload = fetchEvents[0]!.payload as {
    ok: boolean;
    reason: string;
    detail: string;
    goal: string;
    url: string;
  };
  assert.equal(payload.ok, false);
  assert.equal(payload.reason, "ssrf");
  assert.equal(payload.goal, "recon");
  assert.equal(payload.url, "https://127.0.0.1/secret");
  assert.equal(typeof payload.detail, "string");
});

// ---------------------------------------------------------------------------
// Fix 3: beyond-cap results never silently vanish
// ---------------------------------------------------------------------------

test("annotate mode: results beyond the judged cap are returned unscored with judge_skipped", async () => {
  const { judge, state } = scriptedJudge({ judgeResult: async () => resultJudgment(2.0, 2.0) });
  const { pipeline } = setup({
    judge,
    mode: "annotate",
    maxJudged: 2,
    results: [rawResult(1), rawResult(2), rawResult(3)],
  });

  const res = await pipeline.runSearch({ query: "q", maxResults: 5 });

  assert.equal(state.resultCalls.length, 2, "only the top-k results are ever judged");
  assert.equal(res.results.length, 3, "beyond-cap results still appear in results, not silently dropped");
  assert.equal(res.results[0]!.scored, true);
  assert.equal(res.results[1]!.scored, true);

  const beyond = res.results[2]!;
  assert.equal(beyond.scored, false);
  assert.equal(beyond.judge_skipped, "judge_cap");
  assert.equal(beyond.relevance, undefined);
  assert.equal(beyond.url, rawResult(3).url);
  assert.equal(res.dropped.length, 0, "annotate mode never gate-drops anything");
});

test("gate mode: results beyond the judged cap are truncated (never bypass the gate), one aggregated ledger event, dropped array populated", async () => {
  const { judge, state } = scriptedJudge({ judgeResult: async () => resultJudgment(2.0, 2.0) });
  const { pipeline, events } = setup({
    judge,
    mode: "gate",
    maxJudged: 1,
    minRelevance: 1.0,
    minCredibility: 1.0,
    results: [rawResult(1), rawResult(2), rawResult(3)],
  });

  const res = await pipeline.runSearch({ query: "q", maxResults: 5 });

  assert.equal(state.resultCalls.length, 1, "only the top-k result is ever judged");
  assert.equal(res.results.length, 1, "the judged, passing result is the only one returned");
  assert.equal(res.results[0]!.url, rawResult(1).url);

  assert.equal(res.dropped.length, 2, "both beyond-cap results are recorded as dropped");
  for (const d of res.dropped) {
    assert.deepEqual(d.reasons, ["judge_cap_unjudged"]);
  }
  assert.deepEqual(
    res.dropped.map((d) => d.url).sort(),
    [rawResult(2).url, rawResult(3).url].sort(),
  );

  const gateEvents = events.filter((e) => e.type === "gate");
  assert.equal(gateEvents.length, 1, "one aggregated gate event for the beyond-cap truncation, not one per result");
  const payload = gateEvents[0]!.payload as { dropped_beyond_cap: number };
  assert.equal(payload.dropped_beyond_cap, 2);
});

// ---------------------------------------------------------------------------
// Fix 2: Jev calls carry a timeout and fail open on abort
// ---------------------------------------------------------------------------

test("judge timeout: a never-resolving judgeResult call aborts and fails open, refunding the reservation", async () => {
  const { judge } = scriptedJudge({
    judgeResult: (_input, opts) => neverResolvesUntilAborted<ResultJudgment>(opts),
  });
  const { pipeline, budget } = setup({ judge, mode: "annotate", judgeTimeoutMs: 20 });

  const res = await pipeline.runSearch({ query: "q", goal: "g", maxResults: 5 });

  assert.equal(res.results.length, 1, "timeout fails open — the result still passes");
  assert.equal(res.results[0]!.scored, false);
  assert.equal(res.results[0]!.budget_exhausted, undefined);
  assert.equal(budget.state().callsUsed, 0, "the aborted reservation must be refunded");
});

test("judge timeout: a never-resolving judgePage call aborts and fails open on fetch", async () => {
  const { judge } = scriptedJudge({
    judgePage: (_input, opts) => neverResolvesUntilAborted<PageJudgment>(opts),
  });
  const { pipeline, budget } = setup({ judge, mode: "annotate", judgeTimeoutMs: 20 });

  const result = await withStubbedFetch(
    (async () => htmlResponse("<p>Content</p>")) as typeof fetch,
    () => pipeline.runFetch({ url: SAFE_URL, goal: "g" }),
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.scored, false);
  assert.equal(result.budget_exhausted, undefined);
  assert.equal(budget.state().callsUsed, 0, "the aborted reservation must be refunded");
});
