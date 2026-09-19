import { BackendError, SoftRateLimitError, type RawResult, type SearchBackend } from "./types.ts";
import { dedupeResults, toRawResult } from "./resolve.ts";

const DDG_URL = "https://html.duckduckgo.com/html/";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const ACCEPT_HEADER = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

const TITLE_RE = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
const SNIPPET_RE = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

const ANOMALY_MARKERS = ["anomaly.js", "challenge-form", "anomaly-modal"];

const TAG_RE = /<[^>]*>/g;
const ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

function textOf(html: string): string {
  return html
    .replace(TAG_RE, "")
    .replace(/&[a-zA-Z#0-9]+;/g, (entity) => ENTITY_MAP[entity] ?? entity)
    .trim();
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

function withSerialization<T>(minMs: number, maxMs: number, fn: () => Promise<T>): Promise<T> {
  const gate = requestChain;
  let release: () => void = () => {};
  requestChain = new Promise<void>((resolve) => {
    release = resolve;
  });
  const result = gate.then(fn);
  // Schedule the next slot's release after this one settles (success or
  // failure) plus the jittered delay. Attached via .then(onFulfilled,
  // onRejected) rather than .finally() so this bookkeeping branch always
  // settles fulfilled itself — .finally() would re-raise `result`'s
  // rejection on its own (discarded) derived promise, producing a spurious
  // unhandledRejection independent of the one the caller observes on `result`.
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
}

export class DuckDuckGoBackend implements SearchBackend {
  readonly name = "ddg";
  readonly #minDelayMs: number;
  readonly #maxDelayMs: number;

  constructor(options: DuckDuckGoBackendOptions = {}) {
    this.#minDelayMs = options.minDelayMs ?? 1000;
    this.#maxDelayMs = options.maxDelayMs ?? 2000;
  }

  search(query: string, count: number): Promise<RawResult[]> {
    return withSerialization(this.#minDelayMs, this.#maxDelayMs, () => this.#doSearch(query, count));
  }

  async #doSearch(query: string, count: number): Promise<RawResult[]> {
    const res = await fetch(DDG_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
        Accept: ACCEPT_HEADER,
      },
      body: new URLSearchParams({ q: query }).toString(),
    });

    const body = await res.text();

    if (res.status === 202 || ANOMALY_MARKERS.some((marker) => body.includes(marker))) {
      throw new SoftRateLimitError("DuckDuckGo served an anomaly-detection challenge", this.name);
    }
    if (!res.ok) {
      throw new BackendError(`DuckDuckGo returned ${res.status}`, this.name, { retryable: false });
    }

    const titles: { href: string; text: string }[] = [];
    for (const m of body.matchAll(TITLE_RE)) {
      titles.push({ href: m[1] ?? "", text: textOf(m[2] ?? "") });
    }
    const snippets: string[] = [];
    for (const m of body.matchAll(SNIPPET_RE)) {
      snippets.push(textOf(m[1] ?? ""));
    }

    const normalized: RawResult[] = [];
    for (let i = 0; i < titles.length; i++) {
      const t = titles[i]!;
      const href = resolveHref(t.href);
      if (href === undefined) continue;
      const item = toRawResult(t.text, href, snippets[i] ?? "");
      if (item) normalized.push(item);
    }
    return dedupeResults(normalized).slice(0, count);
  }
}
