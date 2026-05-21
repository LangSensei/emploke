/**
 * @emploke/workspace — workspace registry on MikroORM.
 *
 * A *workspace* is the user-chosen working directory that holds
 * emploke's per-workspace state (per-workspace SQLite DB at
 * `<workspaceDir>/workspace.db`, plus agent workdirs under `sessions/`
 * and `tasks/`). Each workspace is identified by an opaque UUID `id`
 * (the URL routing key) and lives at an absolute filesystem
 * `workspaceDir`. Its user-facing display name and other metadata
 * live in the global registry row (`global.db`), not in the workspace
 * folder.
 *
 * ## Public surface
 *
 *   - `composeWorkspaceModule(options)` — bootstrap. Returns a
 *     `{ service, queries, close }` triple. Callers wire `service`
 *     and `queries` into their own composition root.
 *   - `WorkspaceService` — the four use cases
 *     (`register / open / rename / unregister`).
 *   - `WorkspaceQueries` — read projections (`getById`, `list`,
 *     `getLastOpened`, `getLastOpenedId`).
 *   - Typed errors (`WorkspaceError` + subclasses) for callers that
 *     catch by type.
 *   - `workspaceLayout(workspaceDir)` — pure helper for downstream
 *     packages (`task`, `session`, `catalog`) computing their
 *     per-entity workdirs.
 *
 * Everything else (the `Workspace` MikroORM entity, the repository,
 * the validators) is package-private. Tests that need the entity
 * directly import from `@emploke/workspace/testing`.
 *
 * ## Legacy migration framework
 *
 * The `MigrationCoordinator` + `runPkgMigrations` re-exports below
 * come from `./legacy/migration/` and exist solely so session / task
 * / catalog can keep evolving their per-workspace SQLite schemas.
 * They will go away once those packages also pivot off the
 * hand-rolled framework. New code in this pkg must not depend on
 * them.
 */

export {
  composeWorkspaceModule,
  type WorkspaceModule,
  type WorkspaceModuleOptions,
} from "./compose.js";
export {
  RegistryCorruptedError,
  RegistryError,
  RegistryNotBootstrappedError,
  RegistrySchemaMismatchError,
  WorkspaceAlreadyExistsError,
  WorkspaceCorruptedError,
  WorkspaceError,
  WorkspaceIdConflictError,
  WorkspaceIdInvalidError,
  WorkspaceNameInvalidError,
  WorkspaceNotFoundError,
  WorkspaceNotRegisteredError,
  WorkspacePathConflictError,
} from "./errors.js";
export { type WorkspaceLayout, workspaceLayout } from "./layout.js";
export {
  WorkspaceQueries,
  type WorkspaceSummaryView,
  type WorkspaceView,
} from "./queries.js";
export { WorkspaceService } from "./service.js";
export { InputValidationError } from "./validators.js";

// ── Legacy migration framework — see src/legacy/README.md ─────
export type { Migration, MigrationRunResult } from "./legacy/migration/index.js";
export {
  MigrationCoordinator,
  MigrationCycleError,
  MigrationDependencyMissingError,
  MigrationError,
  MigrationFailedError,
  MigrationRegisterError,
  MigrationVersionAheadError,
  runPkgMigrations,
  SchemaMetaMismatchError,
  SchemaMetaNotBootstrappedError,
  topoSort,
} from "./legacy/migration/index.js";
