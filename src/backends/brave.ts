import { BackendError, SoftRateLimitError, type RawResult, type SearchBackend } from "./types.ts";
import { dedupeResults, stripHtml, toRawResult } from "./resolve.ts";

interface BraveResult {
  title?: string;
  url?: string;
  description?: string;
}

interface BraveResponse {
  web?: { results?: BraveResult[] };
}

export interface BraveBackendOptions {
  /** Fetch timeout (ms) for each Brave request, via AbortSignal.timeout(). Default 15000. */
  timeoutMs?: number;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

export class BraveBackend implements SearchBackend {
  readonly name = "brave";
  readonly #apiKey: string;
  readonly #timeoutMs: number;

  constructor(apiKey: string, options: BraveBackendOptions = {}) {
    this.#apiKey = apiKey;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  async search(query: string, count: number): Promise<RawResult[]> {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(count));

    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": this.#apiKey,
        },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      if (isAbortError(err)) {
        throw new BackendError(`Brave request timed out after ${this.#timeoutMs}ms`, this.name, {
          retryable: true,
          cause: err,
        });
      }
      throw err;
    }

    if (res.status === 429) {
      throw new SoftRateLimitError("Brave rate-limited the request (429)", this.name);
    }
    if (!res.ok) {
      throw new BackendError(`Brave returned ${res.status}`, this.name, { retryable: false });
    }

    const body = (await res.json()) as BraveResponse;
    // `web` is absent for some query types (e.g. pure-answer queries) — that's a valid empty result set, not an error.
    const rawResults = body.web?.results ?? [];
    const normalized: RawResult[] = [];
    for (const r of rawResults) {
      const item = toRawResult(r.title ?? "", r.url ?? "", stripHtml(r.description ?? ""));
      if (item) normalized.push(item);
    }
    return dedupeResults(normalized).slice(0, count);
  }
}
