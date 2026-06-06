/**
 * `WorkflowRepository` owns the SQL for the workflow substrate:
 * mutation primitives, kind-aware engine event handlers, and the
 * denorm sync for `workflows.coordinator_agent`. Currently a stub —
 * the data layer (schema, entities, validate, errors) is in place
 * but the SQL methods are not yet wired up.
 *
 * This stub exists so `compose.ts` continues to typecheck. Every
 * method throws `WorkflowError` so a test or caller that tries to
 * use it fails loudly instead of silently working against a no-op.
 */

import { WorkflowError } from "./errors.js";

const NOT_IMPLEMENTED = "WorkflowRepository is not yet implemented";

export class WorkflowRepository {
  throwNotImplemented(): never {
    throw new WorkflowError(NOT_IMPLEMENTED);
  }
}
