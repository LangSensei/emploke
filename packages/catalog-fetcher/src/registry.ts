import type { EntryFile, Fetcher } from "./fetcher.js";
import { FileFetcher } from "./file-fetcher.js";
import { GitHubFetcher } from "./github-fetcher.js";
import { type ParsedOrigin, parseOrigin } from "./origin.js";

/**
 * Lookup table from origin scheme → fetcher implementation. Built once at
 * construction so adding a Phase-2 scheme is just `register("npm", ...)`.
 *
 * Why a registry rather than a switch? Two reasons:
 *
 *  1. Tests can install a mock fetcher for a real scheme (e.g. swap
 *     GitHubFetcher for one that yields from an in-memory tarball
 *     fixture) without monkey-patching call sites.
 *
 *  2. Phase-2 schemes (npm, generic git+ssh) can be added in their own
 *     subpackage that depends only on the fetcher contract.
 */
export class FetcherRegistry {
  private readonly bySchemeMap = new Map<string, Fetcher>();

  register(fetcher: Fetcher): void {
    this.bySchemeMap.set(fetcher.scheme, fetcher);
  }

  get(scheme: string): Fetcher | null {
    return this.bySchemeMap.get(scheme) ?? null;
  }

  /** Resolve a parsed origin to its fetcher; throws on unsupported scheme. */
  resolve(origin: ParsedOrigin): Fetcher {
    const f = this.get(origin.scheme);
    if (!f) {
      throw new Error(
        `no fetcher registered for scheme "${origin.scheme}" (origin: ${origin.raw})`,
      );
    }
    return f;
  }

  /**
   * Parse `originUri`, dispatch to the matching fetcher, and return its
   * stream. Used by `deepInstall` and any caller that has a raw URI string.
   */
  dispatch(originUri: string): AsyncIterable<EntryFile> {
    const origin = parseOrigin(originUri);
    return this.resolve(origin).fetch(originUri);
  }
}

/**
 * Build the default registry shipped by emploke: `file:` + `github:`.
 */
export function defaultFetcherRegistry(): FetcherRegistry {
  const reg = new FetcherRegistry();
  reg.register(new FileFetcher());
  reg.register(new GitHubFetcher());
  return reg;
}
