import type { CatalogKind } from "../types.js";

/**
 * Thrown when deleting an entity that other entities still depend on.
 * Raised inside the per-entity repository's delete transaction — the
 * repo counts reverse-dep rows and, if any exist, builds the dependent
 * list from the same tables (skill/agent → skill/mcp) and throws,
 * rolling back the empty delete.
 *
 * Lives in `_shared/` rather than `facade/` so per-entity repositories
 * (which sit below the facade layer) can raise it without an upward
 * import. The facade re-exports it so external callers keep using the
 * stable `@emploke/catalog` and `@emploke/catalog/facade` import paths.
 */
export class HasDependentsError extends Error {
  override readonly name = "HasDependentsError";

  constructor(
    public readonly targetName: string,
    public readonly dependents: readonly { kind: CatalogKind; name: string }[],
  ) {
    super(
      `cannot delete "${targetName}" — still referenced by ${dependents
        .map((d) => `${d.kind} ${d.name}`)
        .join(", ")}`,
    );
  }
}
