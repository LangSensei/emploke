import { Workspace } from "../domain/aggregates/workspace/workspace.js";

/**
 * Entities owned by `@emploke/workspace`. The composition root passes
 * this array to `MikroORM.init({ entities: WORKSPACE_ENTITIES, ... })`
 * so we don't leak the internal entity list across the package
 * boundary (and so a future Phase that adds an entity here doesn't
 * require updating every composition root in lock-step).
 *
 * Today: just `Workspace` (the only aggregate root in this package).
 * Phase 3+ may add `GlobalState` once the key/value bag earns enough
 * behaviour to merit its own entity, but for now `global_state` is
 * a raw-SQL table accessed via `em.execute(...)` from
 * `MikroWorkspaceRepository.setCurrent/getCurrent`.
 */
export const WORKSPACE_ENTITIES = [Workspace] as const;
