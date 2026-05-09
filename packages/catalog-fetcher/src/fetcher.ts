/**
 * `Fetcher` — pure stream contract.
 *
 * A fetcher knows how to materialise the contents of a single origin URI
 * as an ordered stream of `EntryFile` records, one per regular file in
 * the would-be on-disk tree. The stream contract deliberately has **no
 * filesystem side-effect** in the public surface:
 *
 *   - `FileFetcher` walks the user-supplied directory and yields entries
 *     directly (it does touch fs internally — it has to — but only as an
 *     implementation detail).
 *   - `GitHubFetcher` streams a tarball over HTTPS, extracts it on the
 *     fly, and yields entries without ever touching disk.
 *   - Any future fetcher (npm:, oci:) just produces an iterable.
 *
 * Consumers (`Repository.install`, `deepInstall`) consume the stream and
 * decide what to do with it (write to disk via `replaceDirAtomic`, parse
 * frontmatter, etc.) — the fetcher does not know or care.
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
   * Stream the contents of `uri` as `EntryFile` records. Implementations
   * MUST throw {@link FetchError} on transport / IO failure (and
   * {@link OriginParseError} via `parseOrigin` on malformed URI).
   */
  fetch(uri: string): AsyncIterable<EntryFile>;
}
