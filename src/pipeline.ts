/**
 * Orchestration used by both guarded_search and guarded_fetch (U5's
 * composition point over U2–U4's backends/judge/budget/cache/ledger and
 * this unit's own fetcher.ts/gate.ts).
 *
 * runSearch: backend resolve -> dedupe (resolveSearch already dedupes) ->
 * top-k by backend rank -> per result, cache-first judging (skip Jev on a
 * double cache hit; else budget-reserve + one Jev call; else unscored
 * budget_exhausted) -> gate (drop results below threshold in gate mode,
 * never cached) -> ledger.
 *
 * runFetch: gate-mode pre-fetch domain check (no network, no Jev on refusal)
 * -> fetchPage (SSRF-safe) -> budget-reserve + one Jev call on the excerpt ->
 * ledger -> deliver text (Jev/budget failure still delivers content,
 * scored:false / budget_exhausted, per R4/R5's fail-open contract).
 *
 * Every tool call gets its own `search_id`. Jev/backend-judging failures
 * never throw out of the pipeline — they degrade to unscored results.
 */

import { randomUUID } from "node:crypto";

import type { Config } from "./config.ts";
import type { RawResult } from "./backends/types.ts";
import { domainFromUrl, resolveSearch, type BackendSet } from "./backends/resolve.ts";
import {
  RUBRIC_VERSION,
  type ChoiceJudgment,
  type Judge,
  type NoulJudgment,
  type PageJudgment,
  type QueryJudgment,
  type ResultJudgment,
  type ScoreJudgment,
} from "./judge.ts";
import { budgetFieldIfOver80, type Budget, type BudgetState } from "./budget.ts";
import type { ScoreCache } from "./cache.ts";
import type { Ledger } from "./ledger.ts";
import {
  gateResult,
  preFetchGate,
  type CachedCredibilityScores,
  type CachedRelevanceScores,
} from "./gate.ts";
import { fetchPage, type FetchFailureReason } from "./fetcher.ts";

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface PipelineDeps {
  readonly backends: BackendSet;
  readonly judge: Judge;
  readonly budget: Budget;
  readonly cache: ScoreCache;
  readonly ledger: Ledger;
  readonly config: Config;
  /** Session id stamped on every ledger event. Defaults to a fresh UUID. */
  readonly session?: string;
  /** Abort a Jev judgeResult/judgePage call after this many ms. Default 30_000. */
  readonly judgeTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// runSearch types
// ---------------------------------------------------------------------------

export interface RunSearchInput {
  readonly query: string;
  readonly goal?: string | undefined;
  readonly maxResults: number;
}

export interface AnnotatedResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly domain: string;
  readonly scored: boolean;
  readonly budget_exhausted?: boolean;
  /** Set instead of being judged at all — the per-search judged-result cap was hit. */
  readonly judge_skipped?: "judge_cap";
  readonly relevance?: ScoreJudgment;
  readonly credibility?: ScoreJudgment;
  readonly worth_fetching?: NoulJudgment;
}

/** A search result that never made it into `results` — dropped by the gate. */
export interface DroppedResult {
  readonly url: string;
  readonly domain: string;
  readonly reasons: string[];
}

/**
 * The query-level "is this search on task for the goal" judgment. Present on
 * `RunSearchResult` only when `input.goal` was supplied — absent (not even
 * `scored:false`) when there was no goal to judge against, matching
 * `judgeQuery`'s own "no call at all without a goal" contract.
 */
export interface SearchOnTask {
  readonly scored: boolean;
  readonly budget_exhausted?: boolean;
  /** Present only when `scored` is true. */
  readonly probability?: number;
}

export interface RunSearchResult {
  readonly search_id: string;
  readonly results: AnnotatedResult[];
  /** Every gate-dropped result (threshold drops and beyond-cap truncation), gate mode only. */
  readonly dropped: DroppedResult[];
  readonly backends_tried: string[];
  /** Query-level on_task judgment. Only present when a goal was supplied. */
  readonly on_task?: SearchOnTask;
  readonly budget?: BudgetState;
}

// ---------------------------------------------------------------------------
// runFetch types
// ---------------------------------------------------------------------------

export interface RunFetchInput {
  readonly url: string;
  readonly goal?: string | undefined;
}

export type FetchOutcomeReason = FetchFailureReason | "gate_refused";

export interface FetchRefused {
  readonly search_id: string;
  readonly ok: false;
  readonly reason: FetchOutcomeReason;
  readonly detail: string;
}

