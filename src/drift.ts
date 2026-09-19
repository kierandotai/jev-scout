/**
 * Accuracy-report core for the golden set (R12 / U9), extended with drift
 * comparison against a pinned baseline (R12 / U8).
 *
 * `runAccuracy` produces a single accuracy-vs-labels report (U9).
 * `compareToBaseline` (U8) diffs a fresh `AccuracyReport` against a
 * previously written `baseline.json`, per-item, on the *actual* scores (not
 * the hit/miss booleans) — drift is about whether Jev's answers moved, which
 * can happen even when both the old and new answers still land inside the
 * labeled band.
 *
 * `main()`'s flow (U8):
 *   1. Run accuracy live (blocked-on-key exit 2 if no live key — unchanged
 *      from U9).
 *   2. If `fixtures/golden/baseline.json` is missing, write it (this run's
 *      report becomes the baseline) and say so.
 *   3. Otherwise, if the baseline's rubric_version no longer matches the
 *      current RUBRIC_VERSION, print re-baseline instructions and exit 3 —
 *      a rubric change invalidates drift comparison and must never be
 *      silently absorbed into "drift".
 *   4. Otherwise, print the two-part report: accuracy vs labels, and drift
 *      vs baseline.
 *
 * `resolveDriftAction` is the pure decision function behind steps 2–4,
 * exported so its branches are unit-testable without touching the
 * filesystem or spawning a process.
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { JevClient } from "jev-client";

import { createJudge, RUBRIC_VERSION, type Judge } from "./judge.ts";

// ---------------------------------------------------------------------------
// Golden set shape
// ---------------------------------------------------------------------------

export interface GoldenResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly domain: string;
}

export interface GoldenLabels {
  /** Inclusive [min, max] relevance band the judged score must fall within. */
  readonly relevance_band: readonly [number, number];
  readonly credibility_level: 0 | 1 | 2;
  readonly notes: string;
}

export interface GoldenItem {
  readonly id: string;
  readonly goal: string;
  readonly query: string;
  readonly result: GoldenResult;
  readonly labels: GoldenLabels;
}

/** Read and JSON-parse a golden set file. Does not validate shape — see test/golden.test.ts. */
export async function loadGoldenSet(path: string): Promise<GoldenItem[]> {
  const raw = await readFile(path, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`golden set at ${path} must be a JSON array, got ${typeof parsed}`);
  }
  return parsed as GoldenItem[];
}

// ---------------------------------------------------------------------------
// Accuracy report
// ---------------------------------------------------------------------------

export interface AccuracyItemResult {
  readonly id: string;
  readonly expected: {
    readonly relevance_band: readonly [number, number];
    readonly credibility_level: number;
  };
  readonly actual: {
    readonly relevance: number;
    readonly credibility: number;
  };
  /** actual.relevance falls within the labeled band, inclusive. */
  readonly relevance_hit: boolean;
  /** Math.round(actual.credibility) equals the labeled level. */
  readonly credibility_hit: boolean;
  /** Mean of the relevance and credibility answer confidences for this item. */
  readonly confidence: number;
}

export interface AccuracySummary {
  readonly n: number;
  readonly relevance_accuracy: number;
  readonly credibility_accuracy: number;
  readonly mean_confidence: number;
  readonly rubric_version: string;
}

export interface AccuracyReport {
  readonly items: readonly AccuracyItemResult[];
  readonly summary: AccuracySummary;
}

export interface RunAccuracyOptions {
  readonly signal?: AbortSignal;
  /** Delay between items (ms); also settable via DRIFT_PACE_MS. Default 0. */
  readonly paceMs?: number;
}

/**
 * Judge every item in the golden set through `judge.judgeResult` and score
 * each judgment against its hand label. One Jev call per item (judgeResult
 * is already one call per result per U3).
 */
