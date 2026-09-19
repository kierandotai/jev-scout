/**
 * The agent-facing MCP surface (U6): `guarded_search`, `guarded_fetch`,
 * `research_report` over stdio.
 *
 * Three rules this module exists to hold:
 *
 * 1. **stdout is sacred.** stdout carries JSON-RPC frames and nothing else.
 *    Every diagnostic in this file goes to stderr via `logErr`.
 * 2. **Tools never throw.** A pipeline failure becomes a `{isError: true}`
 *    CallToolResult carrying a structured, machine-readable reason (backend
 *    chain failures keep their `backends_tried` list) — the agent gets to
 *    decide what to do, rather than seeing a protocol error.
 * 3. **Every result is returned twice**: as `structuredContent` (validated by
 *    the tool's `outputSchema`) and as a stringified `text` content block, per
 *    the SDK 1.x contract for clients that only read `content`.
 *
 * `guarded_fetch` additionally pins *field order*: `steering_risk` and the
 * other judgment fields are emitted before `text` in both the object literal
 * and the stringified JSON, so an agent reading top-to-bottom sees the
 * advisory flag before the (possibly steering) content it describes — R4's
 * "flagged in output before the content, content still delivered".
 *
 * `research_report` is assembled from three sources: in-memory session
 * tallies (kept by subscribing to the ledger's event feed), `budget.state()`
 * for remaining budget, and `ledger.todaySpend()` for restart-spanning spend.
 * It returns a valid, zeroed shape before any search has run.
 */

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { BackendChainError, domainFromUrl } from "./backends/resolve.ts";
import { budgetFieldIfOver80, type Budget } from "./budget.ts";
import type { Config } from "./config.ts";
import type { Ledger, LedgerEvent } from "./ledger.ts";
import type { Pipeline } from "./pipeline.ts";

// ---------------------------------------------------------------------------
// stderr-only logging
// ---------------------------------------------------------------------------

/** The ONLY logging channel in this process. Never console.log — see rule 1. */
function logErr(message: string): void {
  process.stderr.write(`[jev-scout] ${message}\n`);
}

// ---------------------------------------------------------------------------
// Shared zod fragments (raw shapes, per the SDK 1.x registerTool contract)
// ---------------------------------------------------------------------------

const scoreJudgmentSchema = z.object({
  score: z.number(),
  confidence: z.number(),
  probabilities: z.record(z.string(), z.number()),
});

const noulJudgmentSchema = z.object({ probability: z.number() });

/** Query-level on_task judgment. Mirrors pipeline.ts's SearchOnTask. */
const onTaskSchema = z.object({
  scored: z.boolean(),
  budget_exhausted: z.boolean().optional(),
  /** Present only when `scored` is true. */
  probability: z.number().optional(),
});

const choiceJudgmentSchema = z.object({
  choice: z.string(),
  confidence: z.number(),
  probabilities: z.record(z.string(), z.number()),
});

const budgetStateSchema = z.object({
  callsUsed: z.number(),
  callsRemaining: z.number(),
  spendUsd: z.number(),
  spendRemaining: z.number(),
  judgedPerSearchLimit: z.number(),
  exhausted: z.union([z.literal(false), z.object({ limit: z.enum(["calls", "spend"]) })]),
  over80: z.object({ calls: z.boolean(), spend: z.boolean() }),
});

/** A search result the gate dropped — never made it into `results`. Mirrors pipeline.ts's DroppedResult. */
const droppedResultSchema = z.object({
  url: z.string(),
  domain: z.string(),
  reasons: z.array(z.string()),
});

/** Live gate thresholds, surfaced by research_report (AN2). */
const thresholdsSchema = z.object({
  min_relevance: z.number(),
  min_credibility: z.number(),
});

// ---------------------------------------------------------------------------
// Tool schemas
// ---------------------------------------------------------------------------

const guardedSearchInputShape = {
  query: z.string(),
  goal: z.string().optional(),
  max_results: z.number().int().min(1).max(20).optional(),
};

