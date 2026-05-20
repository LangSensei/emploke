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
 *     The `last_opened_at` column carries a per-aggregate MRU fact:
 *     the workspace with the highest `last_opened_at` is the
 *     registry's "current" one.
 */
export const WORKSPACE_ENTITIES = [Workspace] as const;