export async function runAccuracy(
  judge: Judge,
  goldenSet: readonly GoldenItem[],
  opts: RunAccuracyOptions = {},
): Promise<AccuracyReport> {
  const items: AccuracyItemResult[] = [];
  // Free-tier gateway access rate-limits Jev per minute; pace items and wait
  // out 429s patiently instead of failing the whole run partway through.
  const paceMs = opts.paceMs ?? Number(process.env.DRIFT_PACE_MS ?? 0);
  const waits = [30_000, 60_000, 90_000];

  let first = true;
  for (const item of goldenSet) {
    if (!first && paceMs > 0) await new Promise((r) => setTimeout(r, paceMs));
    first = false;

    const input = {
      goal: item.goal,
      query: item.query,
      result: {
        title: item.result.title,
        snippet: item.result.snippet,
        domain: item.result.domain,
      },
    };
    const callOpts = opts.signal === undefined ? {} : { signal: opts.signal };
    let judgment;
    for (let attempt = 0; ; attempt++) {
      try {
        judgment = await judge.judgeResult(input, callOpts);
        break;
      } catch (err) {
        const status = err instanceof Error && "status" in err ? (err as { status?: number }).status : undefined;
        if (status === 429 && attempt < waits.length) {
          process.stderr.write(`[drift] rate-limited on ${item.id}; waiting ${waits[attempt]! / 1000}s\n`);
          await new Promise((r) => setTimeout(r, waits[attempt]));
          continue;
        }
        throw err;
      }
    }

    const [min, max] = item.labels.relevance_band;
    // Jev returns probability-weighted scores (1.96 means "level 2, 96% sure").
    // Round to the nearest rubric level before band comparison — comparing the
    // continuous score against exact integer bands scores correct judgments as
    // misses (TypeSafe's own "don't interpolate thresholds" jaggedness note,
    // which the first live run demonstrated against this very harness).
    const relevanceLevel = Math.round(judgment.relevance.score);
    const relevance_hit = relevanceLevel >= min && relevanceLevel <= max;
    const credibility_hit =
      Math.round(judgment.credibility.score) === item.labels.credibility_level;
    const confidence = (judgment.relevance.confidence + judgment.credibility.confidence) / 2;

    items.push({
      id: item.id,
      expected: {
        relevance_band: item.labels.relevance_band,
        credibility_level: item.labels.credibility_level,
      },
      actual: {
        relevance: judgment.relevance.score,
        credibility: judgment.credibility.score,
      },
      relevance_hit,
      credibility_hit,
      confidence,
    });
  }

  const n = items.length;
  const relevance_accuracy = n === 0 ? 0 : items.filter((i) => i.relevance_hit).length / n;
  const credibility_accuracy = n === 0 ? 0 : items.filter((i) => i.credibility_hit).length / n;
  const mean_confidence = n === 0 ? 0 : items.reduce((sum, i) => sum + i.confidence, 0) / n;

  return {
    items,
    summary: {
      n,
      relevance_accuracy,
      credibility_accuracy,
      mean_confidence,
      rubric_version: RUBRIC_VERSION,
    },
  };
}

// ---------------------------------------------------------------------------
// Baseline comparison (R12 / U8)
// ---------------------------------------------------------------------------

/** Written to fixtures/golden/baseline.json on the first `npm run drift` run. */
export interface Baseline {
  readonly rubric_version: string;
  readonly written_at: string;
  readonly report: AccuracyReport;
}

export interface DriftItemResult {
  readonly id: string;
  readonly baseline: { readonly relevance: number; readonly credibility: number };
  readonly actual: { readonly relevance: number; readonly credibility: number };
  readonly relevance_delta: number;
  readonly credibility_delta: number;
  /** true when |relevance_delta| > 0.25 or |credibility_delta| > 0.25. */
  readonly drifted: boolean;
}

export interface DriftSummary {
  readonly items_drifted: number;
  readonly max_delta: number;
  readonly rubric_version_match: boolean;
}

export interface DriftReport {
  readonly items: readonly DriftItemResult[];
  readonly summary: DriftSummary;
}

/** |delta| strictly greater than this on either score marks an item drifted. */
export const DRIFT_THRESHOLD = 0.25;

/**
 * Per-item score deltas (actual - baseline) on relevance and credibility,
 * plus a summary. Items present in `report` but absent from `baseline` (or
 * vice versa) are skipped — the golden set is expected to be stable, so a
 * mismatch here is a fixture-authoring problem, not something drift math
 * should paper over silently.
 */
export function compareToBaseline(report: AccuracyReport, baseline: Baseline): DriftReport {
  const baselineById = new Map(baseline.report.items.map((i) => [i.id, i]));

  const items: DriftItemResult[] = [];
  for (const item of report.items) {
    const base = baselineById.get(item.id);
    if (base === undefined) continue;

    const relevance_delta = item.actual.relevance - base.actual.relevance;
    const credibility_delta = item.actual.credibility - base.actual.credibility;
    const drifted =
      Math.abs(relevance_delta) > DRIFT_THRESHOLD || Math.abs(credibility_delta) > DRIFT_THRESHOLD;

    items.push({
      id: item.id,
      baseline: { relevance: base.actual.relevance, credibility: base.actual.credibility },
      actual: { relevance: item.actual.relevance, credibility: item.actual.credibility },
      relevance_delta,
      credibility_delta,
      drifted,
    });
  }

  const max_delta = items.reduce(
    (max, i) => Math.max(max, Math.abs(i.relevance_delta), Math.abs(i.credibility_delta)),
    0,
  );

  return {
    items,
    summary: {
      items_drifted: items.filter((i) => i.drifted).length,
      max_delta,
      rubric_version_match: baseline.rubric_version === report.summary.rubric_version,
    },
  };
}

// ---------------------------------------------------------------------------
// Drift-action decision (pure — unit-testable without touching the filesystem)
// ---------------------------------------------------------------------------

export type DriftAction =
  | { readonly kind: "write_baseline" }
  | { readonly kind: "rebaseline_required"; readonly baselineRubricVersion: string; readonly currentRubricVersion: string }
  | { readonly kind: "report" };