export interface FetchDelivered {
  readonly search_id: string;
  readonly ok: true;
  readonly url: string;
  readonly finalUrl: string;
  readonly scored: boolean;
  readonly budget_exhausted?: boolean;
  readonly answered?: NoulJudgment;
  readonly content_class?: ChoiceJudgment;
  readonly steering_risk?: NoulJudgment;
  readonly text: string;
  readonly truncated: boolean;
  readonly budget?: BudgetState;
}

export type RunFetchResult = FetchRefused | FetchDelivered;

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export interface Pipeline {
  runSearch(input: RunSearchInput): Promise<RunSearchResult>;
  runFetch(input: RunFetchInput): Promise<RunFetchResult>;
}

const DEFAULT_JUDGE_TIMEOUT_MS = 30_000;

export function createPipeline(deps: PipelineDeps): Pipeline {
  const { backends, judge, budget, cache, ledger, config } = deps;
  const session = deps.session ?? randomUUID();
  const judgeTimeoutMs = deps.judgeTimeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS;

  // Once-flag: emit the "budget" ledger event on the FIRST budget-reserve
  // failure this pipeline instance sees, across both runSearch and runFetch.
  let budgetEventEmitted = false;

  function emitBudgetExhaustedOnce(search_id: string): void {
    if (budgetEventEmitted) return;
    budgetEventEmitted = true;
    const state = budget.state();
    const limit = state.exhausted === false ? "calls" : state.exhausted.limit;
    ledger.append({
      session,
      search_id,
      type: "budget",
      payload: { limit, callsUsed: state.callsUsed, spendUsd: state.spendUsd },
    });
  }

  // -------------------------------------------------------------------------
  // Per-result judging: cache-first, else budget-gated single Jev call.
  // -------------------------------------------------------------------------

  interface JudgeOneOutcome {
    readonly judgment: ResultJudgment | null;
    readonly cacheHit: boolean;
    readonly budgetExhausted: boolean;
    readonly latencyMs?: number;
  }

  async function judgeOneResult(result: RawResult, input: RunSearchInput): Promise<JudgeOneOutcome> {
    const relEntry = cache.getRelevance(input.query, input.goal, result.url);
    const credEntry = cache.getCredibility(result.domain, RUBRIC_VERSION);

    if (relEntry !== undefined && credEntry !== undefined) {
      const relScores = relEntry.scores;
      const credScores = credEntry.scores;
      const judgment: ResultJudgment = {
        relevance: relScores.relevance,
        credibility: credScores.credibility,
        worth_fetching: relScores.worth_fetching,
        rubric_version: RUBRIC_VERSION,
        usage: { input_tokens: 0, output_tokens: 0 },
        cost_usd: 0,
      };
      return { judgment, cacheHit: true, budgetExhausted: false };
    }

    if (!budget.reserve()) {
      return { judgment: null, cacheHit: false, budgetExhausted: true };
    }

    const start = performance.now();
    try {
      const judgment = await judge.judgeResult(
        {
          goal: input.goal,
          query: input.query,
          result: { title: result.title, snippet: result.snippet, domain: result.domain },
        },
        { signal: AbortSignal.timeout(judgeTimeoutMs) },
      );
      const latencyMs = performance.now() - start;
      budget.record(judgment.cost_usd);

      const judgedAt = Date.now();
      cache.putRelevance(input.query, input.goal, result.url, {
        scores: { relevance: judgment.relevance, worth_fetching: judgment.worth_fetching },
        confidence: judgment.relevance.confidence,
        rubric_version: RUBRIC_VERSION,
        judged_at: judgedAt,
      });
      cache.putCredibility(result.domain, RUBRIC_VERSION, {
        scores: { credibility: judgment.credibility },
        confidence: judgment.credibility.confidence,
        rubric_version: RUBRIC_VERSION,
        judged_at: judgedAt,
      });

      return { judgment, cacheHit: false, budgetExhausted: false, latencyMs };
    } catch {
      // Jev failure fails open: refund the reservation, deliver unscored.
      budget.refund();
      return { judgment: null, cacheHit: false, budgetExhausted: false };
    }
  }

  // -------------------------------------------------------------------------
  // Query-level on_task judging: one budget-reserved judgeQuery call per
  // search, only when a goal is supplied. Same reserve -> call (with the
  // shared judgeTimeoutMs signal) -> record cost -> refund+fail-open-on-error
  // pattern as judgeOneResult/judgePage; budget exhaustion never blocks the
  // search, it just skips the call and marks the result unscored.
  // -------------------------------------------------------------------------

  interface OnTaskOutcome {
    readonly onTask: SearchOnTask | undefined;
    readonly budgetExhausted: boolean;
    readonly judgment?: QueryJudgment;
    readonly latencyMs?: number;
  }

  async function judgeQueryOnce(input: RunSearchInput): Promise<OnTaskOutcome> {
    const goal = input.goal;
    if (goal === undefined || goal.trim() === "") {
      return { onTask: undefined, budgetExhausted: false };
    }

    if (!budget.reserve()) {
      return { onTask: { scored: false, budget_exhausted: true }, budgetExhausted: true };
    }

    const start = performance.now();
    try {
      const judgment = await judge.judgeQuery(
        { goal, query: input.query },
        { signal: AbortSignal.timeout(judgeTimeoutMs) },
      );

      if (judgment === null) {
        // judgeQuery's contract is "null only when there is no goal" — we
        // already checked that above, so this is unexpected. Treat it as if
        // no call happened at all: refund, surface no on_task field.
        budget.refund();
        return { onTask: undefined, budgetExhausted: false };
      }

      const latencyMs = performance.now() - start;
      budget.record(judgment.cost_usd);
      return {
        onTask: { scored: true, probability: judgment.on_task.probability },
        budgetExhausted: false,
        judgment,
        latencyMs,
      };
    } catch {
      // Jev failure fails open: refund the reservation, deliver unscored.
      budget.refund();
      return { onTask: { scored: false }, budgetExhausted: false };
    }
  }

  async function runSearch(input: RunSearchInput): Promise<RunSearchResult> {
    const search_id = randomUUID();

    const onTaskOutcome = await judgeQueryOnce(input);
    if (onTaskOutcome.budgetExhausted) emitBudgetExhaustedOnce(search_id);

    ledger.append({
      session,
      search_id,
      type: "search",
      payload: {
        query: input.query,
        goal: input.goal,
        maxResults: input.maxResults,
        ...(onTaskOutcome.onTask ? { on_task: onTaskOutcome.onTask } : {}),
      },
      ...(onTaskOutcome.judgment
        ? { jev: { cost_usd: onTaskOutcome.judgment.cost_usd, rubric_version: onTaskOutcome.judgment.rubric_version } }
        : {}),
      ...(onTaskOutcome.latencyMs !== undefined ? { latency_ms: onTaskOutcome.latencyMs } : {}),
    });

    const chain = await resolveSearch(config, backends, input.query, input.maxResults);
    const k = Math.min(config.maxJudged, chain.results.length);
    const topK = chain.results.slice(0, k);
    const beyondCap = chain.results.slice(k);

    const results: AnnotatedResult[] = [];
    const dropped: DroppedResult[] = [];

    for (let rank = 0; rank < topK.length; rank++) {
      const result = topK[rank]!;
      const outcome = await judgeOneResult(result, input);
      if (outcome.budgetExhausted) emitBudgetExhaustedOnce(search_id);
      const gate = gateResult(outcome.judgment, config);

      ledger.append({
        session,
        search_id,
        type: "result",
        payload: {
          url: result.url,
          title: result.title,
          domain: result.domain,
          rank,
          cache_hit: outcome.cacheHit,
          scored: gate.scored,
          budget_exhausted: outcome.budgetExhausted ?? false,
          action: gate.action,
          ...(outcome.judgment
            ? {
                relevance: outcome.judgment.relevance.score,
                relevance_confidence: outcome.judgment.relevance.confidence,
                credibility: outcome.judgment.credibility.score,
                credibility_confidence: outcome.judgment.credibility.confidence,
                worth_fetching: outcome.judgment.worth_fetching.probability,
              }
            : {}),
        },
        ...(outcome.judgment && !outcome.cacheHit
          ? { jev: { cost_usd: outcome.judgment.cost_usd, rubric_version: outcome.judgment.rubric_version } }
          : {}),
        ...(outcome.latencyMs !== undefined ? { latency_ms: outcome.latencyMs } : {}),
      });

      if (gate.action === "drop") {
        ledger.append({
          session,
          search_id,
          type: "gate",
          payload: { url: result.url, domain: result.domain, reasons: gate.reasons },
        });
        dropped.push({ url: result.url, domain: result.domain, reasons: gate.reasons });
        continue;
      }

      results.push({
        title: result.title,
        url: result.url,
        snippet: result.snippet,
        domain: result.domain,
        scored: gate.scored,
        ...(outcome.budgetExhausted ? { budget_exhausted: true } : {}),
        ...(outcome.judgment
          ? {
              relevance: outcome.judgment.relevance,
              credibility: outcome.judgment.credibility,
              worth_fetching: outcome.judgment.worth_fetching,
            }
          : {}),
      });
    }

    // Beyond top-k: never silently vanish. Annotate mode returns them
    // unscored with judge_skipped; gate mode must never let an unjudged
    // result bypass the gate, so they are truncated — tracked in `dropped`
    // and recorded as one ledger event (not one per result, to avoid spam).
    if (beyondCap.length > 0) {
      if (config.mode === "annotate") {
        for (const result of beyondCap) {
          results.push({
            title: result.title,
            url: result.url,
            snippet: result.snippet,
            domain: result.domain,
            scored: false,
            judge_skipped: "judge_cap",
          });
        }
      } else {
        for (const result of beyondCap) {
          dropped.push({ url: result.url, domain: result.domain, reasons: ["judge_cap_unjudged"] });
        }
        ledger.append({
          session,
          search_id,
          type: "gate",
          payload: { dropped_beyond_cap: beyondCap.length },
        });
      }
    }

    const budgetField = budgetFieldIfOver80(budget);

    return {
      search_id,
      results,
      dropped,
      backends_tried: chain.backendsTried,
      ...(onTaskOutcome.onTask ? { on_task: onTaskOutcome.onTask } : {}),
      ...(budgetField ? { budget: budgetField } : {}),
    };
  }

  async function runFetch(input: RunFetchInput): Promise<RunFetchResult> {
    const search_id = randomUUID();
    const domain = domainFromUrl(input.url);

    if (config.mode === "gate" && domain !== undefined) {
      const check = preFetchGate(domain, cache, config);
      if (!check.allow) {
        ledger.append({
          session,
          search_id,
          type: "gate",
          payload: { url: input.url, domain, goal: input.goal, reason: check.reason },
        });
        return { search_id, ok: false, reason: "gate_refused", detail: check.reason! };
      }
    }

    const fetched = await fetchPage(input.url);
    if (!fetched.ok) {
      ledger.append({
        session,
        search_id,
        type: "fetch",
        payload: { url: input.url, goal: input.goal, ok: false, reason: fetched.reason, detail: fetched.detail },
      });
      return { search_id, ok: false, reason: fetched.reason, detail: fetched.detail };
    }

    let judgment: PageJudgment | null = null;
    let budgetExhausted = false;
    let latencyMs: number | undefined;

    if (budget.reserve()) {
      const start = performance.now();
      try {
        judgment = await judge.judgePage(
          {
            goal: input.goal,
            url: fetched.finalUrl,
            excerpt: fetched.text,
          },
          { signal: AbortSignal.timeout(judgeTimeoutMs) },
        );
        latencyMs = performance.now() - start;
        budget.record(judgment.cost_usd);
      } catch {
        budget.refund();
        judgment = null;
      }
    } else {
      budgetExhausted = true;
      emitBudgetExhaustedOnce(search_id);
    }

    ledger.append({
      session,
      search_id,
      type: "fetch",
      payload: {
        url: input.url,
        finalUrl: fetched.finalUrl,
        goal: input.goal,
        contentHash: fetched.contentHash,
        truncated: fetched.truncated,
        scored: judgment !== null,
        budget_exhausted: budgetExhausted,
        ...(judgment
          ? {
              answered: judgment.answered.probability,
              content_class: judgment.content_class.choice,
              steering_risk: judgment.steering_risk.probability,
            }
          : {}),
      },
      ...(judgment ? { jev: { cost_usd: judgment.cost_usd, rubric_version: judgment.rubric_version } } : {}),
      ...(latencyMs !== undefined ? { latency_ms: latencyMs } : {}),
    });

    const budgetField = budgetFieldIfOver80(budget);

    return {
      search_id,
      ok: true,
      url: input.url,
      finalUrl: fetched.finalUrl,
      scored: judgment !== null,
      ...(budgetExhausted ? { budget_exhausted: true } : {}),
      ...(judgment
        ? {
            answered: judgment.answered,
            content_class: judgment.content_class,
            steering_risk: judgment.steering_risk,
          }
        : {}),
      text: fetched.text,
      truncated: fetched.truncated,
      ...(budgetField ? { budget: budgetField } : {}),
    };
  }

  return { runSearch, runFetch };
}
