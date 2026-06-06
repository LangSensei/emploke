/**
 * `composeWorkflowModule` is the production composition entrypoint
 * for `@emploke/workflow`: open the DB, run migrations, wire the
 * repository + service + kind-handler registry.
 *
 * Currently a stub that throws on call. The data layer (schema,
 * migrations, entities, errors, validate) is production-ready and
 * directly importable; callers needing the schema can open a DB via
 * `openTestWorkflowDb()` from `./testing.js` and run migrations via
 * `applyWorkflowMigrations()` from `./migrations.js`.
 */

import { WorkflowError } from "./errors.js";

export interface WorkflowModuleOptions {
  readonly dbFile?: string;
}

export interface WorkflowModule {
  close(): Promise<void>;
}

export async function composeWorkflowModule(_opts: WorkflowModuleOptions): Promise<WorkflowModule> {
  throw new WorkflowError("composeWorkflowModule is not yet implemented");
}
