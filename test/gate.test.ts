import { test } from "node:test";
import assert from "node:assert/strict";

import { gateResult, preFetchGate, type CachedCredibilityScores, type GateConfig } from "../src/gate.ts";
import { RUBRIC_VERSION, type ResultJudgment } from "../src/judge.ts";
import { createCache, type CacheEntry, type ScoreCache } from "../src/cache.ts";

function scoreJudgment(score: number, confidence = 0.9): ResultJudgment["relevance"] {
  return { score, confidence, probabilities: {} };
}

function resultJudgment(relevance: number, credibility: number): ResultJudgment {
  return {
    relevance: scoreJudgment(relevance),
    credibility: scoreJudgment(credibility),
    worth_fetching: { probability: 0.5 },
    rubric_version: RUBRIC_VERSION,
    usage: { input_tokens: 100, output_tokens: 0 },
    cost_usd: 0.0001,
  };
}

const ANNOTATE: GateConfig = { mode: "annotate", minRelevance: 1.0, minCredibility: 1.0 };
const GATE: GateConfig = { mode: "gate", minRelevance: 1.0, minCredibility: 1.0 };

// ---------------------------------------------------------------------------
// gateResult
// ---------------------------------------------------------------------------

test("annotate mode always passes, scored, regardless of how low the scores are", () => {
  const judgment = resultJudgment(0.4, 0.1);
  const decision = gateResult(judgment, ANNOTATE);
  assert.deepEqual(decision, { action: "pass", reasons: [], scored: true });
});

test("gate mode drops a result below the relevance threshold, naming it in reasons", () => {
  const judgment = resultJudgment(0.4, 2.0);
  const decision = gateResult(judgment, GATE);
  assert.equal(decision.action, "drop");
  assert.equal(decision.scored, true);
  assert.equal(decision.reasons.length, 1);
  assert.match(decision.reasons[0]!, /relevance 0\.40 is below the gate threshold 1/);
});

test("gate mode drops a result below the credibility threshold, naming it in reasons", () => {
  const judgment = resultJudgment(2.0, 0.2);
  const decision = gateResult(judgment, GATE);
  assert.equal(decision.action, "drop");
  assert.match(decision.reasons[0]!, /credibility 0\.20 is below the gate threshold 1/);
});

test("gate mode drop carries both reasons when both scores are below threshold", () => {
  const judgment = resultJudgment(0.1, 0.2);
  const decision = gateResult(judgment, GATE);
  assert.equal(decision.action, "drop");
  assert.equal(decision.reasons.length, 2);
});

test("gate mode passes a result at or above both thresholds", () => {
  const judgment = resultJudgment(1.5, 1.5);
  const decision = gateResult(judgment, GATE);
  assert.deepEqual(decision, { action: "pass", reasons: [], scored: true });
});

test("null judgment (Jev failure) always passes unscored, in either mode", () => {
  assert.deepEqual(gateResult(null, ANNOTATE), { action: "pass", reasons: [], scored: false });
  assert.deepEqual(gateResult(null, GATE), { action: "pass", reasons: [], scored: false });
});

test("threshold change between two calls re-evaluates the same judgment: drop then pass", () => {
  const judgment = resultJudgment(1.2, 1.2);
  const strict: GateConfig = { mode: "gate", minRelevance: 1.5, minCredibility: 1.5 };
  const lenient: GateConfig = { mode: "gate", minRelevance: 1.0, minCredibility: 1.0 };

  assert.equal(gateResult(judgment, strict).action, "drop");
  assert.equal(gateResult(judgment, lenient).action, "pass");
});

// ---------------------------------------------------------------------------
// preFetchGate
// ---------------------------------------------------------------------------

function credEntry(score: number, confidence = 0.9): CacheEntry<CachedCredibilityScores> {
  return {
    scores: { credibility: { score, confidence, probabilities: {} } },
    confidence,
    rubric_version: RUBRIC_VERSION,
    judged_at: 0,
  };
}

test("preFetchGate always allows in annotate mode, even with a low cached credibility", () => {
  const cache = createCache();
  cache.putCredibility("spamfarm.example", RUBRIC_VERSION, credEntry(0.1));
  const result = preFetchGate("spamfarm.example", cache, ANNOTATE);
  assert.deepEqual(result, { allow: true });
});

test("preFetchGate allows in gate mode when there is no cache entry for the domain", () => {
  const cache = createCache();
  const result = preFetchGate("unseen.example", cache, GATE);
  assert.deepEqual(result, { allow: true });
});

test("preFetchGate refuses in gate mode when the cached credibility is below threshold, naming domain/score/threshold", () => {
  const cache = createCache();
  cache.putCredibility("spamfarm.example", RUBRIC_VERSION, credEntry(0.3));
  const result = preFetchGate("spamfarm.example", cache, GATE);
  assert.equal(result.allow, false);
  assert.match(result.reason!, /spamfarm\.example/);
  assert.match(result.reason!, /0\.30/);
  assert.match(result.reason!, /1/); // threshold
});

test("preFetchGate allows in gate mode when the cached credibility is at or above threshold", () => {
  const cache = createCache();
  cache.putCredibility("docs.example.com", RUBRIC_VERSION, credEntry(1.8));
  const result = preFetchGate("docs.example.com", cache, GATE);
  assert.deepEqual(result, { allow: true });
});

test("preFetchGate re-evaluates a cached score against the current threshold: refuse then allow", () => {
  const cache = createCache();
  cache.putCredibility("borderline.example", RUBRIC_VERSION, credEntry(1.2));

  const strict: GateConfig = { mode: "gate", minRelevance: 1.0, minCredibility: 1.5 };
  const lenient: GateConfig = { mode: "gate", minRelevance: 1.0, minCredibility: 1.0 };

  assert.equal(preFetchGate("borderline.example", cache, strict).allow, false);
  assert.equal(preFetchGate("borderline.example", cache, lenient).allow, true);
});

test("preFetchGate is keyed on rubric_version: a cache entry under a different version misses (allow)", () => {
  const cache: ScoreCache = createCache();
  cache.putCredibility("spamfarm.example", "9.9.9", credEntry(0.1));
  const result = preFetchGate("spamfarm.example", cache, GATE);
  assert.deepEqual(result, { allow: true });
});