export const guardedSearchOutputShape = {
  search_id: z.string(),
  query: z.string(),
  goal: z.string().optional(),
  mode: z.enum(["annotate", "gate"]),
  backends_tried: z.array(z.string()),
  results: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      snippet: z.string(),
      domain: z.string(),
      scored: z.boolean(),
      budget_exhausted: z.boolean().optional(),
      /** Set instead of being judged at all — the per-search judged-result cap was hit. */
      judge_skipped: z.literal("judge_cap").optional(),
      relevance: scoreJudgmentSchema.optional(),
      credibility: scoreJudgmentSchema.optional(),
      worth_fetching: noulJudgmentSchema.optional(),
    }),
  ),
  /** Every gate-dropped result (threshold drops and beyond-cap truncation), gate mode only. */
  dropped: z.array(droppedResultSchema),
  /** Query-level on_task judgment. Only present when `goal` was supplied. */
  on_task: onTaskSchema.optional(),
  budget: budgetStateSchema.optional(),
};

const guardedFetchInputShape = {
  url: z.string(),
  goal: z.string().optional(),
};

/**
 * Field order here is load-bearing, not cosmetic: everything a reader needs in
 * order to distrust `text` appears before `text`. The handler builds its
 * object literal in this same order so `JSON.stringify` reproduces it.
 */
export const guardedFetchOutputShape = {
  search_id: z.string(),
  ok: z.literal(true),
  url: z.string(),
  finalUrl: z.string(),
  scored: z.boolean(),
  budget_exhausted: z.boolean().optional(),
  steering_risk_flag: z.boolean(),
  steering_risk: noulJudgmentSchema.optional(),
  answered: noulJudgmentSchema.optional(),
  content_class: choiceJudgmentSchema.optional(),
  truncated: z.boolean(),
  budget: budgetStateSchema.optional(),
  text: z.string(),
};

const domainStatSchema = z.object({
  domain: z.string(),
  hits: z.number(),
  /** null when the domain was touched but never scored (Jev failure / budget). */
  mean_credibility: z.number().nullable(),
});

const researchReportInputShape = {};

export const researchReportOutputShape = {
  session: z.string(),
  mode: z.enum(["annotate", "gate"]),
  /** Live gate thresholds (config.minRelevance/minCredibility) at report time. */
  thresholds: thresholdsSchema,
  goals: z.array(
    z.object({
      goal: z.string(),
      searches: z.number(),
      results_judged: z.number(),
      gate_actions: z.number(),
      domains: z.array(domainStatSchema),
    }),
  ),
  flagged_domains: z.array(domainStatSchema),
  session_spend_usd: z.number(),
  today_spend_usd: z.number(),
  budget: budgetStateSchema,
  dashboardUrl: z.string().nullable(),
};

// ---------------------------------------------------------------------------
// Session tallies, fed by the ledger event feed
// ---------------------------------------------------------------------------

/** Bucket for events whose `search_id` never carried a goal (fetches, stray gates). */
const NO_GOAL = "(no goal)";

interface DomainTally {
  hits: number;
  credSum: number;
  credCount: number;
}

interface GoalTally {
  searches: number;
  resultsJudged: number;
  gateActions: number;
  domains: Map<string, DomainTally>;
}

function emptyGoalTally(): GoalTally {
  return { searches: 0, resultsJudged: 0, gateActions: 0, domains: new Map() };
}

function bumpDomain(map: Map<string, DomainTally>, domain: string, credibility?: number): void {
  let tally = map.get(domain);
  if (tally === undefined) {
    tally = { hits: 0, credSum: 0, credCount: 0 };
    map.set(domain, tally);
  }
  tally.hits += 1;
  if (typeof credibility === "number") {
    tally.credSum += credibility;
    tally.credCount += 1;
  }
}

function meanCredibility(tally: DomainTally): number | null {
  return tally.credCount === 0 ? null : tally.credSum / tally.credCount;
}

function domainStats(map: Map<string, DomainTally>): Array<z.infer<typeof domainStatSchema>> {
  return [...map.entries()]
    .map(([domain, tally]) => ({ domain, hits: tally.hits, mean_credibility: meanCredibility(tally) }))
    .sort((a, b) => b.hits - a.hits || a.domain.localeCompare(b.domain));
}

/** Domains flagged for the agent's attention: judged, and below credibility 1. */
const FLAGGED_CREDIBILITY = 1;

interface SessionTallies {
  goalOf: Map<string, string>;
  goals: Map<string, GoalTally>;
  allDomains: Map<string, DomainTally>;
}

function readString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  return typeof value === "number" ? value : undefined;
}

