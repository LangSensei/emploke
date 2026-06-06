/**
 * `composeWorkflowModule` is the production composition entrypoint
 * for `@emploke/workflow`. Phase 0 ships only the data layer (schema,
 * migrations, types, entities, errors, validate); the repository and
 * service land in Phase 1+ on the same `feat/workflow-v1` branch.
 *
 * This file is intentionally a stub that throws on call so any caller
 * importing the v0.6.0 shape fails loudly (no external pkgs import
 * it today — see PR #320 description). Phase 1 replaces the body with
 * the real composition wiring (DB open + migrations + repo + service
 * + kind-handler registry).
 *
 * The migration runner (`applyWorkflowMigrations` from
 * `./migrations.js`) IS production-ready as of Phase 0; ad-hoc
 * callers needing the schema can use `openTestWorkflowDb()` from
 * `./testing.js` directly.
 */

import { WorkflowError } from "./errors.js";

export interface WorkflowModuleOptions {
  readonly dbFile?: string;
}

export interface WorkflowModule {
  close(): Promise<void>;
}

export async function composeWorkflowModule(_opts: WorkflowModuleOptions): Promise<WorkflowModule> {
  throw new WorkflowError(
    "@emploke/workflow v1.0.0 substrate is being rewritten on feat/workflow-v1; composeWorkflowModule lands in Phase 1+.",
  );
}
