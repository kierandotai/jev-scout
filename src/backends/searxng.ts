import { BackendError, SoftRateLimitError, type RawResult, type SearchBackend } from "./types.ts";
import { dedupeResults, toRawResult } from "./resolve.ts";

interface SearxngResult {
  title?: string;
  url?: string;
  content?: string;
}

interface SearxngResponse {
  results?: SearxngResult[];
}

export interface SearxngBackendOptions {
  /** Fetch timeout (ms) for each SearXNG request, via AbortSignal.timeout(). Default 15000. */
  timeoutMs?: number;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

export class SearxngBackend implements SearchBackend {
  readonly name = "searxng";
  readonly #baseUrl: string;
  readonly #timeoutMs: number;

  constructor(baseUrl: string, options: SearxngBackendOptions = {}) {
    this.#baseUrl = baseUrl.replace(/\/+$/, "");
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  async search(query: string, count: number): Promise<RawResult[]> {
    const url = new URL(`${this.#baseUrl}/search`);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      if (isAbortError(err)) {
        throw new BackendError(`SearXNG request timed out after ${this.#timeoutMs}ms`, this.name, {
          retryable: true,
          cause: err,
        });
      }
      throw err;
    }

    if (res.status === 429) {
      throw new SoftRateLimitError("SearXNG rate-limited the request (429)", this.name);
    }
    if (res.status === 403) {
      throw new BackendError(
        "SearXNG returned 403 — enable JSON output on the instance " +
          "(settings.yml: search.formats: [html, json])",
        this.name,
        { retryable: false },
      );
    }
    if (!res.ok) {
      throw new BackendError(`SearXNG returned ${res.status}`, this.name, { retryable: false });
    }

    const body = (await res.json()) as SearxngResponse;
    const normalized: RawResult[] = [];
    for (const r of body.results ?? []) {
      const item = toRawResult(r.title ?? "", r.url ?? "", r.content ?? "");
      if (item) normalized.push(item);
    }
    return dedupeResults(normalized).slice(0, count);
  }
}
