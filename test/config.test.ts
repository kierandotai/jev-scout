/**
 * F13: loadConfig — invalid env values throw clear, actionable messages;
 * an empty env produces the documented defaults.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../src/config.ts";

// ---------------------------------------------------------------------------
// Happy path: defaults
// ---------------------------------------------------------------------------

test("loadConfig({}) produces the documented defaults", () => {
  const config = loadConfig({});

  assert.equal(config.backend, undefined);
  assert.equal(config.searxngUrl, undefined);
  assert.equal(config.braveApiKey, undefined);
  assert.equal(config.mode, "annotate");
  assert.equal(config.maxCalls, 300);
  assert.equal(config.maxSpendUsd, 0.05);
  assert.equal(config.maxJudged, 8);
  assert.equal(config.minRelevance, 1.0);
  assert.equal(config.minCredibility, 1.0);
  assert.equal(config.dashboardPort, 0);
  assert.ok(Object.isFrozen(config), "Config must be frozen");
});

test("loadConfig accepts every documented env var and overrides the matching default", () => {
  const config = loadConfig({
    JEV_SCOUT_BACKEND: "brave",
    SEARXNG_URL: "http://localhost:8080",
    BRAVE_API_KEY: "brave-key",
    JEV_SCOUT_MODE: "gate",
    JEV_SCOUT_MAX_CALLS: "42",
    JEV_SCOUT_MAX_SPEND_USD: "1.5",
    JEV_SCOUT_MAX_JUDGED: "3",
    JEV_SCOUT_MIN_RELEVANCE: "1.4",
    JEV_SCOUT_MIN_CREDIBILITY: "1.6",
    JEV_SCOUT_DASHBOARD_PORT: "9999",
  } as NodeJS.ProcessEnv);

  assert.equal(config.backend, "brave");
  assert.equal(config.searxngUrl, "http://localhost:8080");
  assert.equal(config.braveApiKey, "brave-key");
  assert.equal(config.mode, "gate");
  assert.equal(config.maxCalls, 42);
  assert.equal(config.maxSpendUsd, 1.5);
  assert.equal(config.maxJudged, 3);
  assert.equal(config.minRelevance, 1.4);
  assert.equal(config.minCredibility, 1.6);
  assert.equal(config.dashboardPort, 9999);
});

test("empty-string env values are treated as unset, falling back to defaults", () => {
  const config = loadConfig({
    JEV_SCOUT_BACKEND: "",
    SEARXNG_URL: "",
    BRAVE_API_KEY: "",
    JEV_SCOUT_MODE: "",
    JEV_SCOUT_MAX_CALLS: "",
  } as NodeJS.ProcessEnv);

  assert.equal(config.backend, undefined);
  assert.equal(config.searxngUrl, undefined);
  assert.equal(config.braveApiKey, undefined);
  assert.equal(config.mode, "annotate");
  assert.equal(config.maxCalls, 300);
});

// ---------------------------------------------------------------------------
// Invalid values throw, with a clear, actionable message naming the var and
// the bad value.
// ---------------------------------------------------------------------------

test("invalid JEV_SCOUT_BACKEND throws naming the var, the allowed values, and what was given", () => {
  assert.throws(
    () => loadConfig({ JEV_SCOUT_BACKEND: "google" } as NodeJS.ProcessEnv),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /JEV_SCOUT_BACKEND/);
      assert.match(err.message, /searxng\|brave\|ddg/);
      assert.match(err.message, /google/);
      return true;
    },
  );
});

test("invalid JEV_SCOUT_MODE throws naming the var, the allowed values, and what was given", () => {
  assert.throws(
    () => loadConfig({ JEV_SCOUT_MODE: "strict" } as NodeJS.ProcessEnv),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /JEV_SCOUT_MODE/);
      assert.match(err.message, /annotate\|gate/);
      assert.match(err.message, /strict/);
      return true;
    },
  );
});

test("non-numeric JEV_SCOUT_MAX_SPEND_USD throws naming the var and what was given", () => {
  assert.throws(
    () => loadConfig({ JEV_SCOUT_MAX_SPEND_USD: "not-a-number" } as NodeJS.ProcessEnv),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /JEV_SCOUT_MAX_SPEND_USD/);
      assert.match(err.message, /finite number/);
      assert.match(err.message, /not-a-number/);
      return true;
    },
  );
});

test("non-integer JEV_SCOUT_MAX_CALLS throws naming the var and what was given", () => {
  assert.throws(
    () => loadConfig({ JEV_SCOUT_MAX_CALLS: "3.5" } as NodeJS.ProcessEnv),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /JEV_SCOUT_MAX_CALLS/);
      assert.match(err.message, /integer/);
      assert.match(err.message, /3\.5/);
      return true;
    },
  );
});

test("non-numeric JEV_SCOUT_MAX_CALLS throws (fails the finite-number check before the integer check)", () => {
  assert.throws(
    () => loadConfig({ JEV_SCOUT_MAX_CALLS: "lots" } as NodeJS.ProcessEnv),
    /JEV_SCOUT_MAX_CALLS must be a finite number, got: lots/,
  );
});

test("non-integer JEV_SCOUT_DASHBOARD_PORT throws naming the var", () => {
  assert.throws(
    () => loadConfig({ JEV_SCOUT_DASHBOARD_PORT: "8080.5" } as NodeJS.ProcessEnv),
    /JEV_SCOUT_DASHBOARD_PORT/,
  );
});
