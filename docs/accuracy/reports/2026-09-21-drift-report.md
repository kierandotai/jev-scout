# Monthly Drift Report — 2026-09-21 (rubric v1.3.0)

## Headline

| Metric | Value |
|---|---|
| Relevance accuracy | 86.0% |
| Credibility accuracy | 94.0% |
| Items (n) | 100 |
| Mean confidence | 0.78 |

*Relevance and credibility accuracy are graded by rounding each probability-weighted score to the nearest rubric level before comparing to the labeled band/level (the rounded-to-level rule — see the caveats below).*

## Findings this period

- **Second controlled rubric experiment, second clean result.** v1.3 added independent testing organizations and editorial publications to the credibility rubric's top level — the exact gap the 2026-09-19 report identified. All five targeted misses flipped decisively (NYT 0.36 → 1.90, RTINGS 0.63 → 1.95, The Verge 0.82 → 1.99); overall credibility rose 87% → 94% with relevance unchanged at 86%. Two for two: rewording the question moves the answers, predictably.
- **`content_class` gained a no-match bucket ("other")** per the official TypeSafe skill's complete-criteria rule — previously a page fitting no class was forced into a wrong label. Not exercised by this golden set (which judges search results, not pages); noted for completeness.
- **Transport change, recorded:** this baseline was measured via the direct TypeSafe API (`transport: typesafe`); the previous run used the Vercel AI Gateway. Baselines now record their transport and future runs warn on mismatch, since cross-transport deltas conflate provider and model drift. The v1.3 flips (Δ ≈ 1.0–1.5) far exceed plausible transport noise, but the caveat stands for smaller deltas.
- **Run time collapsed from ~100 minutes to ~2** — direct API access needs no free-tier pacing. Run cost ≈ $0.0004.

## Per-goal accuracy

| Goal | n | Relevance | Credibility |
|---|---|---|---|
| evaluate the MCP TypeScript SDK's tool registration API | 7 | 85.7% (6/7) | 100.0% (7/7) |
| find independent reviews of the iRobot Roomba Combo 10 Max robot vacuum | 15 | 93.3% (14/15) | 93.3% (14/15) |
| find official docs for the TypeSafe Jev systemone API | 6 | 100.0% (6/6) | 100.0% (6/6) |
| find primary reporting on the EU's 2026 delay to AI Act high-risk-system obligations | 15 | 80.0% (12/15) | 86.7% (13/15) |
| find reputable guidance on adult iron-deficiency symptoms | 15 | 100.0% (15/15) | 93.3% (14/15) |
| find the current best practice for handling SSRF in Node.js fetch-based crawlers | 7 | 100.0% (7/7) | 100.0% (7/7) |
| find the current recommended way to configure SearXNG's JSON search API | 5 | 80.0% (4/5) | 100.0% (5/5) |
| find the official text and effective date of the FTC's 2026 amendments to the Negative Option Rule (Click-to-Cancel) | 15 | 66.7% (10/15) | 86.7% (13/15) |
| find the official visa requirements for Indian nationals visiting Japan | 15 | 80.0% (12/15) | 100.0% (15/15) |

## Misses

19 of 100 item(s) missed on at least one axis:

- **mcp-sdk-07** (goal: *evaluate the MCP TypeScript SDK's tool registration API*)
  - relevance miss: expected band [0, 0], got 0.55 (rounds to 1)
- **searxng-json-02** (goal: *find the current recommended way to configure SearXNG's JSON search API*)
  - relevance miss: expected band [2, 2], got 1.34 (rounds to 1)
- **vacuum-review-15** (goal: *find independent reviews of the iRobot Roomba Combo 10 Max robot vacuum*)
  - relevance miss: expected band [0, 0], got 0.86 (rounds to 1)
  - credibility miss: expected level 1, got 0.03 (rounds to 0)
- **iron-deficiency-14** (goal: *find reputable guidance on adult iron-deficiency symptoms*)
  - credibility miss: expected level 1, got 1.52 (rounds to 2)
- **eu-ai-act-delay-04** (goal: *find primary reporting on the EU's 2026 delay to AI Act high-risk-system obligations*)
  - relevance miss: expected band [2, 2], got 1.41 (rounds to 1)
- **eu-ai-act-delay-06** (goal: *find primary reporting on the EU's 2026 delay to AI Act high-risk-system obligations*)
  - credibility miss: expected level 1, got 1.96 (rounds to 2)
- **eu-ai-act-delay-07** (goal: *find primary reporting on the EU's 2026 delay to AI Act high-risk-system obligations*)
  - credibility miss: expected level 1, got 1.86 (rounds to 2)
- **eu-ai-act-delay-08** (goal: *find primary reporting on the EU's 2026 delay to AI Act high-risk-system obligations*)
  - relevance miss: expected band [2, 2], got 1.19 (rounds to 1)
- **eu-ai-act-delay-11** (goal: *find primary reporting on the EU's 2026 delay to AI Act high-risk-system obligations*)
  - relevance miss: expected band [2, 2], got 1.34 (rounds to 1)
- **ftc-negopt-rule-02** (goal: *find the official text and effective date of the FTC's 2026 amendments to the Negative Option Rule (Click-to-Cancel)*)
  - relevance miss: expected band [2, 2], got 1.10 (rounds to 1)
- **ftc-negopt-rule-03** (goal: *find the official text and effective date of the FTC's 2026 amendments to the Negative Option Rule (Click-to-Cancel)*)
  - relevance miss: expected band [2, 2], got 1.37 (rounds to 1)
- **ftc-negopt-rule-05** (goal: *find the official text and effective date of the FTC's 2026 amendments to the Negative Option Rule (Click-to-Cancel)*)
  - relevance miss: expected band [0, 0], got 0.79 (rounds to 1)
- **ftc-negopt-rule-06** (goal: *find the official text and effective date of the FTC's 2026 amendments to the Negative Option Rule (Click-to-Cancel)*)
  - relevance miss: expected band [2, 2], got 1.03 (rounds to 1)
- **ftc-negopt-rule-07** (goal: *find the official text and effective date of the FTC's 2026 amendments to the Negative Option Rule (Click-to-Cancel)*)
  - credibility miss: expected level 1, got 0.18 (rounds to 0)
- **ftc-negopt-rule-10** (goal: *find the official text and effective date of the FTC's 2026 amendments to the Negative Option Rule (Click-to-Cancel)*)
  - relevance miss: expected band [0, 0], got 0.77 (rounds to 1)
- **ftc-negopt-rule-15** (goal: *find the official text and effective date of the FTC's 2026 amendments to the Negative Option Rule (Click-to-Cancel)*)
  - credibility miss: expected level 2, got 1.45 (rounds to 1)
- **japan-visa-03** (goal: *find the official visa requirements for Indian nationals visiting Japan*)
  - relevance miss: expected band [0, 0], got 0.60 (rounds to 1)
- **japan-visa-08** (goal: *find the official visa requirements for Indian nationals visiting Japan*)
  - relevance miss: expected band [2, 2], got 1.00 (rounds to 1)
- **japan-visa-13** (goal: *find the official visa requirements for Indian nationals visiting Japan*)
  - relevance miss: expected band [0, 0], got 0.79 (rounds to 1)

## Drift

First run — baseline established. Re-run next month to measure drift against this baseline.

## Caveats

- **Sample size:** n=100 item(s). A small golden set is a smoke test, not a benchmark — one item can swing the headline percentage by several points.
- **Single run:** this reflects one run of a hosted model that can't be version-pinned, not a repeated-trials average.
- **Rounding rule:** relevance and credibility hits are graded by rounding the model's probability-weighted score to the nearest rubric level before comparing it to the labeled band/level. Grading raw decimals against exact integers understates accuracy — see docs/accuracy/blog-post.md for the 28%-vs-88% example that motivated this rule.
- **What confidence means:** per TypeSafe's own guidance, choice/score confidence summarizes how concentrated the answer's probability distribution is — it is not a statement about overall workflow correctness. Mean confidence here is a distribution-sharpness signal, nothing more.

## Reproduce this report

```bash
DRIFT_PACE_MS=60000 npm run drift > drift-run.json
npm run report -- drift-run.json
```
