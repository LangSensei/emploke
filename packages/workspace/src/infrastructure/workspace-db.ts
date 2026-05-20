import type { DatabaseSync } from "node:sqlite";

/**
 * Inversify DI token for the workspace pkg's SQLite database handle.
 *
 * **Despite the name**, this binds the *workspace registry* DB —
 * `<EMPLOKE_HOME>/global.db` in production. The name `WorkspaceDb`
 * tracks the package's own DB (the workspace pkg's storage seam), not
 * the per-workspace `<workspaceDir>/workspace.db` (that file is owned
 * by session / task / catalog and gets its own token in a future
 * phase). Naming follows brief §9 of the Phase 1 dispatch.
 *
 * Symbol-keyed because the bound value is a 3rd-party class
 * (`DatabaseSync`) we cannot decorate with `@injectable`. Per
 * inversify v7's typed-symbol pattern, the merged-namespace type alias
 * below lets `@inject(WorkspaceDb)` and `WorkspaceDb` (the type)
 * share one name.
 */
export const WorkspaceDb = Symbol.for("@emploke/workspace/WorkspaceDb");
// eslint-disable-next-line @typescript-eslint/no-redeclare -- intentional symbol-as-type merge
export type WorkspaceDb = DatabaseSync;
