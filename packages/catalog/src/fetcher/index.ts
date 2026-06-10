/**
 * Catalog fetchers — pluggable origin-URI fetchers used by catalog's
 * resolve + install pipeline. Owns:
 *
 *   - `parseOrigin` / `normalizeOrigin` — URI grammar
 *   - `Fetcher` interface (pure stream, fs-agnostic)
 *   - `FileFetcher`, `GitHubFetcher`, `AzureDevOpsFetcher` — built-in
 *     implementations
 *   - `FetcherRegistry` — scheme → fetcher dispatch
 *   - `OriginParseError`, `FetchError`
 *
 * Single responsibility: turn a URI into a stream of bytes. No
 * knowledge of frontmatter, scope, identity, or dependencies — those
 * live in the parent catalog package.
 */

export { resolveDefaultAdoToken, tryGitCredentialFill } from "./ado-token.js";
export { AzureDevOpsFetcher } from "./azure-devops-fetcher.js";
export { FetchError, FetcherError, OriginParseError } from "./errors.js";
export type { EntryFile, Fetcher } from "./fetcher.js";
export { FileFetcher } from "./file-fetcher.js";
export { resolveDefaultGitHubToken, tryGhAuthToken } from "./gh-token.js";
export { GitHubFetcher } from "./github-fetcher.js";
export { normalizeOrigin, type ParsedOrigin, parseOrigin, sameOrigin } from "./origin.js";
export { defaultFetcherRegistry, FetcherRegistry } from "./registry.js";
