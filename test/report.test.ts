import { test } from "node:test";
import assert from "node:assert/strict";

import {
  renderDriftReport,
  parseRunJson,
  buildGoalIndex,
  type DriftRunJson,
  type AccuracyItem,
} from "../scripts/render-drift-report.ts";

// ---------------------------------------------------------------------------
// Synthetic fixtures
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<AccuracyItem> & { id: string }): AccuracyItem {
  return {
    expected: { relevance_band: [2, 2], credibility_level: 2 },
    actual: { relevance: 2.0, credibility: 2.0 },
    relevance_hit: true,
    credibility_hit: true,
    confidence: 0.8,
    ...overrides,
  };
}

const STUB_GOAL_BY_ID: Record<string, string> = {
  "goalA-01": "Test Goal A",
  "goalA-02": "Test Goal A",
  "goalB-01": "Test Goal B",
};

function makeRunJson(): DriftRunJson {
  const items: AccuracyItem[] = [
    makeItem({ id: "goalA-01" }),
    makeItem({
      id: "goalA-02",
      actual: { relevance: 0.4, credibility: 2.0 },
      relevance_hit: false,
      credibility_hit: true,
    }),
    makeItem({
      id: "goalB-01",
      actual: { relevance: 2.0, credibility: 0.1 },
      relevance_hit: true,
      credibility_hit: false,
    }),
  ];
  return {
    accuracy: {
      items,
      summary: {
        n: 3,
        relevance_accuracy: 2 / 3,
        credibility_accuracy: 2 / 3,
        mean_confidence: 0.8,
        rubric_version: "1.2.0",
      },
    },
  };
}

const OPTS = { date: "2026-09-19", goalById: STUB_GOAL_BY_ID };

// ---------------------------------------------------------------------------
// Pure renderer
// ---------------------------------------------------------------------------

test("renderDriftReport: headline numbers, per-goal rows, and miss rows all appear", () => {
  const md = renderDriftReport(makeRunJson(), OPTS);

  // Title carries date + rubric version.
  assert.ok(md.includes("2026-09-19"), "date missing from title");
  assert.ok(md.includes("1.2.0"), "rubric version missing from title");

  // Headline table: 2/3 = 66.7% for both axes, n=3, mean confidence 0.80.
  assert.ok(md.includes("66.7%"), "relevance/credibility accuracy percentage missing");
  assert.ok(md.includes("| Items (n) | 3 |"), "n missing from headline table");
  assert.ok(md.includes("0.80"), "mean confidence missing from headline table");

  // Per-goal breakdown: both goal labels present with their own rows.
  assert.ok(md.includes("Test Goal A"), "goal A missing from per-goal breakdown");
  assert.ok(md.includes("Test Goal B"), "goal B missing from per-goal breakdown");
  // Goal A: 1/2 relevance hit, 2/2 credibility hit.
  assert.ok(md.includes("50.0% (1/2)"), "goal A relevance fraction missing");
  // Goal B: 1/1 relevance hit, 0/1 credibility hit.
  assert.ok(md.includes("0.0% (0/1)"), "goal B credibility fraction missing");

  // Miss rows: both missed items named with expected-vs-got detail.
  assert.ok(md.includes("goalA-02"), "relevance-miss item id missing");
  assert.ok(md.includes("relevance miss"), "relevance miss label missing");
  assert.ok(md.includes("goalB-01"), "credibility-miss item id missing");
  assert.ok(md.includes("credibility miss"), "credibility miss label missing");

  // Caveats: n and rounding rule named.
  assert.ok(md.includes("n=3"), "caveats missing sample size");
  assert.ok(md.toLowerCase().includes("rounding"), "caveats missing rounding-rule mention");

  // Reproduction footer.
  assert.ok(md.includes("npm run drift"), "reproduction command missing");
  assert.ok(md.includes("npm run report"), "reproduction command missing report invocation");
});

test("renderDriftReport: no misses produces a clean 'no misses' section", () => {
  const runJson = makeRunJson();
  // Force every item to hit.
  const clean: DriftRunJson = {
    accuracy: {
      items: runJson.accuracy.items.map((i) => ({ ...i, relevance_hit: true, credibility_hit: true })),
      summary: { ...runJson.accuracy.summary, relevance_accuracy: 1, credibility_accuracy: 1 },
    },
  };
  const md = renderDriftReport(clean, OPTS);
  assert.ok(md.includes("No misses this run"), "expected clean-run misses wording");
});

