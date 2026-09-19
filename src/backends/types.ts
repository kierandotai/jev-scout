/** A single normalized search result, shared across all backends. */
export interface RawResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly domain: string;
}

/** A pluggable search backend: given a query and a desired count, return results. */
export interface SearchBackend {
  readonly name: string;
  search(query: string, count: number): Promise<RawResult[]>;
}

export interface BackendErrorOptions {
  cause?: unknown;
  retryable?: boolean;
}

/** Typed failure raised by a backend. Carries which backend failed and whether retrying makes sense. */
export class BackendError extends Error {
  readonly backend: string;
  readonly retryable: boolean;

  constructor(message: string, backend: string, options: BackendErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "BackendError";
    this.backend = backend;
    this.retryable = options.retryable ?? false;
  }
}

/**
 * A backend-reported rate limit / anti-bot challenge that is expected to
 * clear on its own (e.g. HTTP 429, or DDG's anomaly-detection challenge).
 * Always retryable.
 */
/** True for AbortSignal.timeout() rejections (AbortError pre-timeout, TimeoutError after). */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

export class SoftRateLimitError extends BackendError {
  constructor(message: string, backend: string, options: BackendErrorOptions = {}) {
    super(message, backend, { ...options, retryable: options.retryable ?? true });
    this.name = "SoftRateLimitError";
  }
}