/**
 * Fold one ledger event into the running tallies. Defensive on every field:
 * past the ledger's daily byte guard `payload` degrades to `{omitted: true}`,
 * so nothing here may assume a shape.
 */
function absorb(tallies: SessionTallies, event: LedgerEvent): void {
  const payload = event.payload as Record<string, unknown>;

  function group(): GoalTally {
    const key = tallies.goalOf.get(event.search_id) ?? NO_GOAL;
    let tally = tallies.goals.get(key);
    if (tally === undefined) {
      tally = emptyGoalTally();
      tallies.goals.set(key, tally);
    }
    return tally;
  }

  switch (event.type) {
    case "search": {
      const goal = readString(payload, "goal") ?? NO_GOAL;
      tallies.goalOf.set(event.search_id, goal);
      group().searches += 1;
      return;
    }
    case "result": {
      const domain = readString(payload, "domain");
      const credibility = readNumber(payload, "credibility");
      const tally = group();
      if (payload.scored === true) tally.resultsJudged += 1;
      if (domain !== undefined) {
        bumpDomain(tally.domains, domain, credibility);
        bumpDomain(tallies.allDomains, domain, credibility);
      }
      return;
    }
    case "fetch": {
      const domain = domainOf(readString(payload, "url"));
      if (domain !== undefined) {
        bumpDomain(group().domains, domain);
        bumpDomain(tallies.allDomains, domain);
      }
      return;
    }
    case "gate": {
      group().gateActions += 1;
      return;
    }
    default:
      return;
  }
}

function domainOf(rawUrl: string | undefined): string | undefined {
  return rawUrl === undefined ? undefined : domainFromUrl(rawUrl);
}

// ---------------------------------------------------------------------------
// Error payloads (jev-client's proxy style: a typed reason, never a throw)
// ---------------------------------------------------------------------------

interface ToolErrorPayload {
  readonly error: true;
  readonly reason: string;
  readonly message: string;
  readonly backends_tried?: string[];
}

function errorPayload(reason: string, message: string, backendsTried?: string[]): ToolErrorPayload {
  return {
    error: true,
    reason,
    message,
    ...(backendsTried === undefined ? {} : { backends_tried: backendsTried }),
  };
}

function backendsTriedFrom(err: unknown): string[] | undefined {
  if (err instanceof BackendChainError) return err.backendsTried;
  if (typeof err === "object" && err !== null && "backend" in err) {
    const backend = (err as { backend: unknown }).backend;
    if (typeof backend === "string") return [backend];
  }
  return undefined;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Result envelopes
// ---------------------------------------------------------------------------

function ok(out: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(out) }],
    structuredContent: out,
  };
}

function failed(payload: ToolErrorPayload) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload as unknown as Record<string, unknown>,
    isError: true as const,
  };
}

// ---------------------------------------------------------------------------
// In-flight tool-call tracking + shutdown drain (F17)
// ---------------------------------------------------------------------------

const DEFAULT_DRAIN_GRACE_MS = 5_000;

export interface InFlightTracker {
  /** Wrap a handler's promise so shutdown can await it; self-removes on settle. */
  track<T>(promise: Promise<T>): Promise<T>;
  /** Await every currently-tracked promise, bounded by `graceMs` ms. Never rejects. */
  drain(graceMs?: number): Promise<void>;
  /** Number of calls currently in flight — exposed for tests. */
  size(): number;
}

/** Standalone, independently testable — `buildServer` wires one instance per server. */
export function createInFlightTracker(): InFlightTracker {
  const inFlight = new Set<Promise<unknown>>();
  return {
    track(promise) {
      const wrapped = promise.finally(() => {
        inFlight.delete(wrapped);
      });
      inFlight.add(wrapped);
      return wrapped;
    },
    async drain(graceMs = DEFAULT_DRAIN_GRACE_MS) {
      if (inFlight.size === 0) return;
      await Promise.race([
        Promise.allSettled([...inFlight]),
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, graceMs);
          timer.unref?.();
        }),
      ]);
    },
    size() {
      return inFlight.size;
    },
  };
}

/** Per-server tracker, keyed off the McpServer instance `buildServer` returns. */
const inFlightTrackers = new WeakMap<McpServer, InFlightTracker>();

