/**
 * Monthly public drift report generator (vision plan: "monthly public drift
 * report"). Turns the stdout of `npm run drift` (an AccuracyReport, plus an
 * optional DriftReport once a baseline exists) into a publishable markdown
 * report matching the plain-language, honest-about-limits voice of
 * docs/accuracy/blog-post.md.
 *
 * `renderDriftReport` is the pure core: given an already-parsed run JSON and
 * explicit options (date, a goal-lookup map, an optional previous run for
 * report-to-report drift), it returns a markdown string with no I/O and no
 * `Date.now()` — same input always produces the same output.
 *
 * `parseRunJson` strips an npm banner (or any other prefix) from raw stdout
 * text by parsing from the first "{".
 *
 * `main()` is the CLI: reads the input file, the golden fixture (for the
 * goal lookup), an optional --prev file, and --date/--out overrides, then
 * writes the rendered markdown to disk and echoes it to stdout.
 *
 * This script intentionally does not import from ../src/drift.ts — it is a
 * separate, freestanding consumer of the JSON shape that script's `main()`
 * prints to stdout, kept decoupled so the two can evolve independently.
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Input shape (the JSON printed by `npm run drift`)
// ---------------------------------------------------------------------------

export interface AccuracyItem {
  readonly id: string;
  readonly expected: {
    readonly relevance_band: readonly [number, number];
    readonly credibility_level: number;
  };
  readonly actual: {
    readonly relevance: number;
    readonly credibility: number;
  };
  readonly relevance_hit: boolean;
  readonly credibility_hit: boolean;
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
  readonly items: readonly AccuracyItem[];
  readonly summary: AccuracySummary;
}

export interface DriftItem {
  readonly id: string;
  readonly baseline: { readonly relevance: number; readonly credibility: number };
  readonly actual: { readonly relevance: number; readonly credibility: number };
  readonly relevance_delta: number;
  readonly credibility_delta: number;
  readonly drifted: boolean;
}

export interface DriftSummary {
  readonly items_drifted: number;
  readonly max_delta: number;
  readonly rubric_version_match: boolean;
}

export interface DriftReport {
  readonly items: readonly DriftItem[];
  readonly summary: DriftSummary;
}

export interface DriftRunJson {
  readonly accuracy: AccuracyReport;
  readonly drift?: DriftReport;
  readonly [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Banner-tolerant JSON parsing
// ---------------------------------------------------------------------------

/**
 * `npm run drift` output may be preceded by an npm banner
 * (`> jev-scout@0.1.0 drift\n> node ...\n\n`). Parse from the first "{" so
 * the report generator works directly on captured `npm run` stdout.
 */
export function parseRunJson(raw: string): DriftRunJson {
  const start = raw.indexOf("{");
  if (start === -1) {
    throw new Error("input does not contain a JSON object (no '{' found)");
  }
  const parsed: unknown = JSON.parse(raw.slice(start));
  if (typeof parsed !== "object" || parsed === null || !("accuracy" in parsed)) {
    throw new Error("parsed input is missing the required 'accuracy' field");
  }
  return parsed as DriftRunJson;
}

// ---------------------------------------------------------------------------
// Report-to-report drift (used only when the input has no `drift` field but
// a --prev run was supplied; mirrors src/drift.ts's compareToBaseline math
// without importing it, keeping this script freestanding).
// ---------------------------------------------------------------------------

const DRIFT_THRESHOLD = 0.25;

function computeDriftAgainstPrev(current: AccuracyReport, prev: AccuracyReport): DriftReport {
  const prevById = new Map(prev.items.map((i) => [i.id, i]));
  const items: DriftItem[] = [];
  for (const item of current.items) {
    const base = prevById.get(item.id);
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
      rubric_version_match: prev.summary.rubric_version === current.summary.rubric_version,
    },
  };
}

// ---------------------------------------------------------------------------
// Goal lookup
// ---------------------------------------------------------------------------

/** Golden-fixture shape, as read from fixtures/golden/results.json. */
export interface GoldenItemForGoalLookup {
  readonly id: string;
  readonly goal: string;
}

