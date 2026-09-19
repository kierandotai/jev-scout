import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { JevClient, type JevAnswer, type JevRequest, type Provider } from "jev-client";

/** jev-client exports `Provider` but not `RawDecision`; recover it structurally. */
type RawDecision = Awaited<ReturnType<Provider["decide"]>>;

import { createJudge, RUBRIC_VERSION } from "../src/judge.ts";
import { loadGoldenSet, runAccuracy, type GoldenItem } from "../src/drift.ts";

const GOLDEN_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "golden",
  "results.json",
);

// ---------------------------------------------------------------------------
// Schema validation of the real fixture file
// ---------------------------------------------------------------------------

test("golden fixture loads as a non-empty array", async () => {
  const set = await loadGoldenSet(GOLDEN_PATH);
  assert.ok(Array.isArray(set));
  assert.ok(set.length >= 20, `expected ~25 entries, got ${set.length}`);
});

test("every golden entry has all required fields, non-empty", async () => {
  const set = await loadGoldenSet(GOLDEN_PATH);
  for (const item of set) {
    assert.equal(typeof item.id, "string");
    assert.ok(item.id.length > 0, "id must be non-empty");
    assert.equal(typeof item.goal, "string");
    assert.ok(item.goal.trim().length > 0, `${item.id}: goal must be non-empty`);
    assert.equal(typeof item.query, "string");
    assert.ok(item.query.trim().length > 0, `${item.id}: query must be non-empty`);

    assert.ok(item.result, `${item.id}: missing result`);
    assert.equal(typeof item.result.title, "string");
    assert.ok(item.result.title.trim().length > 0, `${item.id}: title must be non-empty`);
    assert.equal(typeof item.result.url, "string");
    assert.ok(item.result.url.trim().length > 0, `${item.id}: url must be non-empty`);
    assert.equal(typeof item.result.snippet, "string");
    assert.ok(item.result.snippet.trim().length > 0, `${item.id}: snippet must be non-empty`);
    assert.equal(typeof item.result.domain, "string");
    assert.ok(item.result.domain.trim().length > 0, `${item.id}: domain must be non-empty`);

    assert.ok(item.labels, `${item.id}: missing labels`);
    assert.equal(typeof item.labels.notes, "string");
    assert.ok(item.labels.notes.trim().length > 0, `${item.id}: notes must be non-empty`);
  }
});

test("every golden entry's relevance_band is ordered and within 0..2", async () => {
  const set = await loadGoldenSet(GOLDEN_PATH);
  for (const item of set) {
    const band = item.labels.relevance_band;
    assert.ok(Array.isArray(band) && band.length === 2, `${item.id}: relevance_band must be a [min, max] pair`);
    const [min, max] = band;
    assert.equal(typeof min, "number");
    assert.equal(typeof max, "number");
    assert.ok(Number.isInteger(min) && Number.isInteger(max), `${item.id}: band values must be integers`);
    assert.ok(min >= 0 && max <= 2, `${item.id}: band values must be within 0..2`);
    assert.ok(min <= max, `${item.id}: band must be ordered (min <= max)`);
  }
});

test("every golden entry's credibility_level is 0, 1, or 2", async () => {
  const set = await loadGoldenSet(GOLDEN_PATH);
  for (const item of set) {
    assert.ok(
      [0, 1, 2].includes(item.labels.credibility_level),
      `${item.id}: credibility_level must be 0, 1, or 2, got ${item.labels.credibility_level}`,
    );
  }
});

test("golden entry ids are unique", async () => {
  const set = await loadGoldenSet(GOLDEN_PATH);
  const ids = set.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate id found in golden set");
});

test("golden fixture spans multiple goals and all three credibility levels", async () => {
  const set = await loadGoldenSet(GOLDEN_PATH);
  const goals = new Set(set.map((i) => i.goal));
  assert.ok(goals.size >= 3, `expected results.json to span >= 3 goals, got ${goals.size}`);

  const credLevels = new Set(set.map((i) => i.labels.credibility_level));
  assert.deepEqual([...credLevels].sort(), [0, 1, 2], "expected all three credibility levels represented");
});

