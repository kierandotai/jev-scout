import { test } from "node:test";
import assert from "node:assert/strict";

import { createBudget } from "../src/budget.ts";

test("10 concurrent Promise.all reserves against maxCalls 5 -> exactly 5 succeed", async () => {
  const budget = createBudget({ maxCalls: 5, maxSpendUsd: 1, maxJudgedPerSearch: 8 });

  // reserve() is synchronous; wrapping it in Promise.resolve() still calls it
  // synchronously as the array is built, so this is a real atomicity check —
  // not just a sequential loop dressed up as concurrent.
  const results = await Promise.all(
    Array.from({ length: 10 }, () => Promise.resolve(budget.reserve())),
  );

  const succeeded = results.filter((r) => r === true).length;
  assert.equal(succeeded, 5);
  assert.equal(results.filter((r) => r === false).length, 5);
  assert.equal(budget.state().callsUsed, 5);
  assert.equal(budget.state().callsRemaining, 0);
  assert.deepEqual(budget.state().exhausted, { limit: "calls" });
});

test("refund restores call capacity", () => {
  const budget = createBudget({ maxCalls: 2, maxSpendUsd: 1, maxJudgedPerSearch: 8 });

  assert.equal(budget.reserve(), true);
  assert.equal(budget.reserve(), true);
  assert.equal(budget.reserve(), false, "exhausted at 2/2");

  budget.refund();
  assert.equal(budget.state().callsUsed, 1);
  assert.equal(budget.reserve(), true, "refund freed a slot");
  assert.equal(budget.state().callsUsed, 2);
});

test("refund never drives callsUsed negative", () => {
  const budget = createBudget({ maxCalls: 5, maxSpendUsd: 1, maxJudgedPerSearch: 8 });
  budget.refund(3);
  assert.equal(budget.state().callsUsed, 0);
});

test("spend-limit exhaustion mid-sequence stops reserves and names the spend limit", () => {
  const budget = createBudget({ maxCalls: 100, maxSpendUsd: 0.001, maxJudgedPerSearch: 8 });

  assert.equal(budget.reserve(), true);
  budget.record(0.0015); // overshoots the $0.001 cap on this one recorded call

  assert.equal(budget.state().spendUsd, 0.0015);
  assert.deepEqual(budget.state().exhausted, { limit: "spend" });

  // Further reserves are refused now that spend has crossed the cap, even
  // though calls are nowhere near their own limit.
  assert.equal(budget.reserve(), false);
  assert.equal(budget.state().callsUsed, 1, "the refused reserve did not mutate callsUsed");
});

test("one-overshoot spend semantics: the crossing call is allowed through", () => {
  const budget = createBudget({ maxCalls: 100, maxSpendUsd: 0.01, maxJudgedPerSearch: 8 });

  // Pre-check passes because spend is still under the cap at reserve time...
  assert.equal(budget.reserve(), true);
  // ...even though the call's actual recorded cost pushes spend over the cap.
  budget.record(0.02);
  assert.equal(budget.state().spendUsd, 0.02);
  assert.ok(budget.state().spendUsd > 0.01, "the one overshoot is reflected in recorded spend");

  // The NEXT reserve, not this one, is where enforcement bites.
  assert.equal(budget.reserve(), false);
});

test("over80 flags flip at the right points for calls", () => {
  const budget = createBudget({ maxCalls: 10, maxSpendUsd: 1, maxJudgedPerSearch: 8 });

  for (let i = 0; i < 7; i++) budget.reserve();
  assert.equal(budget.state().over80.calls, false, "7/10 = 70%, below 80%");

  budget.reserve(); // 8/10 = 80%
  assert.equal(budget.state().over80.calls, true);
});

test("over80 flags flip at the right points for spend", () => {
  const budget = createBudget({ maxCalls: 100, maxSpendUsd: 1, maxJudgedPerSearch: 8 });

  budget.reserve();
  budget.record(0.79);
  assert.equal(budget.state().over80.spend, false, "79%, below 80%");

  budget.record(0.02); // 0.81 -> 81%
  assert.equal(budget.state().over80.spend, true);
});

test("exhausted is false while under both caps", () => {
  const budget = createBudget({ maxCalls: 5, maxSpendUsd: 1, maxJudgedPerSearch: 8 });
  budget.reserve();
  budget.record(0.01);
  assert.equal(budget.state().exhausted, false);
});

test("state() reports remaining calls and spend", () => {
  const budget = createBudget({ maxCalls: 5, maxSpendUsd: 0.5, maxJudgedPerSearch: 8 });
  budget.reserve(2);
  budget.record(0.1);

  const state = budget.state();
  assert.equal(state.callsRemaining, 3);
  assert.ok(Math.abs(state.spendRemaining - 0.4) < 1e-9);
  assert.equal(state.judgedPerSearchLimit, 8);
});