/** Build an id -> goal lookup table from the golden fixture array. */
export function buildGoalIndex(goldenItems: readonly GoldenItemForGoalLookup[]): Record<string, string> {
  const index: Record<string, string> = {};
  for (const item of goldenItems) index[item.id] = item.goal;
  return index;
}

/** Strip a trailing "-<digits>" suffix, e.g. "vacuum-review-03" -> "vacuum-review". */
function idPrefix(id: string): string {
  return id.replace(/-\d+$/, "");
}

/**
 * Resolve the goal for an item id: exact match first, then fall back to any
 * other entry in the map sharing the same id-prefix group (new items not yet
 * individually keyed but sharing a group with known ones), then an explicit
 * "unmapped" label so a lookup gap is visible in the report rather than
 * silently dropped.
 */
function goalForId(id: string, goalById: Readonly<Record<string, string>>): string {
  const direct = goalById[id];
  if (direct !== undefined) return direct;

  const prefix = idPrefix(id);
  for (const [otherId, goal] of Object.entries(goalById)) {
    if (idPrefix(otherId) === prefix) return goal;
  }
  return `(unmapped id: ${id})`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface RenderOptions {
  /** YYYY-MM-DD. Explicit and required — the pure renderer never calls Date.now(). */
  readonly date: string;
  /** id -> goal, typically built by buildGoalIndex() from the golden fixture. */
  readonly goalById: Readonly<Record<string, string>>;
  /**
   * A previously rendered run's JSON, used to compute report-to-report drift
   * when `runJson.drift` is absent (e.g. the input is itself a first run).
   * Ignored when `runJson.drift` is already present.
   */
  readonly prevRunJson?: DriftRunJson;
}

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

function fmtScore(n: number): string {
  return n.toFixed(2);
}

interface GoalBucket {
  readonly goal: string;
  items: AccuracyItem[];
}

function groupByGoal(
  items: readonly AccuracyItem[],
  goalById: Readonly<Record<string, string>>,
): GoalBucket[] {
  const buckets = new Map<string, GoalBucket>();
  for (const item of items) {
    const goal = goalForId(item.id, goalById);
    let bucket = buckets.get(goal);
    if (bucket === undefined) {
      bucket = { goal, items: [] };
      buckets.set(goal, bucket);
    }
    bucket.items.push(item);
  }
  // Stable, readable order: by goal label.
  return [...buckets.values()].sort((a, b) => a.goal.localeCompare(b.goal));
}

function renderHeadline(summary: AccuracySummary): string {
  const lines = [
    "## Headline",
    "",
    "| Metric | Value |",
    "|---|---|",
    `| Relevance accuracy | ${pct(summary.relevance_accuracy)} |`,
    `| Credibility accuracy | ${pct(summary.credibility_accuracy)} |`,
    `| Items (n) | ${summary.n} |`,
    `| Mean confidence | ${fmtScore(summary.mean_confidence)} |`,
    "",
    "*Relevance and credibility accuracy are graded by rounding each " +
      "probability-weighted score to the nearest rubric level before " +
      "comparing to the labeled band/level (the rounded-to-level rule — see " +
      "the caveats below).*",
  ];
  return lines.join("\n");
}

function renderPerGoal(buckets: readonly GoalBucket[]): string {
  const lines = ["## Per-goal accuracy", "", "| Goal | n | Relevance | Credibility |", "|---|---|---|---|"];
  for (const bucket of buckets) {
    const n = bucket.items.length;
    const relHits = bucket.items.filter((i) => i.relevance_hit).length;
    const credHits = bucket.items.filter((i) => i.credibility_hit).length;
    const relPct = n === 0 ? "n/a" : `${pct(relHits / n)} (${relHits}/${n})`;
    const credPct = n === 0 ? "n/a" : `${pct(credHits / n)} (${credHits}/${n})`;
    lines.push(`| ${bucket.goal} | ${n} | ${relPct} | ${credPct} |`);
  }
  return lines.join("\n");
}

function renderMisses(items: readonly AccuracyItem[], goalById: Readonly<Record<string, string>>): string {
  const misses = items.filter((i) => !i.relevance_hit || !i.credibility_hit);
  const lines = ["## Misses"];
  if (misses.length === 0) {
    lines.push("", "No misses this run — every item hit both relevance and credibility.");
    return lines.join("\n");
  }
  lines.push("", `${misses.length} of ${items.length} item(s) missed on at least one axis:`, "");
  for (const item of misses) {
    const goal = goalForId(item.id, goalById);
    lines.push(`- **${item.id}** (goal: *${goal}*)`);
    if (!item.relevance_hit) {
      const [min, max] = item.expected.relevance_band;
      lines.push(
        `  - relevance miss: expected band [${min}, ${max}], got ${fmtScore(item.actual.relevance)} ` +
          `(rounds to ${Math.round(item.actual.relevance)})`,
      );
    }
    if (!item.credibility_hit) {
      lines.push(
        `  - credibility miss: expected level ${item.expected.credibility_level}, got ` +
          `${fmtScore(item.actual.credibility)} (rounds to ${Math.round(item.actual.credibility)})`,
      );
    }
  }
  return lines.join("\n");
}

function renderDriftSection(runJson: DriftRunJson, opts: RenderOptions): string {
  const lines = ["## Drift", ""];

  if (runJson.drift !== undefined) {
    const d = runJson.drift;
    lines.push(
      "| Items drifted | Max delta | Rubric version match |",
      "|---|---|---|",
      `| ${d.summary.items_drifted} / ${d.items.length} | ${fmtScore(d.summary.max_delta)} | ` +
        `${d.summary.rubric_version_match ? "yes" : "no"} |`,
    );
    if (!d.summary.rubric_version_match) {
      lines.push(
        "",
        "The baseline was written under a different rubric version than this run — " +
          "treat this drift comparison as informational only, not a clean signal.",
      );
    }
    if (d.summary.items_drifted > 0) {
      const drifted = d.items.filter((i) => i.drifted);
      lines.push("", `Items that drifted (|delta| > ${DRIFT_THRESHOLD}):`, "");
      for (const item of drifted) {
        lines.push(
          `- **${item.id}** — relevance ${fmtScore(item.baseline.relevance)} → ` +
            `${fmtScore(item.actual.relevance)} (Δ${fmtScore(item.relevance_delta)}), ` +
            `credibility ${fmtScore(item.baseline.credibility)} → ${fmtScore(item.actual.credibility)} ` +
            `(Δ${fmtScore(item.credibility_delta)})`,
        );
      }
    }
    return lines.join("\n");
  }

  if (opts.prevRunJson !== undefined) {
    const computed = computeDriftAgainstPrev(runJson.accuracy, opts.prevRunJson.accuracy);
    lines.push(
      "*No `drift` field on this run's input — comparing against the supplied `--prev` report instead.*",
      "",
      "| Items drifted | Max delta | Rubric version match |",
      "|---|---|---|",
      `| ${computed.summary.items_drifted} / ${computed.items.length} | ` +
        `${fmtScore(computed.summary.max_delta)} | ${computed.summary.rubric_version_match ? "yes" : "no"} |`,
    );
    if (computed.summary.items_drifted > 0) {
      const drifted = computed.items.filter((i) => i.drifted);
      lines.push("", `Items that drifted (|delta| > ${DRIFT_THRESHOLD}):`, "");
      for (const item of drifted) {
        lines.push(
          `- **${item.id}** — relevance ${fmtScore(item.baseline.relevance)} → ` +
            `${fmtScore(item.actual.relevance)} (Δ${fmtScore(item.relevance_delta)}), ` +
            `credibility ${fmtScore(item.baseline.credibility)} → ${fmtScore(item.actual.credibility)} ` +
            `(Δ${fmtScore(item.credibility_delta)})`,
        );
      }
    }
    return lines.join("\n");
  }

  lines.push("First run — baseline established. Re-run next month to measure drift against this baseline.");
  return lines.join("\n");
}

function renderCaveats(summary: AccuracySummary): string {
  return [
    "## Caveats",
    "",
    `- **Sample size:** n=${summary.n} item(s). A small golden set is a smoke test, not a benchmark — ` +
      "one item can swing the headline percentage by several points.",
    "- **Single run:** this reflects one run of a hosted model that can't be version-pinned, not a " +
      "repeated-trials average.",
    "- **Rounding rule:** relevance and credibility hits are graded by rounding the model's " +
      "probability-weighted score to the nearest rubric level before comparing it to the labeled " +
      "band/level. Grading raw decimals against exact integers understates accuracy — see " +
      "docs/accuracy/blog-post.md for the 28%-vs-88% example that motivated this rule.",
    "- **What confidence means:** per TypeSafe's own guidance, choice/score confidence summarizes " +
      "how concentrated the answer's probability distribution is — it is not a statement about " +
      "overall workflow correctness. Mean confidence here is a distribution-sharpness signal, " +
      "nothing more.",
  ].join("\n");
}

function renderRepro(): string {
  return [
    "## Reproduce this report",
    "",
    "```bash",
    "DRIFT_PACE_MS=60000 npm run drift > drift-run.json",
    "npm run report -- drift-run.json",
    "```",
  ].join("\n");
}

/**
 * Pure core: turn a parsed drift-run JSON into a publishable markdown
 * report. Deterministic — same `runJson` + `opts` always produce the same
 * string. No I/O, no `Date.now()`.
 */
export function renderDriftReport(runJson: DriftRunJson, opts: RenderOptions): string {
  const summary = runJson.accuracy.summary;
  const buckets = groupByGoal(runJson.accuracy.items, opts.goalById);

  const sections = [
    `# Monthly Drift Report — ${opts.date} (rubric v${summary.rubric_version})`,
    "",
    renderHeadline(summary),
    "",
    renderPerGoal(buckets),
    "",
    renderMisses(runJson.accuracy.items, opts.goalById),
    "",
    renderDriftSection(runJson, opts),
    "",
    renderCaveats(summary),
    "",
    renderRepro(),
    "",
  ];
  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, "..");
const DEFAULT_GOLDEN_PATH = join(REPO_ROOT, "fixtures", "golden", "results.json");

interface CliArgs {
  readonly inputPath: string;
  readonly outPath?: string;
  readonly prevPath?: string;
  readonly date?: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let inputPath: string | undefined;
  let outPath: string | undefined;
  let prevPath: string | undefined;
  let date: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") {
      outPath = argv[++i];
    } else if (arg === "--prev") {
      prevPath = argv[++i];
    } else if (arg === "--date") {
      date = argv[++i];
    } else if (inputPath === undefined && !arg.startsWith("--")) {
      inputPath = arg;
    }
  }

  if (inputPath === undefined) {
    throw new Error(
      "usage: npm run report -- <input.json> [--out <path.md>] [--prev <previous-report.json>] [--date YYYY-MM-DD]",
    );
  }
  return { inputPath, outPath, prevPath, date };
}

function toDateStamp(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const rawInput = await readFile(args.inputPath, "utf8");
  const runJson = parseRunJson(rawInput);

  const goldenRaw = await readFile(DEFAULT_GOLDEN_PATH, "utf8");
  const goldenItems = JSON.parse(goldenRaw) as GoldenItemForGoalLookup[];
  const goalById = buildGoalIndex(goldenItems);

  let prevRunJson: DriftRunJson | undefined;
  if (args.prevPath !== undefined) {
    const prevRaw = await readFile(args.prevPath, "utf8");
    prevRunJson = parseRunJson(prevRaw);
  }

  const date = args.date ?? toDateStamp((await stat(args.inputPath)).mtime);
  const outPath = args.outPath ?? join(REPO_ROOT, "docs", "accuracy", "reports", `${date}-drift-report.md`);

  const markdown = renderDriftReport(runJson, { date, goalById, prevRunJson });

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, markdown, "utf8");
  console.error(`[report] wrote ${outPath}`);
  console.log(markdown);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error("[report] fatal:", err);
    process.exitCode = 1;
  });
}
