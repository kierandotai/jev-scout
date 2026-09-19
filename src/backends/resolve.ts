import type { Config } from "../config.ts";
import type { RawResult, SearchBackend } from "./types.ts";

const TAG_RE = /<[^>]*>/g;
const ENTITY_RE = /&[a-zA-Z#0-9]+;/g;
export const ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

/**
 * Strip HTML tags and decode a basic set of HTML entities. Shared by backends
 * that clean short text fragments (titles/snippets) out of JSON fields
 * (Brave bolds matched terms, e.g. `<strong>`) or scraped HTML (DDG).
 */
export function stripHtml(input: string): string {
  return input
    .replace(TAG_RE, "")
    .replace(ENTITY_RE, (entity) => ENTITY_MAP[entity] ?? entity)
    .trim();
}

/**
 * Normalize a URL for identity/dedup purposes: lowercase host, strip a
 * trailing slash and fragment, keep only http(s) schemes. Returns undefined
 * for non-http(s) URLs (e.g. "javascript:...") or unparseable strings.
 */
export function normalizeUrl(rawUrl: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;

  parsed.hostname = parsed.hostname.toLowerCase();
  parsed.hash = "";
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
    parsed.pathname = parsed.pathname.slice(0, -1);
  }
  return parsed.toString();
}

/**
 * Extract a bare domain (hostname sans "www.") from a URL. Returns undefined
 * for non-http(s) or unparseable URLs.
 */
export function domainFromUrl(rawUrl: string): string | undefined {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    const host = parsed.hostname.toLowerCase();
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return undefined;
  }
}

/**
 * Build a RawResult from raw backend fields, normalizing the URL and
 * deriving the domain. Returns undefined when the URL is invalid or
 * non-http(s), so backends can filter these out.
 */
export function toRawResult(title: string, rawUrl: string, snippet: string): RawResult | undefined {
  const url = normalizeUrl(rawUrl);
  if (url === undefined) return undefined;
  const domain = domainFromUrl(url);
  if (domain === undefined) return undefined;
  return { title, url, snippet, domain };
}

/** Dedupe results by normalized URL, keeping the first occurrence. */
export function dedupeResults(results: RawResult[]): RawResult[] {
  const seen = new Set<string>();
  const out: RawResult[] = [];
  for (const r of results) {
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    out.push(r);
  }
  return out;
}

/** Result of resolving a search across the backend chain. */
export interface BackendChainResult {
  readonly results: RawResult[];
  readonly backendsTried: string[];
}

/**
 * Raised when every backend in an auto-resolution chain failed. Carries the
 * ordered list of backend names attempted so callers/observability can
 * report exactly what was tried.
 */
export class BackendChainError extends Error {
  readonly backendsTried: string[];

  constructor(message: string, backendsTried: string[], options: { cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "BackendChainError";
    this.backendsTried = backendsTried;
  }
}

/** Backend instances available for resolution, keyed by config backend name. */
export interface BackendSet {
  searxng?: SearchBackend;
  brave?: SearchBackend;
  /** DDG is the best-effort fallback and is always available. */
  ddg: SearchBackend;
}

/**
 * Select the ordered list of backends to try for this search, per the KTD:
 * an explicit JEV_SCOUT_BACKEND selects that backend only (no fallback);
 * otherwise auto-resolve the chain SearXNG (if configured) -> Brave (if
 * configured) -> DDG.
 */
export function selectBackends(cfg: Config, backends: BackendSet): SearchBackend[] {
  if (cfg.backend !== undefined) {
    const explicit = backends[cfg.backend];
    if (explicit === undefined) {
      throw new Error(
        `JEV_SCOUT_BACKEND=${cfg.backend} was selected, but no backend instance is configured for it ` +
          `(check SEARXNG_URL / BRAVE_API_KEY)`,
      );
    }
    return [explicit];
  }
  const chain: SearchBackend[] = [];
  if (backends.searxng) chain.push(backends.searxng);
  if (backends.brave) chain.push(backends.brave);
  chain.push(backends.ddg);
  return chain;
}

/**
 * Try backends in order; the first to succeed (including with zero results)
 * wins — zero results is a valid answer and does not trigger fallback.
 * Backend *errors* fall through to the next backend. If every backend
 * errors, throws BackendChainError carrying the full attempted list.
 */
export async function searchChain(
  backends: SearchBackend[],
  query: string,
  count: number,
): Promise<BackendChainResult> {
  const tried: string[] = [];
  let lastError: unknown;
  for (const backend of backends) {
    tried.push(backend.name);
    try {
      const results = await backend.search(query, count);
      return { results: dedupeResults(results), backendsTried: tried };
    } catch (err) {
      lastError = err;
    }
  }
  throw new BackendChainError(
    `All backends in the chain failed: ${tried.join(" -> ")}`,
    tried,
    { cause: lastError },
  );
}

/**
 * Resolve and run a search per config: explicit backend selection bypasses
 * the chain entirely (its errors propagate directly, no fallback attempted,
 * no BackendChainError wrapping); auto-resolution runs searchChain.
 */
export async function resolveSearch(
  cfg: Config,
  backends: BackendSet,
  query: string,
  count: number,
): Promise<BackendChainResult> {
  const selected = selectBackends(cfg, backends);
  if (cfg.backend !== undefined) {
    const only = selected[0]!;
    const results = await only.search(query, count);
    return { results: dedupeResults(results), backendsTried: [only.name] };
  }
  return searchChain(selected, query, count);
}
