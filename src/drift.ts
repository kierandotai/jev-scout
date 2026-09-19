/**
 * Accuracy-report core for the golden set (R12 / U9).
 *
 * This module deliberately stops at a single accuracy-vs-labels report.
 * Drift-vs-pinned-baseline comparison (fixtures/golden/baseline.json,
 * RUBRIC_VERSION-mismatch handling) is U8's job — `runAccuracy`'s report
 * shape is designed so U8 can wrap it rather than reshape it.
 *
 * `main()` is the first live accuracy checkpoint the plan calls for: it runs
 * against a real JevClient built from env, and refuses to run silently
 * against MockProvider when no key is present (that would produce a
 * meaningless "accuracy" number, not a blocked checkpoint).
 */

import { readFile } from "node:fs/promises";
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

  for (const item of goldenSet) {
    const judgment = await judge.judgeResult(
      {
        goal: item.goal,
        query: item.query,
        result: {
          title: item.result.title,
          snippet: item.result.snippet,
          domain: item.result.domain,
        },
      },
      opts.signal === undefined ? {} : { signal: opts.signal },
    );

    const [min, max] = item.labels.relevance_band;
    const relevance_hit = judgment.relevance.score >= min && judgment.relevance.score <= max;
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
// CLI entry point — first live accuracy checkpoint (U9)
// ---------------------------------------------------------------------------

const DEFAULT_GOLDEN_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "golden",
  "results.json",
);

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

  console.log(JSON.stringify(report, null, 2));
  console.error(
    `[drift] n=${report.summary.n} ` +
      `relevance_accuracy=${report.summary.relevance_accuracy.toFixed(3)} ` +
      `credibility_accuracy=${report.summary.credibility_accuracy.toFixed(3)} ` +
      `mean_confidence=${report.summary.mean_confidence.toFixed(3)} ` +
      `rubric_version=${report.summary.rubric_version}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error("[drift] fatal:", err);
    process.exitCode = 1;
  });
}