// ---------------------------------------------------------------------------
// Mock-mode accuracy run: canned spy Provider, deterministic answers
// ---------------------------------------------------------------------------

/** Deterministic canned score/confidence per domain, keyed by the domain in request state. */
interface CannedByDomain {
  readonly relevanceScore: number;
  readonly relevanceConfidence: number;
  readonly credibilityScore: number;
  readonly credibilityConfidence: number;
}

class DomainSpyProvider implements Provider {
  readonly name = "domain-spy";
  readonly defaultModel = "spy-jev";
  readonly requests: JevRequest[] = [];
  readonly #byDomain: Record<string, CannedByDomain>;

  constructor(byDomain: Record<string, CannedByDomain>) {
    this.#byDomain = byDomain;
  }

  async decide(req: JevRequest): Promise<RawDecision> {
    this.requests.push(req);
    const state = req.state as { result: { domain: string } };
    const canned = this.#byDomain[state.result.domain];
    if (canned === undefined) {
      throw new Error(`DomainSpyProvider has no canned answer for domain "${state.result.domain}"`);
    }
    const answers: Record<string, JevAnswer> = {
      relevance: {
        type: "score",
        score: canned.relevanceScore,
        legend: {},
        probabilities: {},
        confidence: canned.relevanceConfidence,
      },
      credibility: {
        type: "score",
        score: canned.credibilityScore,
        legend: {},
        probabilities: {},
        confidence: canned.credibilityConfidence,
      },
      worth_fetching: { type: "noul", noul: 0.5 },
    };
    return { model: this.defaultModel, answers, usage: { input_tokens: 500, output_tokens: 0 } };
  }
}

function makeItem(id: string, domain: string, band: [number, number], credLevel: 0 | 1 | 2): GoldenItem {
  return {
    id,
    goal: "test goal for mock accuracy run",
    query: "test query",
    result: {
      title: `Title for ${id}`,
      url: `https://${domain}/page`,
      snippet: `Snippet body for ${id}, long enough to be non-trivial.`,
      domain,
    },
    labels: {
      relevance_band: band,
      credibility_level: credLevel,
      notes: `synthetic fixture for ${id}`,
    },
  };
}

