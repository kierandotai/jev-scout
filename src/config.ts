/**
 * Environment parsing for jev-scout. This module only reads process.env and
 * produces a frozen Config object with defaults applied — it does not know
 * about rubrics (see judge.ts for RUBRIC_VERSION) or any other module's
 * internal state.
 */

export type BackendName = "searxng" | "brave" | "ddg";

export type GateMode = "annotate" | "gate";

export interface Config {
  /** Explicit backend selection. Set => that backend only, no fallback. */
  readonly backend: BackendName | undefined;
  readonly searxngUrl: string | undefined;
  readonly braveApiKey: string | undefined;
  readonly mode: GateMode;
  readonly maxCalls: number;
  readonly maxSpendUsd: number;
  readonly maxJudged: number;
  readonly minRelevance: number;
  readonly minCredibility: number;
  readonly dashboardPort: number;
}

const VALID_BACKENDS = new Set<string>(["searxng", "brave", "ddg"]);
const VALID_MODES = new Set<string>(["annotate", "gate"]);

function parseBackend(raw: string | undefined): BackendName | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (!VALID_BACKENDS.has(raw)) {
    throw new Error(
      `JEV_SCOUT_BACKEND must be one of searxng|brave|ddg, got: ${raw}`,
    );
  }
  return raw as BackendName;
}

function parseMode(raw: string | undefined): GateMode {
  if (raw === undefined || raw === "") return "annotate";
  if (!VALID_MODES.has(raw)) {
    throw new Error(`JEV_SCOUT_MODE must be one of annotate|gate, got: ${raw}`);
  }
  return raw as GateMode;
}

function parseNonEmpty(raw: string | undefined): string | undefined {
  return raw === undefined || raw === "" ? undefined : raw;
}

function parseNumber(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`${name} must be a finite number, got: ${raw}`);
  }
  return n;
}

function parseInteger(raw: string | undefined, fallback: number, name: string): number {
  const n = parseNumber(raw, fallback, name);
  if (!Number.isInteger(n)) {
    throw new Error(`${name} must be an integer, got: ${raw}`);
  }
  return n;
}

function buildConfig(env: NodeJS.ProcessEnv): Config {
  return Object.freeze({
    backend: parseBackend(env.JEV_SCOUT_BACKEND),
    searxngUrl: parseNonEmpty(env.SEARXNG_URL),
    braveApiKey: parseNonEmpty(env.BRAVE_API_KEY),
    mode: parseMode(env.JEV_SCOUT_MODE),
    maxCalls: parseInteger(env.JEV_SCOUT_MAX_CALLS, 300, "JEV_SCOUT_MAX_CALLS"),
    maxSpendUsd: parseNumber(env.JEV_SCOUT_MAX_SPEND_USD, 0.05, "JEV_SCOUT_MAX_SPEND_USD"),
    maxJudged: parseInteger(env.JEV_SCOUT_MAX_JUDGED, 8, "JEV_SCOUT_MAX_JUDGED"),
    minRelevance: parseNumber(env.JEV_SCOUT_MIN_RELEVANCE, 1.0, "JEV_SCOUT_MIN_RELEVANCE"),
    minCredibility: parseNumber(env.JEV_SCOUT_MIN_CREDIBILITY, 1.0, "JEV_SCOUT_MIN_CREDIBILITY"),
    dashboardPort: parseInteger(env.JEV_SCOUT_DASHBOARD_PORT, 0, "JEV_SCOUT_DASHBOARD_PORT"),
  });
}

/** Frozen config parsed from process.env at module load time. */
export const config: Config = buildConfig(process.env);

/** Rebuild a Config from an arbitrary env map — used by tests. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  return buildConfig(env);
}
