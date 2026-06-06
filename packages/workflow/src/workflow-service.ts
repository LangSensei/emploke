/**
 * `WorkflowService` is being rewritten for the v1.0.0 substrate (4
 * read APIs + 8 mutation primitives + kind-handler registry + engine
 * event handlers). Phase 0 ships only the data layer; the service
 * lands in Phase 1+.
 *
 * This stub exists so `compose.ts` continues to typecheck while the
 * Phase 1 work is in flight on `feat/workflow-v1`. The class throws
 * `WorkflowError` on every method invocation so test runs that try
 * to use it fail loudly. Phase 1+ replaces the body wholesale.
 *
 * See `packages/workflow/SPEC.md` §"Substrate API surface" for the
 * v1.0.0 public method set.
 */

import { WorkflowError } from "./errors.js";

const NOT_IMPLEMENTED =
  "@emploke/workflow v1.0.0 substrate is being rewritten on feat/workflow-v1; the service lands in Phase 1+.";

export class WorkflowService {
  throwNotImplemented(): never {
    throw new WorkflowError(NOT_IMPLEMENTED);
  }
}
