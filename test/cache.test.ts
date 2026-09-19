import { test } from "node:test";
import assert from "node:assert/strict";

import { createCache, type CacheEntry } from "../src/cache.ts";

function entry(scores: Record<string, unknown>, judgedAt: number, rubricVersion = "1.0.0"): CacheEntry {
  return { scores, confidence: 0.9, rubric_version: rubricVersion, judged_at: judgedAt };
}

/** A fake clock so TTL tests never need to sleep in real time. */
function fakeClock(startMs = 0) {
  let now = startMs;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

test("relevance hit within TTL returns the cached entry (no recompute needed)", () => {
  const clock = fakeClock();
  const cache = createCache({ now: clock.now });
  let judgeCalls = 0;

  function judge(query: string, goal: string | undefined, url: string): CacheEntry {
    const cached = cache.getRelevance(query, goal, url);
    if (cached !== undefined) return cached;
    judgeCalls++;
    const fresh = entry({ relevance: 2 }, clock.now());
    cache.putRelevance(query, goal, url, fresh);
    return fresh;
  }

  const first = judge("weather today", "plan a trip", "https://example.com/a");
  clock.advance(60_000); // well within the 15min TTL
  const second = judge("weather today", "plan a trip", "https://example.com/a");

  assert.equal(judgeCalls, 1, "second lookup was a cache hit, not a recompute");
  assert.deepEqual(second, first);
});

test("relevance entry expires past TTL -> miss", () => {
  const clock = fakeClock();
  const cache = createCache({ relevanceTtlMs: 1000, now: clock.now });

  cache.putRelevance("q", "g", "https://example.com", entry({ relevance: 1 }, clock.now()));
  assert.ok(cache.getRelevance("q", "g", "https://example.com") !== undefined, "hit before TTL");

  clock.advance(1001);
  assert.equal(cache.getRelevance("q", "g", "https://example.com"), undefined, "miss after TTL");
});

test("credibility entry expires past TTL -> miss", () => {
  const clock = fakeClock();
  const cache = createCache({ credibilityTtlMs: 1000, now: clock.now });

  cache.putCredibility("docs.example.com", "1.0.0", entry({ credibility: 2 }, clock.now()));
  clock.advance(1001);
  assert.equal(cache.getCredibility("docs.example.com", "1.0.0"), undefined);
});

test("credibility rubric version bump -> miss even for the same domain", () => {
  const cache = createCache();
  cache.putCredibility("docs.example.com", "1.0.0", entry({ credibility: 2 }, 0));

  assert.ok(cache.getCredibility("docs.example.com", "1.0.0") !== undefined);
  assert.equal(cache.getCredibility("docs.example.com", "2.0.0"), undefined, "rubric bump misses");
});

test("credibility hit for the same domain across different query/url", () => {
  const cache = createCache();
  cache.putCredibility("docs.example.com", "1.0.0", entry({ credibility: 2 }, 0));

  // Credibility is domain-scoped only — the cache has no notion of query/url
  // for this tier, so two unrelated lookups against the same domain both hit.
  const hit = cache.getCredibility("docs.example.com", "1.0.0");
  assert.deepEqual(hit, entry({ credibility: 2 }, 0));
});

test("put always overwrites: a fresh judgment supersedes the cached one", () => {
  const cache = createCache();
  cache.putRelevance("q", "g", "https://example.com", entry({ relevance: 0 }, 0));
  cache.putRelevance("q", "g", "https://example.com", entry({ relevance: 2 }, 1));

  const hit = cache.getRelevance("q", "g", "https://example.com");
  assert.deepEqual(hit, entry({ relevance: 2 }, 1));
});

test("relevance key distinguishes goal present vs goal absent", () => {
  const cache = createCache();
  cache.putRelevance("q", undefined, "https://example.com", entry({ relevance: 0 }, 0));
  cache.putRelevance("q", "some goal", "https://example.com", entry({ relevance: 2 }, 0));

  const withoutGoal = cache.getRelevance("q", undefined, "https://example.com");
  const withGoal = cache.getRelevance("q", "some goal", "https://example.com");

  assert.notDeepEqual(withoutGoal, withGoal);
  assert.equal((withoutGoal?.scores as { relevance: number }).relevance, 0);
  assert.equal((withGoal?.scores as { relevance: number }).relevance, 2);
});

test("relevance key distinguishes different urls for the same query/goal", () => {
  const cache = createCache();
  cache.putRelevance("q", "g", "https://a.example.com", entry({ relevance: 2 }, 0));
  assert.equal(cache.getRelevance("q", "g", "https://b.example.com"), undefined);
});

test("relevance miss on an unseen key returns undefined", () => {
  const cache = createCache();
  assert.equal(cache.getRelevance("never seen", undefined, "https://example.com"), undefined);
});
