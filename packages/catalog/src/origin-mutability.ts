import { parseOrigin } from "./fetcher/index.js";

/**
 * Origin mutability — single rule for "can the catalog mutate this entry's
 * SQLite-stored content / metadata?".
 *
 * **Phase 2 rule**: an entry is mutable iff its origin's parsed scheme is
 * in {@link MUTABLE_SCHEMES}. Currently `file:` only — local working
 * copies are mutable; remote-sourced entries (`github:`, future `npm:`/
 * `oci:`/`fqn:`) are read-only mirrors that can only be refreshed from
 * upstream via re-install (which is upsert).
 *
 * Mutation is **catalog-only** (Phase 2 decision): editing a `file:`
 * entry in the dashboard updates the SQLite copy WITHOUT writing back
 * to the origin file. A future `export` flow can write the catalog
 * back to the origin path.
 *
 * Why route through `parseOrigin` instead of a `startsWith("file:")`
 * substring check? Two reasons:
 *   1. The fetcher already owns origin grammar (single source of truth
 *      for what "valid origin" means). A garbled URI that the fetcher
 *      would reject must also be considered immutable here, otherwise
 *      a malformed `file:foo` could slip past mutability gating.
 *   2. Adding a new scheme (e.g. `oci:`) only touches `MUTABLE_SCHEMES`
 *      below, not every call site that does string prefix tests.
 *
 * Calling sites:
 *   - `SkillService.updateAnchor`
 *   - `AgentService.updateAnchor`
 *   - `McpService.updateContent`
 *   - facade `buildSkillEntry` / `buildAgentEntry` / `listMcps` (project
 *     `mutable: boolean` onto the wire POJOs so the dashboard can switch
 *     Edit vs Sync UI without a separate roundtrip)
 *
 * The three services throw {@link ImmutableOriginError} when the check
 * fails; the server route layer maps that error name to HTTP 405.
 *
 * **Future**: when the Fetcher count grows (npm/oci/registry-backed
 * fetchers), consider lifting this into `Fetcher.readonly: boolean` so
 * each fetcher self-declares (and `FileFetcher` can even pre-check
 * `access(W_OK)` to surface "the file is read-only" as immutable). For
 * now a centralized scheme set keeps the policy in one place.
 */

const MUTABLE_SCHEMES = new Set<string>(["file"]);

export function isOriginMutable(origin: string): boolean {
  try {
    return MUTABLE_SCHEMES.has(parseOrigin(origin).scheme);
  } catch {
    // Unparseable origin → treat as immutable. The catalog shouldn't
    // hold an entry whose origin doesn't parse (install-time validation
    // would have rejected it), but defending against it costs one
    // try/catch and avoids a panic if a corrupted SQLite row sneaks in.
    return false;
  }
}

export class ImmutableOriginError extends Error {
  override readonly name = "ImmutableOriginError";
  constructor(
    /** FQN of the entry whose mutation was rejected. */
    readonly fqn: string,
    /** The origin URI that triggered the rejection. */
    readonly origin: string,
  ) {
    super(
      `cannot mutate "${fqn}" — origin "${origin}" is immutable. ` +
        "Only entries installed from `file:` origins can be edited in place. " +
        "To pick up upstream changes for a remote entry, re-install it from " +
        "the same origin (this acts as a sync).",
    );
  }
}