/**
 * Await every tool call currently in flight on `server`, bounded by `graceMs`
 * (default 5s). Used by `main()`'s shutdown so an in-progress guarded_search /
 * guarded_fetch call is never dropped mid-call. A no-op for a server built
 * without `buildServer` or with no tracked calls.
 */
export async function drainInFlight(server: McpServer, graceMs?: number): Promise<void> {
  const tracker = inFlightTrackers.get(server);
  if (tracker === undefined) return;
  await tracker.drain(graceMs);
}

// ---------------------------------------------------------------------------
// Description interpolation (AN2): live mode + thresholds, at registration time
// ---------------------------------------------------------------------------

function modeAndThresholdsNote(config: Config): string {
  return config.mode === "gate"
    ? `Current mode: gate — results below min_relevance=${config.minRelevance} or ` +
        `min_credibility=${config.minCredibility} are dropped (see the \`dropped\` field and ` +
        "research_report's thresholds)."
    : `Current mode: annotate — nothing is dropped; configured gate thresholds ` +
        `(min_relevance=${config.minRelevance}, min_credibility=${config.minCredibility}) are not enforced.`;
}

// ---------------------------------------------------------------------------
// buildServer
// ---------------------------------------------------------------------------

export interface ServerDeps {
  readonly pipeline: Pipeline;
  readonly budget: Budget;
  readonly ledger: Ledger;
  readonly config: Config;
  /** Printed in `research_report` so the agent can hand the human a URL. */
  readonly dashboardUrl?: string | null;
  /** Session id shared with the pipeline; defaults to a fresh UUID. */
  readonly session?: string;
}

export const SERVER_NAME = "jev-scout";
export const SERVER_VERSION = "0.1.0";

/**
 * Build a fully configured `McpServer`. No transport is attached and no
 * dashboard is started — `main()` owns both — so tests can drive this over
 * `InMemoryTransport` with stubbed dependencies.
 */
