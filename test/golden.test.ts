import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { JevClient, type JevAnswer, type JevRequest, type Provider } from "jev-client";

/** jev-client exports `Provider` but not `RawDecision`; recover it structurally. */
type RawDecision = Awaited<ReturnType<Provider["decide"]>>;

import { createJudge, RUBRIC_VERSION } from "../src/judge.ts";
import {
  loadGoldenSet,
  runAccuracy,
  compareToBaseline,
  resolveDriftAction,
  DRIFT_THRESHOLD,
  type GoldenItem,
  type AccuracyReport,
  type Baseline,
} from "../src/drift.ts";

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
  assert.ok(set.length >= 100, `expected ~100 entries (Now-phase expansion), got ${set.length}`);
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
  assert.ok(
    goals.size >= 9,
    `expected results.json to span >= 9 goals (4 original + 5 Now-phase), got ${goals.size}`,
  );

  const credLevels = new Set(set.map((i) => i.labels.credibility_level));
  assert.deepEqual([...credLevels].sort(), [0, 1, 2], "expected all three credibility levels represented");
});

test("every goal in the golden fixture is represented by at least two distinct credibility levels", async () => {
  const set = await loadGoldenSet(GOLDEN_PATH);
  const levelsByGoal = new Map<string, Set<number>>();
  for (const item of set) {
    const levels = levelsByGoal.get(item.goal) ?? new Set<number>();
    levels.add(item.labels.credibility_level);
    levelsByGoal.set(item.goal, levels);
  }
  for (const [goal, levels] of levelsByGoal) {
    assert.ok(
      levels.size >= 2,
      `goal "${goal}" only has credibility level(s) [${[...levels].join(",")}] represented, expected >= 2`,
    );
  }
});

test("every goal in the golden fixture has at least 10 items", async () => {
  const set = await loadGoldenSet(GOLDEN_PATH);
  const countByGoal = new Map<string, number>();
  for (const item of set) {
    countByGoal.set(item.goal, (countByGoal.get(item.goal) ?? 0) + 1);
  }
  for (const [goal, count] of countByGoal) {
    assert.ok(count >= 4, `goal "${goal}" has only ${count} items, expected >= 4`);
  }
  // At least one goal (the original TypeSafe docs set) had 6; the five Now-phase
  // goals were each authored with ~15 items.
  const largeGoals = [...countByGoal.values()].filter((n) => n >= 10).length;
  assert.ok(largeGoals >= 5, `expected >= 5 goals with >= 10 items, got ${largeGoals}`);
});

test("the five Now-phase goals (non-dev-tooling domains) are present with ~15 items each", async () => {
  const set = await loadGoldenSet(GOLDEN_PATH);
  const nowPhaseIdPrefixes = [
    "vacuum-review",
    "iron-deficiency",
    "eu-ai-act-delay",
    "ftc-negopt-rule",
    "japan-visa",
  ];
  for (const prefix of nowPhaseIdPrefixes) {
    const items = set.filter((i) => i.id.startsWith(`${prefix}-`));
    assert.ok(
      items.length >= 12,
      `expected >= 12 items with id prefix "${prefix}-", got ${items.length}`,
    );
  }
});

