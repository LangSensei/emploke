/**
 * `Fetcher` — pure byte-source contract.
 *
 * A fetcher knows how to materialise the contents of an origin URI in
 * one of two shapes:
 *
 *   - {@link Fetcher.fetchFile} — read **one** file. Used by the
 *     resolve path, which only needs the entry's anchor (SKILL.md /
 *     AGENTS.md / `<name>.json`) to inspect frontmatter. Cheap: a
 *     network fetcher SHOULD use a single-file API rather than
 *     downloading the whole tree.
 *   - {@link Fetcher.fetchTree} — stream **every** regular file under
 *     the origin as an `EntryFile` iterable. Used by the install path,
 *     which must persist the full tree (anchor + siblings + assets).
 *
 * The split exists because `fetchTree` is materially more expensive
 * for remote schemes (e.g. `GitHubFetcher` downloads + gunzips +
 * tar-extracts the whole repo tarball), so resolve — which fans out
 * across the entire dep graph and only needs frontmatter to decide
 * what to install — must NEVER pay the tree cost just to read one
 * anchor file.
 *
 * The contract has **no filesystem side-effect** in the public
 * surface: `FileFetcher` does touch fs internally because it has to,
 * `GitHubFetcher` streams over HTTPS without ever touching disk, and
 * any future fetcher (npm:, oci:) just produces bytes.
 *
 * Fetchers MUST be safe to call concurrently.
 */
export interface EntryFile {
  /**
   * Path relative to the entry root, ALWAYS POSIX-style (`/` separators)
   * regardless of host OS. Consumers can string-concat without
   * re-normalising. The entry's anchor file (SKILL.md / AGENTS.md /
   * `<name>.json`) is yielded under that name; sibling files keep their
   * tree shape.
   */
  readonly relPath: string;
  /** Raw bytes of the file. Buffer (not string) so binary assets survive. */
  readonly content: Buffer;
}

export interface Fetcher {
  /** Logical scheme this fetcher handles (`"file"`, `"github"`, …). */
  readonly scheme: string;
  /**
   * Read a single file relative to the origin's entry root.
   *
   * `relPath` joining rules (POSIX-style, leading slash forbidden):
   *  - For an origin whose subpath points to a directory (skill /
   *    agent root), `relPath` names a file inside that directory
   *    (e.g. `"SKILL.md"`, `"AGENTS.md"`).
   *  - For an origin whose subpath already points to a single file
   *    (mcp `<name>.json`), pass `""` — implementations resolve the
   *    file at the origin's subpath itself and ignore `relPath`.
   *  - For an origin with no subpath (repo root), `relPath` is taken
   *    relative to the repo root.
   *
   * Implementations MUST throw {@link FetchError} on transport / IO
   * failure (404, network error, etc.) and {@link OriginParseError}
   * via `parseOrigin` on a malformed URI. The returned Buffer holds
   * the file's raw bytes.
   */
  fetchFile(uri: string, relPath: string): Promise<Buffer>;
  /**
   * Stream every regular file under the origin's entry root as
   * `EntryFile` records. Implementations MUST throw {@link FetchError}
   * on transport / IO failure (and {@link OriginParseError} via
   * `parseOrigin` on malformed URI).
   */
  fetchTree(uri: string): AsyncIterable<EntryFile>;
}
