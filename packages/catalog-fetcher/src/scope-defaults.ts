import type { ParsedOrigin } from "./origin.js";

/**
 * The L3 (per-source-type default) scope-mapping recommendation for a
 * given origin: the wildcard pattern under which entries from this
 * publisher should fall, and the scope that pattern resolves to.
 *
 * The pattern is the "publisher prefix" — a string the
 * {@link scope-resolver}'s longest-pattern-match algorithm uses for L2
 * lookups, with `*` as a tail wildcard. Examples:
 *
 *  - GitHub origin `github.com/LangSensei/marketplace/tree/main/foo`
 *    → `{ pattern: "github.com/LangSensei/*", scope: "langsensei" }`
 *  - File origin   `file:/abs/path/foo`
 *    → `{ pattern: "file://*",                scope: "local" }`
 *
 * A {@link CatalogManager} uses this to (a) auto-write a stable L2
 * mapping into `catalog.json` the first time a new publisher is
 * encountered, and (b) seed the L2 lookup for subsequent installs so
 * scope assignment stays stable even if individual origins mutate
 * (e.g., a different `tree/<ref>` of the same repo).
 */
export interface ScopeMappingDefault {
  readonly pattern: string;
  readonly scope: string;
}

/**
 * Compute the L3 scope-mapping default for an origin. Returns the
 * publisher-level wildcard pattern and the scope it resolves to.
 *
 * This is the single source of truth for "how does emploke decide a
 * default scope when nothing else is configured?" — the
 * {@link scopeFromOrigin} fallback is a strict subset of this output
 * (just the `scope` field), kept for code paths that don't need the
 * pattern.
 *
 * Source-type → default:
 *  - `github` → `github.com/<owner>/*` → `<owner>.toLowerCase()`
 *  - `file`   → `file://*`             → `local`
 *
 * Future schemes (npm, https://, ipfs:) extend this dispatch.
 */
export function defaultMapping(origin: ParsedOrigin): ScopeMappingDefault {
  switch (origin.scheme) {
    case "github":
      return {
        pattern: `github.com/${origin.owner}/*`,
        scope: origin.owner.toLowerCase(),
      };
    case "file":
      return { pattern: "file://*", scope: "local" };
  }
}
