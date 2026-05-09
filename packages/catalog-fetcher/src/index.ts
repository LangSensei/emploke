/**
 * @emploke/catalog-fetcher
 *
 * Pluggable origin-URI fetchers for emploke's catalog. Owns:
 *
 *   - `parseOrigin` / `scopeFromOrigin` / `normalizeOrigin` — URI grammar
 *   - `Fetcher` interface (pure stream, fs-agnostic)
 *   - `FileFetcher`, `GitHubFetcher` — Phase 1 implementations
 *   - `FetcherRegistry` — scheme → fetcher dispatch
 *   - `OriginParseError`, `FetchError`
 *
 * Zero dependency on `@emploke/catalog`: this is the lower layer. The
 * `catalog` package depends on this and re-exports the public surface
 * for the convenience of consumers that already import from
 * `@emploke/catalog`.
 */

export { FetchError, FetcherError, OriginParseError } from "./errors.js";
export type { EntryFile, Fetcher } from "./fetcher.js";
export { FileFetcher } from "./file-fetcher.js";
export { GitHubFetcher } from "./github-fetcher.js";
export {
  normalizeOrigin,
  parseOrigin,
  type ParsedOrigin,
  scopeFromOrigin,
} from "./origin.js";
export { defaultFetcherRegistry, FetcherRegistry } from "./registry.js";
export { defaultMapping, type ScopeMappingDefault } from "./scope-defaults.js";
