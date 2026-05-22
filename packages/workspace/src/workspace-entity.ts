/**
 * Domain entity for `@emploke/workspace`. Pkg-owned plain interface
 * (no methods — workspace has no domain behaviour beyond CRUD).
 *
 * Layer position:
 *   - `WorkspaceRow` (schema.ts)        — Drizzle ORM shape; private
 *   - `WorkspaceEntity` (this file)     — pkg-owned domain shape;
 *                                          what `WorkspaceRepository`
 *                                          returns. Mirrors row
 *                                          today but is contractually
 *                                          ours: swapping ORM doesn't
 *                                          touch this name.
 *   - `Workspace` (types.ts)            — wire DTO; what
 *                                          `WorkspaceService` returns.
 *                                          Normalises `lastOpenedAt`
 *                                          from nullable to required.
 *
 * Not re-exported from `index.ts`: external consumers only see the
 * `Workspace` DTO. The repository and service both live inside the
 * pkg, so they share the entity type internally.
 *
 * No class wrapper: workspace has no state machine, no invariants
 * beyond what Drizzle + zod enforce at the row boundary. An empty
 * class would be anemic-entity boilerplate. If workspace ever
 * grows domain behaviour (e.g. a `markArchived` transition), this
 * file converts to a class with that behaviour.
 */
export interface WorkspaceEntity {
  readonly id: string;
  readonly name: string;
  readonly workspaceDir: string;
  readonly createdAt: string;
  /**
   * Last open timestamp. Null when the workspace has never been
   * opened (rare — `register` sets it on creation, so most rows
   * have a value). The wire-side `Workspace` DTO normalises null
   * to `createdAt` so consumers don't see a tri-state.
   */
  readonly lastOpenedAt: string | null;
}
