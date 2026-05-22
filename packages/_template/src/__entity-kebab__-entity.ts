/**
 * Domain entity for `@emploke/__PKG__`. Pkg-owned plain interface
 * (no methods — replace with a `class` when state transitions /
 * invariants show up; see `catalog/agent/agent-entity.ts` and
 * `task/task-entity.ts` for examples).
 *
 * Layer position:
 *   - `__Entity__Row`     (schema.ts)               — Drizzle ORM shape; private
 *   - `__Entity__Entity`  (this file)               — pkg-owned domain shape;
 *                                                     what the repository
 *                                                     returns. Today
 *                                                     structurally identical
 *                                                     to the row; the name
 *                                                     separation is
 *                                                     contractual.
 *   - `__Entity__`        (types.ts)                — wire DTO; what the
 *                                                     service returns.
 *                                                     Diverges from Entity
 *                                                     when a field needs
 *                                                     normalisation / a
 *                                                     composite source.
 *
 * Not re-exported from `index.ts`: external consumers see only the
 * `__Entity__` DTO. The entity is the contract between the
 * repository and the service inside this pkg.
 */
export interface __Entity__Entity {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}