test("runAccuracy in mock mode produces the report shape with correct per-item hits", async () => {
  // hit-hit: actual scores land inside the band and round to the labeled level.
  const hitItem = makeItem("hit-hit", "docs.example.org", [2, 2], 2);
  // relevance miss: actual score (0.4) falls outside the labeled band [2,2].
  const relMissItem = makeItem("rel-miss", "blog.example.com", [2, 2], 1);
  // credibility miss: actual credibility score rounds to 0, labeled 2.
  const credMissItem = makeItem("cred-miss", "farm.example.net", [0, 1], 2);

  const byDomain: Record<string, CannedByDomain> = {
    "docs.example.org": {
      relevanceScore: 2.0,
      relevanceConfidence: 0.9,
      credibilityScore: 1.8,
      credibilityConfidence: 0.85,
    },
    "blog.example.com": {
      relevanceScore: 0.4,
      relevanceConfidence: 0.6,
      credibilityScore: 1.0,
      credibilityConfidence: 0.7,
    },
    "farm.example.net": {
      relevanceScore: 0.5,
      relevanceConfidence: 0.5,
      credibilityScore: 0.1,
      credibilityConfidence: 0.95,
    },
  };

  const provider = new DomainSpyProvider(byDomain);
  const judge = createJudge(new JevClient({ provider, warnOnMock: false }));
  const goldenSet = [hitItem, relMissItem, credMissItem];

  const report = await runAccuracy(judge, goldenSet);

  assert.equal(provider.requests.length, 3, "one Jev call per golden item");

  // Report shape: summary fields present.
  assert.equal(report.summary.n, 3);
  assert.equal(report.summary.rubric_version, RUBRIC_VERSION);
  assert.equal(typeof report.summary.relevance_accuracy, "number");
  assert.equal(typeof report.summary.credibility_accuracy, "number");
  assert.equal(typeof report.summary.mean_confidence, "number");

  // Per-item hits computed correctly for known answers.
  assert.equal(report.items.length, 3);
  const byId = Object.fromEntries(report.items.map((i) => [i.id, i]));

  assert.equal(byId["hit-hit"]!.relevance_hit, true);
  assert.equal(byId["hit-hit"]!.credibility_hit, true);
  assert.equal(byId["hit-hit"]!.actual.relevance, 2.0);
  assert.equal(byId["hit-hit"]!.actual.credibility, 1.8);

  assert.equal(byId["rel-miss"]!.relevance_hit, false, "0.4 is outside band [2,2]");
  assert.equal(byId["rel-miss"]!.credibility_hit, true, "round(1.0) === 1");

  assert.equal(byId["cred-miss"]!.relevance_hit, true, "0.5 is inside band [0,1]");
  assert.equal(byId["cred-miss"]!.credibility_hit, false, "round(0.1) === 0, labeled 2");

  // Aggregate accuracy derived from exactly those hits.
  assert.equal(report.summary.relevance_accuracy, 2 / 3);
  assert.equal(report.summary.credibility_accuracy, 2 / 3);

  // Mean confidence is the mean of each item's (relevance+credibility)/2 confidence.
  const expectedMeanConfidence =
    ((0.9 + 0.85) / 2 + (0.6 + 0.7) / 2 + (0.5 + 0.95) / 2) / 3;
  assert.ok(
    Math.abs(report.summary.mean_confidence - expectedMeanConfidence) < 1e-9,
    `mean_confidence mismatch: ${report.summary.mean_confidence} vs ${expectedMeanConfidence}`,
  );

  // Expected labels echoed back for downstream reporting.
  assert.deepEqual(byId["hit-hit"]!.expected, { relevance_band: [2, 2], credibility_level: 2 });
  assert.deepEqual(byId["rel-miss"]!.expected, { relevance_band: [2, 2], credibility_level: 1 });
  assert.deepEqual(byId["cred-miss"]!.expected, { relevance_band: [0, 1], credibility_level: 2 });
});

test("runAccuracy on an empty golden set returns a zeroed valid report, no provider calls", async () => {
  const provider = new DomainSpyProvider({});
  const judge = createJudge(new JevClient({ provider, warnOnMock: false }));

  const report = await runAccuracy(judge, []);

  assert.equal(provider.requests.length, 0);
  assert.equal(report.items.length, 0);
  assert.deepEqual(report.summary, {
    n: 0,
    relevance_accuracy: 0,
    credibility_accuracy: 0,
    mean_confidence: 0,
    rubric_version: RUBRIC_VERSION,
  });
});

test("runAccuracy over the real golden fixture in mock mode produces a full report without network", async () => {
  const set = await loadGoldenSet(GOLDEN_PATH);
  const byDomain: Record<string, CannedByDomain> = {};
  for (const item of set) {
    // Deterministic canned answer per domain: mid-band relevance/credibility so
    // every request the judge issues has a canned answer to draw on.
    byDomain[item.result.domain] = {
      relevanceScore: 1,
      relevanceConfidence: 0.6,
      credibilityScore: 1,
      credibilityConfidence: 0.6,
    };
  }
  const provider = new DomainSpyProvider(byDomain);
  const judge = createJudge(new JevClient({ provider, warnOnMock: false }));

  const report = await runAccuracy(judge, set);

  assert.equal(report.items.length, set.length);
  assert.equal(report.summary.n, set.length);
  assert.equal(report.summary.rubric_version, RUBRIC_VERSION);
  assert.ok(report.summary.relevance_accuracy >= 0 && report.summary.relevance_accuracy <= 1);
  assert.ok(report.summary.credibility_accuracy >= 0 && report.summary.credibility_accuracy <= 1);
});
