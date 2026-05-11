/**
 * Error types thrown by `@emploke/catalog-fetcher`.
 *
 * These are deliberately defined here (not in `@emploke/catalog`) because
 * `catalog-fetcher` has zero `@emploke/catalog` dep — it is the lower
 * layer. `catalog` re-exports them from its own `index.ts` for the
 * benefit of consumers that already import from `@emploke/catalog`.
 */

export class FetcherError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = new.target.name;
  }
}

/**
 * Origin URI failed to parse. Surfaces the raw URI plus the reason so the
 * dashboard / CLI can echo it back to the user without exposing internal
 * paths. Phase 1 schemes: `https://github.com/owner/repo/tree/ref/[path]`
 * and `file:<absolutePath>`.
 */
export class OriginParseError extends FetcherError {
  constructor(
    public readonly origin: string,
    reason: string,
  ) {
    super(`invalid origin "${origin}": ${reason}`);
  }
}

/**
 * A {@link Fetcher} failed to materialize an origin's contents. Wraps the
 * underlying cause (network error, HTTP status, missing file, etc.) so the
 * route layer can map to HTTP 502 with a sanitized public message while the
 * server log retains the full detail.
 */
export class FetchError extends FetcherError {
  constructor(
    public readonly origin: string,
    reason: string,
    options?: { cause?: unknown },
  ) {
    super(`failed to fetch "${origin}": ${reason}`, options);
  }
}
