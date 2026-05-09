/**
 * Catalog-level metadata Repository contract.
 *
 * The {@link CatalogRepository} stores `catalog.json` — the catalog's
 * own configuration file. Today this carries the {@link ScopeMappings}
 * map (publisher pattern → scope) used by {@link ScopeResolver} for L2
 * resolution; future fields (trustedOrigins, displayPreferences, …)
 * extend the same file behind the same repository surface.
 *
 * Like the per-entry repositories, this is a pure storage seam:
 * implementations deal in raw `CatalogConfig` records, do not parse
 * scope-mapping patterns, and do not validate semantics. Validation
 * lives in the catalog layer (e.g. version-compat checks, pattern
 * grammar) so swapping a backend (FS / SQLite / object store) doesn't
 * have to re-implement those rules.
 */

/**
 * Schema version of `catalog.json`. Bumped on any backwards-incompatible
 * change. Loaders MUST refuse unknown versions (fail loud at boot rather
 * than silently corrupt data).
 */
export const CATALOG_CONFIG_VERSION = 1 as const;

/**
 * Shape of `catalog.json` (catalog-level metadata).
 *
 * `scopeMappings` is a flat map from publisher-pattern → scope.
 * Patterns end with `*` (the only wildcard supported). The
 * {@link ScopeResolver} performs longest-match lookup; per-pattern
 * uniqueness is enforced by the JSON object key semantics — duplicate
 * keys collapse on parse, so we don't need a runtime check.
 *
 * Example:
 *   { "github.com/LangSensei/*": "langsensei",
 *     "github.com/LangSensei/marketplace/skills/travel/*": "travel",
 *     "file://*": "local" }
 */
export interface CatalogConfig {
  readonly version: typeof CATALOG_CONFIG_VERSION;
  readonly scopeMappings: Readonly<Record<string, string>>;
}

/**
 * Repository of catalog-level metadata.
 *
 *  - `read()` returns the on-disk config or `null` when the file is
 *    absent (fresh catalog dir). Implementations MUST distinguish
 *    "absent" (null) from "empty but present" ({} object) so the
 *    catalog layer can tell whether to create a v1 stub.
 *  - `write(config)` MUST be atomic (tmp + rename) so concurrent reads
 *    never see partial JSON. The repository owns serialisation; callers
 *    pass the typed record.
 */
export interface CatalogRepository {
  read(): Promise<CatalogConfig | null>;
  write(config: CatalogConfig): Promise<void>;
}
