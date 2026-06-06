/**
 * `WorkflowService` is the substrate's public API: read APIs
 * (`getWorkflow` / `getDag` / `getNode` / `getNodeDir`), mutation
 * primitives (`addNode` / `addEdge` / `addSubgraph` / `removeNode` /
 * `removeEdge` / `replaceNodeSpec` / `cancelNode` /
 * `dispatchAtomic`), kind-handler registry, and engine event
 * handlers. Currently a stub — the data layer (schema, entities,
 * validate, errors) is in place but the service methods are not yet
 * wired up.
 *
 * This stub exists so `compose.ts` continues to typecheck. Every
 * method throws `WorkflowError` so a test or caller that tries to
 * use it fails loudly instead of silently working against a no-op.
 */

import { WorkflowError } from "./errors.js";

const NOT_IMPLEMENTED = "WorkflowService is not yet implemented";

export class WorkflowService {
  throwNotImplemented(): never {
    throw new WorkflowError(NOT_IMPLEMENTED);
  }
}
