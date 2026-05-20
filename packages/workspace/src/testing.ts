/**
 * Test-only entry point.
 *
 * Tests need direct access to a few things that the public API
 * (`@emploke/workspace`) hides per naming-conventions §5:
 *
 *   - `MikroWorkspaceRepository` / `MikroWorkspaceQueries` so
 *     infrastructure tests can construct them against an in-memory
 *     `MikroORM` instance without going through the mediator.
 *   - `openTestWorkspaceOrm()` — opens a MikroORM `:memory:`
 *     instance, builds the schema from `WORKSPACE_ENTITIES`, and
 *     returns it. Replaces the Phase-1 `bootstrapWorkspaceRegistryDb`
 *     helper which ran the (now deleted) custom migration framework
 *     against a `DatabaseSync`.
 *   - `Workspace` aggregate + value objects so DDD-layer tests can
 *     construct + drain events on the aggregate directly.
 *
 * Example:
 *
 * ```ts
 * import { openTestWorkspaceOrm, MikroWorkspaceRepository } from "@emploke/workspace/testing";
 *
 * const orm = await openTestWorkspaceOrm();
 * const em = orm.em.fork();
 * const repo = new MikroWorkspaceRepository(em);
 * // ... run test ...
 * await orm.close(true);  // true = drop schema, release :memory: storage
 * ```
 */

import { defineConfig, type Options } from "@mikro-orm/better-sqlite";
import type { EntityManager, MikroORM } from "@mikro-orm/core";
import { WorkspaceContext } from "./infrastructure/workspace-context.js";
import { WORKSPACE_ENTITIES } from "./infrastructure/workspace-entities.js";

export { RegisterWorkspaceCommandHandler } from "./application/commands/register-workspace.command-handler.js";
export { RenameWorkspaceCommandHandler } from "./application/commands/rename-workspace.command-handler.js";
export { SetCurrentWorkspaceCommandHandler } from "./application/commands/set-current-workspace.command-handler.js";
export { UnregisterWorkspaceCommandHandler } from "./application/commands/unregister-workspace.command-handler.js";
export { MikroWorkspaceQueries } from "./application/queries/mikro-workspace-queries.js";
export { WorkspaceRegistered } from "./domain/aggregates/workspace/events/workspace-registered.js";
export { WorkspaceRenamed } from "./domain/aggregates/workspace/events/workspace-renamed.js";
export { WorkspaceUnregistered } from "./domain/aggregates/workspace/events/workspace-unregistered.js";
export { WorkspaceDir } from "./domain/aggregates/workspace/value-objects/workspace-dir.js";
export { WorkspaceId } from "./domain/aggregates/workspace/value-objects/workspace-id.js";
export { WorkspaceName } from "./domain/aggregates/workspace/value-objects/workspace-name.js";
export { Workspace } from "./domain/aggregates/workspace/workspace.js";
export { WorkspaceRepository } from "./domain/aggregates/workspace/workspace-repository.js";
export { Clock } from "./domain/clock.js";
export { AggregateRoot } from "./domain/seedwork/aggregate-root.js";
export { MikroWorkspaceRepository } from "./infrastructure/repositories/mikro-workspace-repository.js";
export { SystemClock } from "./infrastructure/system-clock.js";
export { WorkspaceContext } from "./infrastructure/workspace-context.js";
export { WORKSPACE_ENTITIES } from "./infrastructure/workspace-entities.js";

/**
 * Build a {@link WorkspaceContext} for tests around a raw EntityManager.
 * Tests that need event-dispatch coverage must register
 * `DomainEventDispatcher` onto the test ORM separately (mirror the
 * bootstrap registration). Use this helper everywhere a test
 * previously did `new MikroWorkspaceRepository(em)` or
 * `new MikroWorkspaceQueries(em)`.
 */
export function makeTestWorkspaceContext(em: EntityManager): WorkspaceContext {
  return new WorkspaceContext(em);
}

/**
 * Open an in-memory MikroORM instance suitable for tests. Builds the
 * schema from `WORKSPACE_ENTITIES` and creates the auxiliary
 * `global_state` key/value table that the workspace pkg uses outside
 * the aggregate (see `MikroWorkspaceRepository.setCurrent/getCurrent`).
 *
 * `allowGlobalContext: true` lets tests work with the root EM without
 * the explicit `RequestContext.create` boilerplate; production code
 * goes through `em.transactional` which forks the EM automatically.
 *
 * Hand-creates the `global_state` table via raw SQL because it isn't
 * a MikroORM entity in Phase 2 (it has no aggregate behaviour and is
 * on track to move out of workspace pkg per P1-5).
 */
export async function openTestWorkspaceOrm(overrides?: Partial<Options>): Promise<MikroORM> {
  const { MikroORM: MikroORMCtor } = await import("@mikro-orm/better-sqlite");
  // `defineConfig` returns the sqlite-typed Options shape, so the
  // spread of `overrides` is type-compatible. Keep `overrides` last
  // so call sites can pin extras (subscribers, logger, etc.) without
  // losing the defaults above.
  const config = defineConfig({
    entities: [...WORKSPACE_ENTITIES],
    dbName: ":memory:",
    allowGlobalContext: true,
    ...(overrides ?? {}),
  });
  const orm = await MikroORMCtor.init(config);
  await orm.schema.createSchema();
  // `global_state` lives outside the aggregate (see
  // `MikroWorkspaceRepository`); create it by hand so the repo's
  // raw-SQL setCurrent/getCurrent paths work.
  await orm.em.getConnection().execute(
    `CREATE TABLE IF NOT EXISTS global_state (
      key   TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    )`,
  );
  return orm;
}
