/**
 * Test-only entry point.
 *
 * Tests need direct access to a few things the main public API hides:
 *
 *   - The `Workspace` MikroORM entity, so unit tests can persist /
 *     hydrate rows without going through the service.
 *   - `WorkspaceRepository` — same reason.
 *   - `openTestWorkspaceOrm()` — opens an in-memory MikroORM instance
 *     with the pkg's entity list pre-registered.
 *
 * Example:
 *
 * ```ts
 * import { openTestWorkspaceOrm, WorkspaceRepository } from "@emploke/workspace/testing";
 *
 * const orm = await openTestWorkspaceOrm();
 * const em = orm.em.fork();
 * const repo = new WorkspaceRepository(em);
 * // ... run test ...
 * await orm.close(true);
 * ```
 */

import { defineConfig, type Options } from "@mikro-orm/better-sqlite";
import type { MikroORM } from "@mikro-orm/core";
import { WORKSPACE_ENTITIES } from "./entity.js";

export { Workspace, WORKSPACE_ENTITIES } from "./entity.js";
export { WorkspaceQueries } from "./queries.js";
export { WorkspaceRepository } from "./repository.js";
export { WorkspaceService } from "./service.js";
export {
  assertValidWorkspaceId,
  assertValidWorkspaceName,
  isValidWorkspaceId,
  isValidWorkspaceName,
  normalizeWorkspaceDir,
} from "./validators.js";

/**
 * Open an in-memory MikroORM instance for tests. Builds the full
 * schema from the pkg's entity list, so tests don't hand-create any
 * tables.
 */
export async function openTestWorkspaceOrm(overrides?: Partial<Options>): Promise<MikroORM> {
  const { MikroORM: MikroORMCtor } = await import("@mikro-orm/better-sqlite");
  const config = defineConfig({
    entities: [...WORKSPACE_ENTITIES],
    dbName: ":memory:",
    allowGlobalContext: true,
    ...(overrides ?? {}),
  });
  const orm = await MikroORMCtor.init(config);
  await orm.schema.createSchema();
  return orm;
}
