/**
 * Annotate/gate decision layer (R5). Pure functions only — no Jev calls, no
 * network, no mutation. Gate thresholds are always applied at READ time, per
 * the KTD: cache entries store raw scores, never a baked-in pass/drop, so a
 * threshold change between two calls re-evaluates the same cached score.
 *
 * `gateResult` decides what happens to an already-judged (or judgment-less)
 * search result. `preFetchGate` is the deterministic, Jev-free check that
 * runs before `guarded_fetch` does any network I/O in gate mode: a domain
 * that already carries a below-threshold cached credibility judgment this
 * session is refused outright, no Jev call needed.
 */

import type { GateMode } from "./config.ts";
import { RUBRIC_VERSION, type NoulJudgment, type ResultJudgment, type ScoreJudgment } from "./judge.ts";
import type { ScoreCache } from "./cache.ts";

/** The slice of Config that gate.ts needs — any object with these fields works. */
export interface GateConfig {
  readonly mode: GateMode;
  readonly minRelevance: number;
  readonly minCredibility: number;
}

export interface GateDecision {
  readonly action: "pass" | "drop";
  readonly reasons: string[];
  readonly scored: boolean;
  /** Set by the caller (pipeline.ts), never by gateResult itself — see budget.ts. */
  readonly budget_exhausted?: boolean;
}

/**
 * Decide pass/drop for one already-judged result.
 * - `judgment === null` (Jev failed, or was never attempted) always passes,
 *   unscored — fail-open, regardless of mode.
 * - `annotate` mode always passes, scored.
 * - `gate` mode drops when relevance OR credibility falls below its
 *   threshold, recomputed fresh from `config` every call — never cached.
 */
export function gateResult(judgment: ResultJudgment | null, config: GateConfig): GateDecision {
  if (judgment === null) {
    return { action: "pass", reasons: [], scored: false };
  }
  if (config.mode === "annotate") {
    return { action: "pass", reasons: [], scored: true };
  }

  const reasons: string[] = [];
  if (judgment.relevance.score < config.minRelevance) {
    reasons.push(
      `relevance ${judgment.relevance.score.toFixed(2)} is below the gate threshold ${config.minRelevance}`,
    );
  }
  if (judgment.credibility.score < config.minCredibility) {
    reasons.push(
      `credibility ${judgment.credibility.score.toFixed(2)} is below the gate threshold ${config.minCredibility}`,
    );
  }
  return { action: reasons.length > 0 ? "drop" : "pass", reasons, scored: true };
}

// ---------------------------------------------------------------------------
// Cache score shapes — the contract between what pipeline.ts writes into the
// two cache tiers and what gate.ts (preFetchGate) reads back out of them.
// Exported so pipeline.ts uses the exact same shapes when populating the cache.
// ---------------------------------------------------------------------------

export interface CachedRelevanceScores {
  readonly relevance: ScoreJudgment;
  readonly worth_fetching: NoulJudgment;
}

export interface CachedCredibilityScores {
  readonly credibility: ScoreJudgment;
}

export interface PreFetchGateResult {
  readonly allow: boolean;
  readonly reason?: string;
}

/**
 * Gate-mode-only, deterministic, no Jev call: refuse a fetch outright when
 * `domain` already carries a below-threshold cached credibility judgment.
 * Annotate mode, or no cache entry for the domain, always allows.
 */
export function preFetchGate(
  domain: string,
  cache: Pick<ScoreCache, "getCredibility">,
  config: GateConfig,
): PreFetchGateResult {
  if (config.mode === "annotate") return { allow: true };

  const cached = cache.getCredibility(domain, RUBRIC_VERSION);
  if (cached === undefined) return { allow: true };

  const credibility = (cached.scores as unknown as CachedCredibilityScores).credibility;
  if (credibility === undefined) return { allow: true };

  if (credibility.score < config.minCredibility) {
    return {
      allow: false,
      reason:
        `domain "${domain}" has a cached credibility score of ${credibility.score.toFixed(2)}, ` +
        `below the gate threshold ${config.minCredibility}`,
    };
  }
  return { allow: true };
}