/**
 * Decide what `main()` should do, given whether baseline.json exists and (if
 * so) what rubric_version it was written under. Pure — no I/O.
 */
export function resolveDriftAction(
  baselineExists: boolean,
  baselineRubricVersion: string | undefined,
  currentRubricVersion: string,
): DriftAction {
  if (!baselineExists) return { kind: "write_baseline" };
  if (baselineRubricVersion !== currentRubricVersion) {
    return {
      kind: "rebaseline_required",
      baselineRubricVersion: baselineRubricVersion ?? "(unknown)",
      currentRubricVersion,
    };
  }
  return { kind: "report" };
}

/** Exit code for a rubric_version mismatch against the pinned baseline — distinct from exit 2 (blocked-on-key). */
export const EXIT_REBASELINE_REQUIRED = 3;

// ---------------------------------------------------------------------------
// CLI entry point — accuracy + drift checkpoint (U9 accuracy, U8 drift)
// ---------------------------------------------------------------------------

const DEFAULT_GOLDEN_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "golden",
  "results.json",
);

const DEFAULT_BASELINE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "golden",
  "baseline.json",
);

/** Read and JSON-parse baseline.json. Returns undefined when the file does not exist. */
async function loadBaseline(path: string): Promise<Baseline | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  return JSON.parse(raw) as Baseline;
}

function hasLiveKey(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.OPENROUTER_API_KEY) || Boolean(env.TYPESAFE_API_KEY);
}

async function main(): Promise<void> {
  if (!hasLiveKey(process.env)) {
    console.error(
      "BLOCKED ON KEY: set OPENROUTER_API_KEY to run the live accuracy checkpoint",
    );
    process.exitCode = 2;
    return;
  }

  // A key is present: build a real client. Provider resolution ("auto") picks
  // OpenRouter or TypeSafe from env — never the mock provider on this path.
  const client = new JevClient({ warnOnMock: false });
  const judge: Judge = createJudge(client);

  const goldenSet = await loadGoldenSet(DEFAULT_GOLDEN_PATH);
  const report = await runAccuracy(judge, goldenSet);

  console.error(
    `[drift] accuracy: n=${report.summary.n} ` +
      `relevance_accuracy=${report.summary.relevance_accuracy.toFixed(3)} ` +
      `credibility_accuracy=${report.summary.credibility_accuracy.toFixed(3)} ` +
      `mean_confidence=${report.summary.mean_confidence.toFixed(3)} ` +
      `rubric_version=${report.summary.rubric_version}`,
  );

  const existingBaseline = await loadBaseline(DEFAULT_BASELINE_PATH);
  const action = resolveDriftAction(
    existingBaseline !== undefined,
    existingBaseline?.rubric_version,
    RUBRIC_VERSION,
  );

  if (action.kind === "write_baseline") {
    const baseline: Baseline = {
      rubric_version: RUBRIC_VERSION,
      written_at: new Date().toISOString(),
      report,
    };
    await writeFile(DEFAULT_BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
    console.error(
      `[drift] no baseline found at ${DEFAULT_BASELINE_PATH} — wrote this run as the new baseline ` +
        `(rubric_version=${RUBRIC_VERSION}). Run again after a future change to measure drift.`,
    );
    console.log(JSON.stringify({ accuracy: report, baseline_written: true }, null, 2));
    return;
  }

  if (action.kind === "rebaseline_required") {
    console.error(
      `[drift] BLOCKED: baseline.json was written under rubric_version=` +
        `${action.baselineRubricVersion}, but the current rubrics are ` +
        `${action.currentRubricVersion}. Drift can't be measured across a rubric change.\n` +
        `  1. Review the rubric change and confirm it's intentional.\n` +
        `  2. Delete fixtures/golden/baseline.json deliberately.\n` +
        `  3. Re-run "npm run drift" to write a fresh baseline under the new rubric_version.`,
    );
    process.exitCode = EXIT_REBASELINE_REQUIRED;
    return;
  }

  // action.kind === "report": rubric versions match, compare against baseline.
  const drift = compareToBaseline(report, existingBaseline as Baseline);

  console.error(
    `[drift] drift vs baseline (written ${(existingBaseline as Baseline).written_at}): ` +
      `items_drifted=${drift.summary.items_drifted}/${drift.items.length} ` +
      `max_delta=${drift.summary.max_delta.toFixed(3)}`,
  );

  console.log(JSON.stringify({ accuracy: report, drift }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    if (err instanceof Error && "status" in err && (err as { status?: number }).status === 402) {
      console.error(
        "BLOCKED ON CREDITS: the API key works but the provider account has no balance. " +
          "Add credits (https://openrouter.ai/settings/credits) and re-run. " +
          "At Jev pricing ($0.042/M input) even $5 covers ~100k+ searches.",
      );
      process.exitCode = 4;
      return;
    }
    console.error("[drift] fatal:", err);
    process.exitCode = 1;
  });
}
