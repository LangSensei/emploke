import { Workspace } from "../domain/aggregates/workspace/workspace.js";

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
 *     `last_opened_at` collapses what used to be a separate
 *     `global_state.current_workspace_id` cross-row pointer onto a
 *     per-aggregate fact: the workspace with the highest
 *     `last_opened_at` is the registry's "current" one (MRU).
 */
export const WORKSPACE_ENTITIES = [Workspace] as const;