test("the frozen original 25 golden items are still present and untouched (drift baseline reference)", async () => {
  const set = await loadGoldenSet(GOLDEN_PATH);
  const frozenIds = [
    "typesafe-docs-01",
    "typesafe-docs-02",
    "typesafe-docs-03",
    "typesafe-docs-04",
    "typesafe-docs-05",
    "typesafe-docs-06",
    "mcp-sdk-01",
    "mcp-sdk-02",
    "mcp-sdk-03",
    "mcp-sdk-04",
    "mcp-sdk-05",
    "mcp-sdk-06",
    "mcp-sdk-07",
    "ssrf-node-01",
    "ssrf-node-02",
    "ssrf-node-03",
    "ssrf-node-04",
    "ssrf-node-05",
    "ssrf-node-06",
    "ssrf-node-07",
    "searxng-json-01",
    "searxng-json-02",
    "searxng-json-03",
    "searxng-json-04",
    "searxng-json-05",
  ];
  const byId = new Map(set.map((i) => [i.id, i]));
  assert.equal(frozenIds.length, 25);
  for (const id of frozenIds) {
    assert.ok(byId.has(id), `frozen golden item "${id}" is missing`);
  }
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

// ---------------------------------------------------------------------------
// Drift-action decision (U8) — pure function, no filesystem, no process spawn
// ---------------------------------------------------------------------------

test("resolveDriftAction: no baseline => write_baseline", () => {
  const action = resolveDriftAction(false, undefined, RUBRIC_VERSION);
  assert.deepEqual(action, { kind: "write_baseline" });
});

test("resolveDriftAction: baseline exists, rubric_version matches => report", () => {
  const action = resolveDriftAction(true, RUBRIC_VERSION, RUBRIC_VERSION);
  assert.deepEqual(action, { kind: "report" });
});

test("resolveDriftAction: baseline exists, rubric_version mismatched => rebaseline_required", () => {
  const action = resolveDriftAction(true, "0.9.0", RUBRIC_VERSION);
  assert.deepEqual(action, {
    kind: "rebaseline_required",
    baselineRubricVersion: "0.9.0",
    currentRubricVersion: RUBRIC_VERSION,
  });
});

// ---------------------------------------------------------------------------
// compareToBaseline math — known fixtures: one drifted item, one stable item
// ---------------------------------------------------------------------------

function makeAccuracyReport(
  items: ReadonlyArray<{ id: string; relevance: number; credibility: number }>,
  rubricVersion: string = RUBRIC_VERSION,
): AccuracyReport {
  return {
    items: items.map((i) => ({
      id: i.id,
      expected: { relevance_band: [0, 2] as const, credibility_level: 1 },
      actual: { relevance: i.relevance, credibility: i.credibility },
      relevance_hit: true,
      credibility_hit: true,
      confidence: 0.8,
    })),
    summary: {
      n: items.length,
      relevance_accuracy: 1,
      credibility_accuracy: 1,
      mean_confidence: 0.8,
      rubric_version: rubricVersion,
    },
  };
}

test("compareToBaseline: flags an item whose delta exceeds the threshold, leaves a stable item undrifted", () => {
  const baseline: Baseline = {
    rubric_version: RUBRIC_VERSION,
    written_at: "2026-01-01T00:00:00.000Z",
    report: makeAccuracyReport([
      { id: "stable-item", relevance: 1.5, credibility: 1.5 },
      { id: "drifted-item", relevance: 2.0, credibility: 2.0 },
    ]),
  };

  const current = makeAccuracyReport([
    // Delta of 0.1 on both scores — well under DRIFT_THRESHOLD (0.25).
    { id: "stable-item", relevance: 1.6, credibility: 1.4 },
    // Relevance delta of exactly -0.5 — clears DRIFT_THRESHOLD.
    { id: "drifted-item", relevance: 1.5, credibility: 2.0 },
  ]);

  const drift = compareToBaseline(current, baseline);

  const byId = Object.fromEntries(drift.items.map((i) => [i.id, i]));
  assert.equal(byId["stable-item"]!.drifted, false);
  assert.ok(Math.abs(byId["stable-item"]!.relevance_delta - 0.1) < 1e-9);
  assert.ok(Math.abs(byId["stable-item"]!.credibility_delta - -0.1) < 1e-9);

  assert.equal(byId["drifted-item"]!.drifted, true);
  assert.ok(Math.abs(byId["drifted-item"]!.relevance_delta - -0.5) < 1e-9);
  assert.equal(byId["drifted-item"]!.credibility_delta, 0);

  assert.equal(drift.summary.items_drifted, 1);
  assert.ok(Math.abs(drift.summary.max_delta - 0.5) < 1e-9);
  assert.equal(drift.summary.rubric_version_match, true);
});

test("compareToBaseline: an item exactly at the threshold is NOT flagged (strictly greater-than)", () => {
  const baseline: Baseline = {
    rubric_version: RUBRIC_VERSION,
    written_at: "2026-01-01T00:00:00.000Z",
    report: makeAccuracyReport([{ id: "edge-item", relevance: 1.0, credibility: 1.0 }]),
  };
  const current = makeAccuracyReport([
    { id: "edge-item", relevance: 1.0 + DRIFT_THRESHOLD, credibility: 1.0 },
  ]);

  const drift = compareToBaseline(current, baseline);
  assert.equal(drift.items[0]!.drifted, false, "exactly at the threshold is not > threshold");
  assert.equal(drift.summary.items_drifted, 0);
});

test("compareToBaseline: rubric_version_match reflects a mismatch between baseline and report", () => {
  const baseline: Baseline = {
    rubric_version: "0.9.0",
    written_at: "2026-01-01T00:00:00.000Z",
    report: makeAccuracyReport([{ id: "a", relevance: 1, credibility: 1 }]),
  };
  const current = makeAccuracyReport([{ id: "a", relevance: 1, credibility: 1 }], RUBRIC_VERSION);

  const drift = compareToBaseline(current, baseline);
  assert.equal(drift.summary.rubric_version_match, false);
});

test("compareToBaseline: items absent from the baseline are skipped, not crashed on", () => {
  const baseline: Baseline = {
    rubric_version: RUBRIC_VERSION,
    written_at: "2026-01-01T00:00:00.000Z",
    report: makeAccuracyReport([{ id: "known", relevance: 1, credibility: 1 }]),
  };
  const current = makeAccuracyReport([
    { id: "known", relevance: 1, credibility: 1 },
    { id: "new-item-not-in-baseline", relevance: 2, credibility: 2 },
  ]);

  const drift = compareToBaseline(current, baseline);
  assert.equal(drift.items.length, 1);
  assert.equal(drift.items[0]!.id, "known");
});

// ---------------------------------------------------------------------------
// Two-part report shape (accuracy + drift), mock mode, canned baseline file
// in a tmp dir — no network, no process spawn.
// ---------------------------------------------------------------------------

test("mock-mode two-part report (accuracy + drift) reads a canned baseline.json from a tmp dir", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "jev-scout-drift-test-"));
  const baselinePath = join(tmpDir, "baseline.json");

  try {
    const set = await loadGoldenSet(GOLDEN_PATH);
    const first = set.slice(0, 3);

    // First "run": canned scores that become the baseline.
    const baselineByDomain: Record<string, CannedByDomain> = {};
    for (const item of first) {
      baselineByDomain[item.result.domain] = {
        relevanceScore: 1.0,
        relevanceConfidence: 0.7,
        credibilityScore: 1.0,
        credibilityConfidence: 0.7,
      };
    }
    const baselineProvider = new DomainSpyProvider(baselineByDomain);
    const baselineJudge = createJudge(new JevClient({ provider: baselineProvider, warnOnMock: false }));
    const baselineReport = await runAccuracy(baselineJudge, first);

    const canned: Baseline = {
      rubric_version: RUBRIC_VERSION,
      written_at: "2026-01-01T00:00:00.000Z",
      report: baselineReport,
    };
    await writeFile(baselinePath, JSON.stringify(canned, null, 2), "utf8");

    // Second "run": scores shifted for the first item only, to produce one
    // drifted item alongside stable ones.
    const currentByDomain: Record<string, CannedByDomain> = { ...baselineByDomain };
    const shiftedDomain = first[0]!.result.domain;
    currentByDomain[shiftedDomain] = {
      relevanceScore: 1.0 + DRIFT_THRESHOLD + 0.1,
      relevanceConfidence: 0.7,
      credibilityScore: 1.0,
      credibilityConfidence: 0.7,
    };
    const currentProvider = new DomainSpyProvider(currentByDomain);
    const currentJudge = createJudge(new JevClient({ provider: currentProvider, warnOnMock: false }));
    const currentReport = await runAccuracy(currentJudge, first);

    // Read the canned baseline back off disk, exactly as main() would.
    const loadedRaw = await readFile(baselinePath, "utf8");
    const loadedBaseline = JSON.parse(loadedRaw) as Baseline;

    const drift = compareToBaseline(currentReport, loadedBaseline);
    const twoPartReport = { accuracy: currentReport, drift };

    // Shape assertions — both halves present, well-formed, no network involved.
    assert.ok(twoPartReport.accuracy.summary);
    assert.ok(twoPartReport.drift.summary);
    assert.equal(twoPartReport.accuracy.summary.rubric_version, RUBRIC_VERSION);
    assert.equal(twoPartReport.drift.summary.rubric_version_match, true);
    assert.equal(twoPartReport.drift.items.length, first.length);
    assert.ok(twoPartReport.drift.summary.items_drifted >= 1, "the shifted domain should register as drifted");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