export function buildServer(deps: ServerDeps): McpServer {
  const { pipeline, budget, ledger, config } = deps;
  const session = deps.session ?? randomUUID();
  const dashboardUrl = deps.dashboardUrl ?? null;

  const tallies: SessionTallies = { goalOf: new Map(), goals: new Map(), allDomains: new Map() };
  ledger.on("event", (event: LedgerEvent) => {
    try {
      absorb(tallies, event);
    } catch (err) {
      // Never let report bookkeeping break the tool that produced the event.
      logErr(`ledger tally error: ${messageOf(err)}`);
    }
  });

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  // In-flight tracking (F17): every tool handler body below is wrapped in
  // `tracker.track(...)` so `drainInFlight(server)` can await whatever is
  // still running at shutdown time, instead of dropping it mid-call.
  const tracker = createInFlightTracker();
  inFlightTrackers.set(server, tracker);

  // -------------------------------------------------------------------------
  // guarded_search
  // -------------------------------------------------------------------------

  server.registerTool(
    "guarded_search",
    {
      title: "Guarded search",
      description:
        "Search the web and return results annotated with Jev judgments: relevance (0-2), " +
        "credibility (0-2) and worth_fetching (probability), each with confidence; when `goal` is " +
        "supplied, the query itself is also judged for on_task (is this query on task for the goal, " +
        "see the `on_task` field). In gate mode, results below the configured thresholds are dropped " +
        "(see the `dropped` field). Results marked scored:false (and an on_task with scored:false) " +
        "were delivered unjudged (Jev failure or budget exhaustion) — treat their quality as unknown. " +
        modeAndThresholdsNote(config),
      inputSchema: guardedSearchInputShape,
      outputSchema: guardedSearchOutputShape,
    },
    ({ query, goal, max_results }) =>
      tracker.track(
        (async () => {
          try {
            const result = await pipeline.runSearch({
              query,
              goal,
              maxResults: max_results ?? config.maxJudged,
            });
            const budgetField = budgetFieldIfOver80(budget) ?? result.budget;
            return ok({
              search_id: result.search_id,
              query,
              ...(goal === undefined ? {} : { goal }),
              mode: config.mode,
              backends_tried: result.backends_tried,
              results: result.results,
              dropped: result.dropped,
              ...(result.on_task === undefined ? {} : { on_task: result.on_task }),
              ...(budgetField === undefined ? {} : { budget: budgetField }),
            });
          } catch (err) {
            const backendsTried = backendsTriedFrom(err);
            logErr(`guarded_search failed: ${messageOf(err)}`);
            return failed(
              errorPayload(
                backendsTried === undefined ? "search_failed" : "backend_chain_failed",
                messageOf(err),
                backendsTried,
              ),
            );
          }
        })(),
      ),
  );

  // -------------------------------------------------------------------------
  // guarded_fetch
  // -------------------------------------------------------------------------

  server.registerTool(
    "guarded_fetch",
    {
      title: "Guarded fetch",
      description:
        "Fetch a page and return its extracted text plus Jev judgments (answered, content_class, " +
        "steering_risk). steering_risk is ADVISORY: the judgment fields are emitted before the text " +
        "field so you see the flag before the content, but content is always delivered. Private, " +
        "loopback and link-local addresses are refused. " +
        modeAndThresholdsNote(config) +
        (config.mode === "gate"
          ? " In gate mode a fetch to a domain already below the credibility threshold this " +
            "session is refused outright (reason gate_refused), before any network I/O."
          : ""),
      inputSchema: guardedFetchInputShape,
      outputSchema: guardedFetchOutputShape,
    },
    ({ url, goal }) =>
      tracker.track(
        (async () => {
          let result;
          try {
            result = await pipeline.runFetch({ url, goal });
          } catch (err) {
            logErr(`guarded_fetch failed: ${messageOf(err)}`);
            return failed(errorPayload("fetch_failed", messageOf(err)));
          }

          if (!result.ok) {
            return failed(errorPayload(result.reason, result.detail));
          }

          const budgetField = budgetFieldIfOver80(budget) ?? result.budget;
          const steeringProbability = result.steering_risk?.probability;

          // Key order below IS the contract — judgment fields, then budget, then
          // text last. JSON.stringify preserves insertion order for string keys.
          return ok({
            search_id: result.search_id,
            ok: true,
            url: result.url,
            finalUrl: result.finalUrl,
            scored: result.scored,
            ...(result.budget_exhausted === true ? { budget_exhausted: true } : {}),
            steering_risk_flag: steeringProbability !== undefined && steeringProbability >= 0.5,
            ...(result.steering_risk === undefined ? {} : { steering_risk: result.steering_risk }),
            ...(result.answered === undefined ? {} : { answered: result.answered }),
            ...(result.content_class === undefined ? {} : { content_class: result.content_class }),
            truncated: result.truncated,
            ...(budgetField === undefined ? {} : { budget: budgetField }),
            text: result.text,
          });
        })(),
      ),
  );

  // -------------------------------------------------------------------------
  // research_report
  // -------------------------------------------------------------------------

  server.registerTool(
    "research_report",
    {
      title: "Research report",
      description:
        "Session aggregates grouped by goal: searches run, results judged, domains touched with " +
        "mean credibility, gate actions, flagged (low-credibility) domains, session and today's " +
        "spend, remaining budget, live gate thresholds, and the live dashboard URL. Valid before " +
        "any search has run. " +
        modeAndThresholdsNote(config),
      inputSchema: researchReportInputShape,
      outputSchema: researchReportOutputShape,
    },
    () =>
      tracker.track(
        (async () => {
          try {
            const state = budget.state();
            const goals = [...tallies.goals.entries()]
              .map(([goal, tally]) => ({
                goal,
                searches: tally.searches,
                results_judged: tally.resultsJudged,
                gate_actions: tally.gateActions,
                domains: domainStats(tally.domains),
              }))
              .sort((a, b) => b.searches - a.searches || a.goal.localeCompare(b.goal));

            const flagged = domainStats(tallies.allDomains).filter(
              (d) => d.mean_credibility !== null && d.mean_credibility < FLAGGED_CREDIBILITY,
            );

            return ok({
              session,
              mode: config.mode,
              thresholds: { min_relevance: config.minRelevance, min_credibility: config.minCredibility },
              goals,
              flagged_domains: flagged,
              session_spend_usd: state.spendUsd,
              today_spend_usd: ledger.todaySpend(),
              budget: state,
              dashboardUrl,
            });
          } catch (err) {
            logErr(`research_report failed: ${messageOf(err)}`);
            return failed(errorPayload("report_failed", messageOf(err)));
          }
        })(),
      ),
  );

  return server;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/**
 * Entry point: wire real backends, judge, budget, cache, ledger and pipeline;
 * start the dashboard; serve MCP over stdio.
 *
 * `dashboard.ts` is imported lazily, inside this function, and deliberately
 * never at module scope: `buildServer` must stay importable (by tests, and by
 * anything embedding this server) without spinning up an HTTP listener.
 */
export async function main(): Promise<void> {
  const { loadConfig } = await import("./config.ts");
  const { SearxngBackend } = await import("./backends/searxng.ts");
  const { BraveBackend } = await import("./backends/brave.ts");
  const { DuckDuckGoBackend } = await import("./backends/duckduckgo.ts");
  const { createJudge } = await import("./judge.ts");
  const { createBudget } = await import("./budget.ts");
  const { createCache } = await import("./cache.ts");
  const { createLedger } = await import("./ledger.ts");
  const { createPipeline } = await import("./pipeline.ts");
  const { JevClient } = await import("jev-client");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");

  const config = loadConfig(process.env);
  const session = randomUUID();

  // DDG is always present as the best-effort tail of the chain; SearXNG and
  // Brave only when configured. `resolveSearch` decides which of these gets
  // used (explicit selection => that one only, no fallback).
  const backends = {
    ...(config.searxngUrl === undefined ? {} : { searxng: new SearxngBackend(config.searxngUrl) }),
    ...(config.braveApiKey === undefined ? {} : { brave: new BraveBackend(config.braveApiKey) }),
    ddg: new DuckDuckGoBackend(),
  };

  // Constructed optimistically: with no key, jev-client's "auto" provider
  // falls back to MockProvider rather than throwing. That is a usable degraded
  // mode, but a silent one — so warn in jev-scout's own voice too, because
  // "mock provider" means every score in every tool response is a keyword
  // heuristic, not a Jev decision.
  // Note (F12): OPENROUTER_API_KEY / TYPESAFE_API_KEY are read directly from
  // process.env by jev-client's own provider resolution — jev-scout's Config
  // deliberately never carries a copy of either key.
  const client = new JevClient({ warnOnMock: true });
  if (client.provider.name === "mock") {
    logErr(
      "WARNING: no OPENROUTER_API_KEY or TYPESAFE_API_KEY — running on the mock provider. " +
        "Every relevance/credibility/steering_risk score is a keyword heuristic, NOT a Jev decision. " +
        "Do not trust these scores.",
    );
  }

  const judge = createJudge(client);
  const budget = createBudget({
    maxCalls: config.maxCalls,
    maxSpendUsd: config.maxSpendUsd,
    maxJudgedPerSearch: config.maxJudged,
  });
  const cache = createCache();
  const ledger = createLedger();
  const pipeline = createPipeline({ backends, judge, budget, cache, ledger, config, session });

  // Lazy, per the module doc: importing dashboard.ts binds a listener.
  const { startDashboard } = await import("./dashboard.ts");
  const dashboard = await startDashboard(ledger, { port: config.dashboardPort });
  logErr(`dashboard: ${dashboard.url}`);

  const server = buildServer({
    pipeline,
    budget,
    ledger,
    config,
    dashboardUrl: dashboard.url,
    session,
  });

  const transport = new StdioServerTransport();

  let shuttingDown = false;
  async function shutdown(reason: string, exitCode: number): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logErr(`shutting down (${reason})`);
    // F17: give any tool call already in flight (guarded_search/guarded_fetch/
    // research_report) up to 5s to finish before tearing anything down, so a
    // transport-close race never silently drops an in-progress result.
    try {
      await drainInFlight(server, 5_000);
    } catch (err) {
      logErr(`drain in-flight tool calls failed: ${messageOf(err)}`);
    }
    try {
      await dashboard.close();
    } catch (err) {
      logErr(`dashboard close failed: ${messageOf(err)}`);
    }
    try {
      await server.close();
    } catch (err) {
      logErr(`server close failed: ${messageOf(err)}`);
    }
    process.exit(exitCode);
  }

  transport.onclose = () => {
    void shutdown("transport closed", 0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT", 0));
  process.on("SIGTERM", () => void shutdown("SIGTERM", 0));

  await server.connect(transport);
  logErr(`listening on stdio (session ${session}, mode ${config.mode})`);
}

// Run only when executed directly, never when imported by tests.
const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((err: unknown) => {
    logErr(`fatal: ${messageOf(err)}`);
    process.exit(1);
  });
}
