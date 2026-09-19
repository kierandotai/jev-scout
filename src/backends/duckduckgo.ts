import { BackendError, SoftRateLimitError, isAbortError, type RawResult, type SearchBackend } from "./types.ts";
import { dedupeResults, stripHtml, toRawResult } from "./resolve.ts";

const DDG_URL = "https://html.duckduckgo.com/html/";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const ACCEPT_HEADER = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

// Matches the opening tag of each result container div, e.g.
// `<div class="result results_links ...">` or the ad variant
// `<div class="result result--ad ...">`. The class attribute must *start*
// with the "result" token (word boundary) so inner elements like
// `result__body` never match.
const RESULT_BLOCK_START_RE = /<div class="result\b[^"]*"/g;

// Single-shot (non-global) — applied per result block, at most one match each.
const TITLE_RE = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/;
const SNIPPET_RE = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/;

const ANOMALY_MARKERS = ["anomaly.js", "challenge-form", "anomaly-modal"];

/**
 * Split the response body into one chunk per result container div (from the
 * start of its opening tag to the start of the next result div, or end of
 * body for the last one). Parsing per-block — rather than zipping two
 * independent global regex scans by index — keeps a result's title and
 * snippet correctly paired even when some result has no snippet at all.
 */
function splitResultBlocks(body: string): string[] {
  const starts = [...body.matchAll(RESULT_BLOCK_START_RE)].map((m) => m.index);
  const blocks: string[] = [];
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1]! : body.length;
    blocks.push(body.slice(starts[i]!, end));
  }
  return blocks;
}

/** Resolve a result__a href: decode the uddg redirect param, or use the href as-is. */
function resolveHref(href: string): string | undefined {
  // Attribute values in the scraped HTML carry entity-encoded "&" (e.g. "&amp;")
  // between query params — decode before URL-parsing so params like "rut"
  // don't get swallowed into the "uddg" value.
  const decoded = href.replace(/&amp;/g, "&").replace(/&#38;/g, "&");
  const candidate = decoded.startsWith("//") ? `https:${decoded}` : decoded;
  try {
    const parsed = new URL(candidate, "https://duckduckgo.com");
    const uddg = parsed.searchParams.get("uddg");
    return uddg && uddg.length > 0 ? uddg : parsed.toString();
  } catch {
    return undefined;
  }
}

function jitterDelayMs(minMs: number, maxMs: number): number {
  if (maxMs <= minMs) return minMs;
  return minMs + Math.random() * (maxMs - minMs);
}

function delay(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

// Module-level lock: every DuckDuckGoBackend instance in this process
// serializes through the same chain, one request at a time, regardless of
// how many instances exist.
let requestChain: Promise<void> = Promise.resolve();

// Callers waiting for their turn on `requestChain` (i.e. not yet executing).
// Capped so a pile-up of blocked callers (e.g. behind a slow/hung request)
// fails fast instead of parking unboundedly.
let queueDepth = 0;
const MAX_QUEUE_DEPTH = 8;

function withSerialization<T>(
  minMs: number,
  maxMs: number,
  backendName: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (queueDepth >= MAX_QUEUE_DEPTH) {
    return Promise.reject(
      new SoftRateLimitError(
        `DuckDuckGo request queue is full (${MAX_QUEUE_DEPTH} callers already waiting)`,
        backendName,
      ),
    );
  }
  queueDepth++;
  const gate = requestChain;
  let release: () => void = () => {};
  requestChain = new Promise<void>((resolve) => {
    release = resolve;
  });
  const result = gate.then(() => {
    // This caller's turn has arrived — it's no longer "parked" waiting, it's
    // now running (and may still take a while, e.g. the fetch itself).
    queueDepth--;
    return fn();
  });
  // Schedule the next slot's release after this one settles (success or
  // failure) plus the jittered delay. Attached via .then(onFulfilled,
  // onRejected) rather than .finally() so this bookkeeping branch always
  // settles fulfilled itself — .finally() would re-raise `result`'s
  // rejection on its own (discarded) derived promise, producing a spurious
  // unhandledRejection independent of the one the caller observes on `result`.
  // This runs on rejection too, so a request that fails (including one that
  // times out via AbortSignal — see #doSearch) still releases the lock for
  // the next caller instead of wedging the queue forever.
  result.then(
    () => void delay(jitterDelayMs(minMs, maxMs)).then(release),
    () => void delay(jitterDelayMs(minMs, maxMs)).then(release),
  );
  return result;
}

export interface DuckDuckGoBackendOptions {
  /** Minimum jittered delay (ms) enforced after each request before the next may start. Default 1000. */
  minDelayMs?: number;
  /** Maximum jittered delay (ms). Default 2000. */
  maxDelayMs?: number;
  /** Fetch timeout (ms) for each DDG request, via AbortSignal.timeout(). Default 15000. */
  timeoutMs?: number;
}

export class DuckDuckGoBackend implements SearchBackend {
  readonly name = "ddg";
  readonly #minDelayMs: number;
  readonly #maxDelayMs: number;
  readonly #timeoutMs: number;

  constructor(options: DuckDuckGoBackendOptions = {}) {
    this.#minDelayMs = options.minDelayMs ?? 1000;
    this.#maxDelayMs = options.maxDelayMs ?? 2000;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  search(query: string, count: number): Promise<RawResult[]> {
    return withSerialization(this.#minDelayMs, this.#maxDelayMs, this.name, () =>
      this.#doSearch(query, count),
    );
  }

  async #doSearch(query: string, count: number): Promise<RawResult[]> {
    let res: Response;
    try {
      res = await fetch(DDG_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": USER_AGENT,
          Accept: ACCEPT_HEADER,
        },
        body: new URLSearchParams({ q: query }).toString(),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      if (isAbortError(err)) {
        throw new BackendError(`DuckDuckGo request timed out after ${this.#timeoutMs}ms`, this.name, {
          retryable: true,
          cause: err,
        });
      }
      throw err;
    }

    const body = await res.text();

    if (res.status === 202 || ANOMALY_MARKERS.some((marker) => body.includes(marker))) {
      throw new SoftRateLimitError("DuckDuckGo served an anomaly-detection challenge", this.name);
    }
    if (!res.ok) {
      throw new BackendError(`DuckDuckGo returned ${res.status}`, this.name, { retryable: false });
    }

    const normalized: RawResult[] = [];
    for (const block of splitResultBlocks(body)) {
      if (block.includes("result--ad")) continue; // sponsored result container
      const titleMatch = block.match(TITLE_RE);
      if (!titleMatch) continue;
      const rawHref = titleMatch[1] ?? "";
      if (rawHref.includes("y.js")) continue; // sponsored redirect link
      const href = resolveHref(rawHref);
      if (href === undefined) continue;
      const title = stripHtml(titleMatch[2] ?? "");
      const snippetMatch = block.match(SNIPPET_RE);
      const snippet = snippetMatch ? stripHtml(snippetMatch[1] ?? "") : "";
      const item = toRawResult(title, href, snippet);
      if (item) normalized.push(item);
    }
    return dedupeResults(normalized).slice(0, count);
  }
}
