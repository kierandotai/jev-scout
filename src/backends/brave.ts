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

export class BraveBackend implements SearchBackend {
  readonly name = "brave";
  readonly #apiKey: string;

  constructor(apiKey: string) {
    this.#apiKey = apiKey;
  }

  async search(query: string, count: number): Promise<RawResult[]> {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(count));

    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": this.#apiKey,
      },
    });

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
