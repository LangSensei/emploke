/**
 * Public types for `@emploke/__PKG__`.
 *
 * **All public DTOs, option shapes, enums, and union types MUST live in
 * this file.** Service / repository / entity / schema / compose files
 * must NOT export interfaces or type aliases that consumers will use.
 * (See architecture-design Section 11.)
 *
 * Naming convention (see Section 9):
 *   - `__Entity__` — wire-shape DTO, bare noun. Exported from index.
 *   - `__Entity__Row` — Drizzle row, internal to repository (allowed
 *     in `schema.ts` because it's the Drizzle inferred type).
 *   - `__Entity__Entity` — domain class wrapping a row, ONLY when the
 *     BC has non-trivial state transitions or invariants (e.g.
 *     `catalog.AgentEntity`, `task.TaskEntity`). Not exported.
 *     The template ships without one; add it if you need it.
 */

/** Wire-shape DTO returned by `__Entity__Service` reads. */
export interface __Entity__ {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

/** Args accepted by `__Entity__Service.create`. */
export interface Create__Entity__Args {
  readonly name: string;
}

/** Filter options accepted by `__Entity__Service.list`. */
export interface List__Entity__Opts {
  readonly nameStartsWith?: string;
}
