# Monthly Drift Report — 2026-09-19 (rubric v1.2.0)

## Headline

| Metric | Value |
|---|---|
| Relevance accuracy | 86.0% |
| Credibility accuracy | 87.0% |
| Items (n) | 100 |
| Mean confidence | 0.75 |

*Relevance and credibility accuracy are graded by rounding each probability-weighted score to the nearest rubric level before comparing to the labeled band/level (the rounded-to-level rule — see the caveats below).*

## Findings this period

- **The v1.2 rubric fix landed.** All three misses attributed to rubric wording in the [first study](../2026-09-19-jev-golden-set-study.md) now score correctly: the two "names the entity but isn't the asked-for document" items dropped from ~1.6–1.8 to ~1.0 (correct), and the first-party docs subdomain rose from 1.19 to 1.67 (correct). Rewording the question changed the answers exactly as intended — question text is code.
- **Rubrics don't cross domains for free.** The new consumer-products goal exposed it: Jev scored RTINGS, Wirecutter, Consumer Reports, and The Verge at 0.4–1.3 credibility because our level-2 wording enumerates documentation domains, standards bodies, and first-party sources — dev-tooling shapes — and never names independent testing organizations or professional journalism. By the rubric's literal words those sources *are* "unaffiliated commentary." The model read faithfully; the rubric was provincial. A v1.3 wording (or per-domain credibility rubrics) is queued; the 87% credibility headline understates the model and indicts the rubric.
- **Zero infrastructure retries** across 100 paced calls this run; total cost ≈ $0.0004.

## Per-goal accuracy

| Goal | n | Relevance | Credibility |
|---|---|---|---|
| evaluate the MCP TypeScript SDK's tool registration API | 7 | 85.7% (6/7) | 100.0% (7/7) |
| find independent reviews of the iRobot Roomba Combo 10 Max robot vacuum | 15 | 93.3% (14/15) | 60.0% (9/15) |
| find official docs for the TypeSafe Jev systemone API | 6 | 100.0% (6/6) | 100.0% (6/6) |
| find primary reporting on the EU's 2026 delay to AI Act high-risk-system obligations | 15 | 80.0% (12/15) | 80.0% (12/15) |
| find reputable guidance on adult iron-deficiency symptoms | 15 | 100.0% (15/15) | 93.3% (14/15) |
| find the current best practice for handling SSRF in Node.js fetch-based crawlers | 7 | 100.0% (7/7) | 100.0% (7/7) |
| find the current recommended way to configure SearXNG's JSON search API | 5 | 80.0% (4/5) | 100.0% (5/5) |
| find the official text and effective date of the FTC's 2026 amendments to the Negative Option Rule (Click-to-Cancel) | 15 | 66.7% (10/15) | 80.0% (12/15) |
| find the official visa requirements for Indian nationals visiting Japan | 15 | 80.0% (12/15) | 100.0% (15/15) |

## Misses

23 of 100 item(s) missed on at least one axis:

- **mcp-sdk-07** (goal: *evaluate the MCP TypeScript SDK's tool registration API*)
  - relevance miss: expected band [0, 0], got 0.52 (rounds to 1)
- **searxng-json-02** (goal: *find the current recommended way to configure SearXNG's JSON search API*)
  - relevance miss: expected band [2, 2], got 1.30 (rounds to 1)
- **vacuum-review-01** (goal: *find independent reviews of the iRobot Roomba Combo 10 Max robot vacuum*)
  - credibility miss: expected level 2, got 0.63 (rounds to 1)
- **vacuum-review-02** (goal: *find independent reviews of the iRobot Roomba Combo 10 Max robot vacuum*)
  - credibility miss: expected level 2, got 0.36 (rounds to 0)
- **vacuum-review-03** (goal: *find independent reviews of the iRobot Roomba Combo 10 Max robot vacuum*)
  - credibility miss: expected level 2, got 1.35 (rounds to 1)
- **vacuum-review-05** (goal: *find independent reviews of the iRobot Roomba Combo 10 Max robot vacuum*)
  - credibility miss: expected level 2, got 0.82 (rounds to 1)
- **vacuum-review-14** (goal: *find independent reviews of the iRobot Roomba Combo 10 Max robot vacuum*)
  - credibility miss: expected level 2, got 0.77 (rounds to 1)
- **vacuum-review-15** (goal: *find independent reviews of the iRobot Roomba Combo 10 Max robot vacuum*)
  - relevance miss: expected band [0, 0], got 0.85 (rounds to 1)
  - credibility miss: expected level 1, got 0.03 (rounds to 0)
- **iron-deficiency-07** (goal: *find reputable guidance on adult iron-deficiency symptoms*)
  - credibility miss: expected level 1, got 0.03 (rounds to 0)
- **eu-ai-act-delay-03** (goal: *find primary reporting on the EU's 2026 delay to AI Act high-risk-system obligations*)
  - credibility miss: expected level 2, got 1.04 (rounds to 1)
- **eu-ai-act-delay-04** (goal: *find primary reporting on the EU's 2026 delay to AI Act high-risk-system obligations*)
  - relevance miss: expected band [2, 2], got 1.46 (rounds to 1)
  - credibility miss: expected level 2, got 0.76 (rounds to 1)
- **eu-ai-act-delay-08** (goal: *find primary reporting on the EU's 2026 delay to AI Act high-risk-system obligations*)
  - relevance miss: expected band [2, 2], got 1.12 (rounds to 1)
- **eu-ai-act-delay-11** (goal: *find primary reporting on the EU's 2026 delay to AI Act high-risk-system obligations*)
  - relevance miss: expected band [2, 2], got 1.38 (rounds to 1)
  - credibility miss: expected level 2, got 0.61 (rounds to 1)
- **ftc-negopt-rule-02** (goal: *find the official text and effective date of the FTC's 2026 amendments to the Negative Option Rule (Click-to-Cancel)*)
  - relevance miss: expected band [2, 2], got 1.12 (rounds to 1)
- **ftc-negopt-rule-03** (goal: *find the official text and effective date of the FTC's 2026 amendments to the Negative Option Rule (Click-to-Cancel)*)
  - relevance miss: expected band [2, 2], got 1.35 (rounds to 1)
- **ftc-negopt-rule-05** (goal: *find the official text and effective date of the FTC's 2026 amendments to the Negative Option Rule (Click-to-Cancel)*)
  - relevance miss: expected band [0, 0], got 0.79 (rounds to 1)
- **ftc-negopt-rule-06** (goal: *find the official text and effective date of the FTC's 2026 amendments to the Negative Option Rule (Click-to-Cancel)*)
  - relevance miss: expected band [2, 2], got 1.03 (rounds to 1)
  - credibility miss: expected level 1, got 0.34 (rounds to 0)
- **ftc-negopt-rule-07** (goal: *find the official text and effective date of the FTC's 2026 amendments to the Negative Option Rule (Click-to-Cancel)*)
  - credibility miss: expected level 1, got 0.13 (rounds to 0)
- **ftc-negopt-rule-10** (goal: *find the official text and effective date of the FTC's 2026 amendments to the Negative Option Rule (Click-to-Cancel)*)
  - relevance miss: expected band [0, 0], got 0.80 (rounds to 1)
- **ftc-negopt-rule-15** (goal: *find the official text and effective date of the FTC's 2026 amendments to the Negative Option Rule (Click-to-Cancel)*)
  - credibility miss: expected level 2, got 1.15 (rounds to 1)
- **japan-visa-03** (goal: *find the official visa requirements for Indian nationals visiting Japan*)
  - relevance miss: expected band [0, 0], got 0.51 (rounds to 1)
- **japan-visa-08** (goal: *find the official visa requirements for Indian nationals visiting Japan*)
  - relevance miss: expected band [2, 2], got 1.00 (rounds to 1)
- **japan-visa-13** (goal: *find the official visa requirements for Indian nationals visiting Japan*)
  - relevance miss: expected band [0, 0], got 0.81 (rounds to 1)

## Drift

First run — baseline established. Re-run next month to measure drift against this baseline.

## Caveats

- **Sample size:** n=100 item(s). A small golden set is a smoke test, not a benchmark — one item can swing the headline percentage by several points.
- **Single run:** this reflects one run of a hosted model that can't be version-pinned, not a repeated-trials average.
- **Rounding rule:** relevance and credibility hits are graded by rounding the model's probability-weighted score to the nearest rubric level before comparing it to the labeled band/level. Grading raw decimals against exact integers understates accuracy — see docs/accuracy/blog-post.md for the 28%-vs-88% example that motivated this rule.

## Reproduce this report

```bash
DRIFT_PACE_MS=60000 npm run drift > drift-run.json
npm run report -- drift-run.json
```
