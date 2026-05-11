/**
 * @emploke/catalog-fetcher
 *
 * Pluggable origin-URI fetchers for emploke's catalog. Owns:
 *
 *   - `parseOrigin` / `normalizeOrigin` — URI grammar
 *   - `Fetcher` interface (pure stream, fs-agnostic)
 *   - `FileFetcher`, `GitHubFetcher` — Phase 1 implementations
 *   - `FetcherRegistry` — scheme → fetcher dispatch
 *   - `OriginParseError`, `FetchError`
 *
 * Single responsibility: turn a URI into a stream of bytes. No knowledge
 * of frontmatter, scope, identity, dependencies — those live in
 * `@emploke/catalog`. Zero dependency on catalog (lower layer).
 */

export { FetchError, FetcherError, OriginParseError } from "./errors.js";
export type { EntryFile, Fetcher } from "./fetcher.js";
export { FileFetcher } from "./file-fetcher.js";
export { GitHubFetcher } from "./github-fetcher.js";
export { normalizeOrigin, type ParsedOrigin, parseOrigin } from "./origin.js";
export { defaultFetcherRegistry, FetcherRegistry } from "./registry.js";
