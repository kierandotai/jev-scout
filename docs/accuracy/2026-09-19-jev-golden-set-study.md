# Jev Golden-Set Accuracy Study — 2026-09-19

An independent accuracy measurement of TypeSafe's Jev (System One decision
model) on search-result triage, against a hand-labeled golden set. As far as
we can tell this is the first published third-party accuracy number for Jev:
TypeSafe's own accuracy claims are measured against model-derived reference
labels, and no public leaderboard exists.

## Headline results

| Metric | Result |
|---|---|
| Relevance accuracy (0–2 rubric, rounded to level, vs labeled band) | **22/25 = 88%** |
| Credibility accuracy (0–2 rubric, rounded to level, vs labeled level) | **24/25 = 96%** |
| Mean answer confidence | 0.77 |
| Items | 25 |
| Rubric version | 1.1.0 (pinned in `src/judge.ts`) |
| Model access | `typesafe-ai/jev` via Vercel AI Gateway (`/v4/ai/evaluation-model`) |
| Cost of the full run | ~$0.0001 (free-window pricing; ~$0.042/M input regardless) |

## Method

- **Golden set** (`fixtures/golden/results.json`): 25 realistic search results
  hand-authored across 4 research goals (TypeSafe Jev docs, MCP TypeScript SDK
  tool registration, Node.js SSRF best practice, SearXNG JSON API config),
  spanning the quality spectrum: 11 official-docs/primary sources, 8
  blog/forum items, 6 invented SEO content-farm results. Each item carries a
  labeled relevance band (`[min,max]` on 0–2, bands wider than one level only
  where genuinely ambiguous, with notes) and an exact credibility level.
- **Labels first, rubrics second.** Labels were written before any live model
  call and never adjusted to fit results.
- **Judgment**: one Jev call per item (`judgeResult` in `src/judge.ts`),
  state filtered to `{goal, query, title, snippet, domain}` with untrusted
  fields wrapped in delimiters. Rubric wording is pinned verbatim by tests;
  any change requires a `RUBRIC_VERSION` bump and deliberate re-baseline.
- **Scoring**: Jev returns probability-weighted scores (e.g. 1.96 = "level 2
  with ~96% of the probability mass"). Scores are rounded to the nearest
  rubric level before comparison — see the measurement lesson below.
- **Run conditions**: sequential, 60s pacing (the free tier rate-limits
  bursts), 2026-09-19. Raw per-item actuals are pinned in
  `fixtures/golden/baseline.json`.

## The measurement lesson

Our first scoring pass compared Jev's raw weighted score against exact
integer bands and reported **28%** relevance accuracy — with "misses" like
`expected [2,2], got 1.96`. Those are correct judgments scored as failures.
TypeSafe's own jaggedness documentation warns against interpolating between
score thresholds; our harness violated that advice against itself. Rounding
to the nearest level (equivalently, taking the argmax level) yields the real
number: 88%. Anyone benchmarking a System One model should decide their
band-matching semantics *before* reading results — the gap between 28% and
88% is entirely the measuring stick.

## Miss analysis (all 4, no cherry-picking)

| Item | Expected | Got | Diagnosis |
|---|---|---|---|
| `typesafe-docs-05` (HN thread naming Jev; goal asks for official docs) | rel [1,1] | 1.56 → 2 | **Rubric literalism, arguably Jev is right by our own wording**: level 2 says "mentions the exact entity from the goal" — the title does. The label wanted "satisfies the goal's document-type ask", which the rubric never states. Rubric-wording fix queued for v1.2.0. |
| `ssrf-node-05` (StackExchange Q&A on the goal's exact topic) | rel [1,1] | 1.81 → 2 | Same literalism pattern as above. |
| `mcp-sdk-02` (first-party docs on code.claude.com) | cred 2 | 1.19 → 1 | Genuine miss: the domain signal for a first-party docs subdomain wasn't recognized as "official documentation domain". |
| `mcp-sdk-07` (content-farm listicle) | rel [0,0] | 0.69 → 1 | Borderline: "AI agent frameworks" is tangentially adjacent to the MCP goal; a [0,1] band would arguably be the fairer label. |

Notable: **credibility separation is strong in practice.** In a live search
run the same rubrics scored OWASP at 1.95 against 0.77–0.93 for blog/SEO
sources on the same query — exactly the separation a gating layer needs.

## Caveats, honestly

- n=25 is small; a single item is a 4-point swing. This is a calibration
  smoke test, not a benchmark.
- Single run; free-tier access, model version not pinnable through the
  Gateway (no version metadata is exposed).
- Labels are one person-session's judgment; two of the four misses are
  plausibly label/rubric artifacts rather than model errors, which cuts both
  ways.
- Rubric wording materially affects results (that's the point of pinning it);
  our v1.1.0 wording provably diverges from label intent on two items.

## Reproduce it

```bash
# needs AI_GATEWAY_API_KEY (or OPENROUTER_API_KEY) in .env
DRIFT_PACE_MS=60000 npm run drift
```

First run writes `fixtures/golden/baseline.json`; later runs report accuracy
vs labels **and** per-item drift vs the pinned baseline, and exit non-zero on
a rubric-version mismatch so silent rubric changes can't masquerade as model
drift.
