# Judging the Judge

*September 19, 2026*

A co-creator of ChatGPT just launched an AI model that doesn't write text — it only makes decisions, and the pitch is that it *can't* hallucinate. Nobody outside the company had published accuracy numbers. So I spent a weekend measuring it. I got it embarrassingly wrong before I got it right, and the wrong part is the most useful thing in this post.

## The model that won't talk

Jev launched on September 15 from TypeSafe AI, a startup founded by Diogo Almeida, one of the researchers behind the instruction-tuning work that made ChatGPT possible. It's a strange thing: you hand it some text and a question with fixed answer choices — *is this urgent, yes or no? which team should handle this? rate this 0 to 2* — and it hands back probabilities. In about a tenth of a second. For about a hundredth of a cent. It cannot write a sentence at all, which is the entire anti-hallucination argument: a model that can only pick from your options can't make things up.

The internet spent launch week making it play Doom and Minecraft. What nobody published: independent accuracy numbers. TypeSafe's own accuracy claims are graded against answer labels produced by *other AI models*, and there's no public leaderboard. For a model whose whole job is to be trusted with decisions, that seemed worth fixing.

## The test

I wrote the answer key first. Twenty-five realistic search results across four research topics — official documentation, blog posts, forum threads, and fake SEO spam I wrote myself to look convincing. For each one, two questions a research assistant would answer:

- **How relevant is this result to what I'm looking for?** (0 = wrong topic, 1 = related, 2 = exactly it)
- **How trustworthy is the source?** (0 = content farm, 1 = someone's blog or a forum, 2 = official docs or a primary source)

Where a result was genuinely ambiguous, the answer key accepts a range instead of one number. The key was locked before the first API call and never edited afterward. Then I asked Jev the same 25 questions and compared. Total model cost for the entire study: about a hundredth of a cent.

## My first result was 28%. The bug was mine.

The first scoring run came back with relevance accuracy of 28%. Terrible! Except the "failures" looked like this: expected exactly 2, model said **1.96**.

Jev doesn't answer "2." It answers with a probability-weighted average — 1.96 means "level 2, with 96% of the probability mass." That's a correct answer wearing decimal places. My scorer demanded exact integers and flunked the model for being precise about its own uncertainty. Round to the nearest level first and the same 25 answers score 88%.

| Grading rule | Relevance "accuracy" |
|---|---|
| Raw decimal vs exact expected integer | **28%** |
| Rounded to the nearest level first | **88%** |

Same model. Same 25 answers. The 60-point gap is entirely the grading script.

I'm dwelling on this because it generalizes: this whole new category of models answers in probabilities, and **how you convert probabilities into "right or wrong" changes the headline more than the model does**. Decide your grading rule before you look at results. If a benchmark of a probability-based model doesn't tell you its rounding rule, the number means nothing.

## The real numbers

| Metric | Score |
|---|---|
| Relevance | **88%** (22/25) |
| Source trust | **96%** (24/25) |
| Average model confidence | 0.77 |
| Items | 25, one run |

*(An interactive per-item chart with every raw answer is in the [repo version of this study](https://github.com/kierandotai/jev-scout/blob/main/docs/accuracy/2026-09-19-jev-golden-set-study.md); the raw outputs are committed alongside the answer key.)*

The source-trust result is the one that matters most for real use, and it held up outside the test too: on a live search about SSRF attacks, the same setup scored OWASP's official page 1.95 out of 2 while scoring an SEO-bait listicle and a vendor blog 0.77–0.93 — exactly the separation you'd want before letting an AI agent decide what to read.

## Where it actually failed — mostly on my words, not its judgment

Four misses. Decomposing them is more interesting than the score:

- **My fault (×2).** A forum thread that *names* the thing I'm searching for got top relevance, when I wanted "official docs." My question wording said top score = "mentions the exact thing from the goal." The thread does. The model followed my words; my words didn't say what I meant. Two of the four misses are this exact pattern.
- **Model's fault (×1).** First-party documentation hosted on a company subdomain wasn't recognized as "official docs" from the domain name alone. A real miss.
- **Debatable (×1).** A spam listicle about "AI agent frameworks" got scored as mildly related to an AI-tooling question instead of totally unrelated. My answer key said zero; honestly, "mildly related" is defensible.

The "my fault" misses are the finding I'd underline. These models read *literally* — TypeSafe documents this themselves — so the wording of your questions is load-bearing. Vague questions don't get vague answers; they get precise answers to the wrong question. Treat your question text like code: version it, test it, and expect your first draft to have bugs. Mine did.

## So, should you trust it?

For what it's built for — high-volume, low-stakes-per-decision triage like filtering search results, routing tickets, or ranking sources — these numbers say yes, cautiously, *if you measure it on your own task first*. That's the practical takeaway: an answer key like this one takes an afternoon to write and a hundredth of a cent to run. There is no reason to trust any decision model, this one included, on vibes.

Honest limits of this study: 25 items is a smoke test, not a benchmark — one item swings the score four points. It's a single run, the hosted model can't be version-pinned, and the answer key is one person's judgment. Two of the four misses arguably belong to my question wording rather than the model, and that cuts in both directions.

## Run it yourself

Everything is open: the 25 labeled items, the exact question wording (version-locked, so silent edits can't fudge results), the per-item raw outputs, and a re-run command that also detects if the hosted model quietly changes over time.

```bash
git clone https://github.com/kierandotai/jev-client && git clone https://github.com/kierandotai/jev-scout
cd jev-client && npm install && npm run build && cd ../jev-scout && npm install
# add an AI_GATEWAY_API_KEY or OPENROUTER_API_KEY to .env, then:
DRIFT_PACE_MS=60000 npm run drift
```

The study lives in [jev-scout](https://github.com/kierandotai/jev-scout) — an open-source tool that puts Jev in front of an AI agent's web research, scoring every search result and fetched page so you can see (and cap, and veto) what your agent reads — with [jev-client](https://github.com/kierandotai/jev-client) as the underlying library.
