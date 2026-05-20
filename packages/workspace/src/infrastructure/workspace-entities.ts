import { Workspace } from "../domain/aggregates/workspace/workspace.js";
import { GlobalState } from "../domain/global-state.js";

/**
 * Entities owned by `@emploke/workspace`. Internal to the package —
 * `composeWorkspaceModule` (real) and `openTestWorkspaceOrm` (test
 * helper) both pass this array to `MikroORM.init({ entities, ... })`
 * so the two ORM setups can't drift apart.
 *
 * NOT part of the package's public surface: composition roots (server
 * / CLI) call `composeWorkspaceModule` and never see the entity list.
 *
 *   - `Workspace` — the aggregate root for a registered workspace.
 *   - `GlobalState` — a singleton key/value bag holding the
 *     `current_workspace_id` pointer. Plain entity (no aggregate
 *     behaviour); accessed via the EntityManager so the per-context
 *     unit-of-work + transaction envelope cover it.
 */
export const WORKSPACE_ENTITIES = [Workspace, GlobalState] as const;
