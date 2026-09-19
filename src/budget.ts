/**
 * Atomic per-session budget: hard caps on Jev call count and spend, plus the
 * (informational) per-search judged-result cap that callers (pipeline.ts)
 * enforce by only reserving top-k results.
 *
 * `reserve`/`refund`/`record` are synchronous. Node is single-threaded, so a
 * synchronous check-and-mutate with no `await` between the check and the
 * mutation is atomic by construction — no lock is needed, but the invariant
 * only holds because every mutation here stays synchronous.
 *
 * Spend semantics allow exactly one overshoot: `reserve()` only refuses once
 * spend has ALREADY reached the cap (i.e. a prior `record()` pushed it
 * there). The call that first crosses the cap was reserved while spend was
 * still under it, so it is allowed to complete and record its actual cost —
 * only the next reservation attempt is refused. This matches the plan's
 * "pre-check estimated [as: not yet over], allow one overshoot, record
 * actual" spend semantics without needing a per-call cost estimate.
 */

export interface BudgetLimits {
  readonly maxCalls: number;
  readonly maxSpendUsd: number;
  readonly maxJudgedPerSearch: number;
}

export interface BudgetExhausted {
  readonly limit: "calls" | "spend";
}

export interface Over80 {
  readonly calls: boolean;
  readonly spend: boolean;
}

export interface BudgetState {
  readonly callsUsed: number;
  readonly callsRemaining: number;
  readonly spendUsd: number;
  readonly spendRemaining: number;
  readonly judgedPerSearchLimit: number;
  readonly exhausted: false | BudgetExhausted;
  readonly over80: Over80;
}

export interface Budget {
  /** Atomically reserve `n` calls against the calls/spend caps. */
  reserve(n?: number): boolean;
  /** Give back `n` previously reserved calls (e.g. the dispatch never happened). */
  refund(n?: number): void;
  /** Record the actual cost of a completed Jev call. */
  record(costUsd: number): void;
  state(): BudgetState;
}

const OVER80_FRACTION = 0.8;

export function createBudget(limits: BudgetLimits): Budget {
  let callsUsed = 0;
  let spendUsd = 0;

  function callsExhausted(): boolean {
    return callsUsed >= limits.maxCalls;
  }

  function spendExhausted(): boolean {
    return spendUsd >= limits.maxSpendUsd;
  }

  function exhaustedState(): false | BudgetExhausted {
    if (callsExhausted()) return { limit: "calls" };
    if (spendExhausted()) return { limit: "spend" };
    return false;
  }

  function fractionOver80(used: number, cap: number): boolean {
    return cap > 0 && used / cap >= OVER80_FRACTION;
  }

  return {
    reserve(n = 1) {
      // Synchronous check-and-mutate, no await in between: atomic.
      if (spendExhausted()) return false;
      if (callsUsed + n > limits.maxCalls) return false;
      callsUsed += n;
      return true;
    },

    refund(n = 1) {
      callsUsed = Math.max(0, callsUsed - n);
    },

    record(costUsd) {
      spendUsd += costUsd;
    },

    state() {
      return {
        callsUsed,
        callsRemaining: Math.max(0, limits.maxCalls - callsUsed),
        spendUsd,
        spendRemaining: Math.max(0, limits.maxSpendUsd - spendUsd),
        judgedPerSearchLimit: limits.maxJudgedPerSearch,
        exhausted: exhaustedState(),
        over80: {
          calls: fractionOver80(callsUsed, limits.maxCalls),
          spend: fractionOver80(spendUsd, limits.maxSpendUsd),
        },
      };
    },
  };
}