test("renderDriftReport: unmapped item id falls back visibly instead of throwing", () => {
  const runJson: DriftRunJson = {
    accuracy: {
      items: [makeItem({ id: "totally-unknown-item-99" })],
      summary: { n: 1, relevance_accuracy: 1, credibility_accuracy: 1, mean_confidence: 0.8, rubric_version: "1.2.0" },
    },
  };
  const md = renderDriftReport(runJson, OPTS);
  assert.ok(md.includes("unmapped"), "expected an explicit unmapped-goal marker");
});

// ---------------------------------------------------------------------------
// Banner-prefixed input parsing
// ---------------------------------------------------------------------------

test("parseRunJson: strips an npm banner before the first '{'", () => {
  const runJson = makeRunJson();
  const banner = "> jev-scout@0.1.0 drift\n> node --experimental-strip-types src/drift.ts\n\n";
  const raw = banner + JSON.stringify(runJson, null, 2);

  const parsed = parseRunJson(raw);
  assert.deepEqual(parsed.accuracy, runJson.accuracy);
});

test("parseRunJson: plain JSON with no banner still parses", () => {
  const runJson = makeRunJson();
  const parsed = parseRunJson(JSON.stringify(runJson));
  assert.deepEqual(parsed.accuracy, runJson.accuracy);
});

test("parseRunJson: throws a clear error when there is no JSON object at all", () => {
  assert.throws(() => parseRunJson("no json here"), /no '\{' found/);
});

test("parseRunJson: throws a clear error when 'accuracy' is missing", () => {
  assert.throws(() => parseRunJson(JSON.stringify({ drift: {} })), /accuracy/);
});

// ---------------------------------------------------------------------------
// Drift section: absent (baseline established) vs present (drifted items)
// ---------------------------------------------------------------------------

test("renderDriftReport: no drift field and no --prev => baseline-established wording", () => {
  const md = renderDriftReport(makeRunJson(), OPTS);
  assert.ok(
    md.includes("First run — baseline established"),
    "expected baseline-established wording when drift is absent",
  );
});

test("renderDriftReport: drift field present => drifted-items wording and numbers", () => {
  const runJson: DriftRunJson = {
    ...makeRunJson(),
    drift: {
      items: [
        {
          id: "goalA-01",
          baseline: { relevance: 1.5, credibility: 1.5 },
          actual: { relevance: 2.0, credibility: 1.5 },
          relevance_delta: 0.5,
          credibility_delta: 0,
          drifted: true,
        },
        {
          id: "goalA-02",
          baseline: { relevance: 0.4, credibility: 2.0 },
          actual: { relevance: 0.4, credibility: 2.0 },
          relevance_delta: 0,
          credibility_delta: 0,
          drifted: false,
        },
      ],
      summary: { items_drifted: 1, max_delta: 0.5, rubric_version_match: true },
    },
  };

  const md = renderDriftReport(runJson, OPTS);
  assert.ok(md.includes("1 / 2"), "expected items_drifted/total in the drift table");
  assert.ok(md.toLowerCase().includes("drifted"), "expected 'drifted' wording");
  assert.ok(md.includes("goalA-01"), "expected the drifted item to be named");
  assert.ok(!md.includes("First run — baseline established"), "should not show baseline-established wording");
});

test("renderDriftReport: no drift field but --prev supplied => computes report-to-report drift", () => {
  const current = makeRunJson();
  const prev: DriftRunJson = {
    accuracy: {
      items: current.accuracy.items.map((i) =>
        i.id === "goalA-01" ? { ...i, actual: { relevance: 1.4, credibility: 2.0 } } : i,
      ),
      summary: current.accuracy.summary,
    },
  };

  const md = renderDriftReport(current, { ...OPTS, prevRunJson: prev });
  assert.ok(md.includes("--prev"), "expected a note that --prev was used for drift");
  assert.ok(md.includes("goalA-01"), "expected the drifted item (delta 0.6) to be listed");
  assert.ok(!md.includes("First run — baseline established"));
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test("renderDriftReport: identical input produces an identical string", () => {
  const runJson = makeRunJson();
  const a = renderDriftReport(runJson, OPTS);
  const b = renderDriftReport(runJson, { ...OPTS });
  assert.equal(a, b);
});

// ---------------------------------------------------------------------------
// buildGoalIndex
// ---------------------------------------------------------------------------

test("buildGoalIndex: builds an id -> goal map from golden-fixture-shaped items", () => {
  const index = buildGoalIndex([
    { id: "x-01", goal: "goal X" },
    { id: "x-02", goal: "goal X" },
    { id: "y-01", goal: "goal Y" },
  ]);
  assert.deepEqual(index, { "x-01": "goal X", "x-02": "goal X", "y-01": "goal Y" });
});
