/**
 * Compile-time public API guard for `@emploke/workflow` (v1.0.0).
 *
 * WHAT this file does:
 *   Uses Vitest's `expectTypeOf<T>()` to lock the pkg's public surface
 *   at the TYPE level. Every exported error class, every exported
 *   type, every path helper / validator, and every entity class gets
 *   an assertion.
 *
 * WHY it is valuable:
 *   Silent renames (`addNode` → `appendNode`), accidental method
 *   removals, DTO-field drift, and dropping an enum arm all break
 *   downstream pkgs at compile time — but only the downstream pkg's
 *   typecheck sees the failure. This guard pulls the failure forward:
 *   `pnpm --filter @emploke/workflow typecheck` fails the moment the
 *   public surface drifts, BEFORE the downstream consumer notices.
 *
 * WHEN it runs:
 *   - At `pnpm typecheck` time: every `expectTypeOf` assertion is
 *     evaluated by tsc — that is where the real check happens.
 *   - At `pnpm test` time: the file loads and the `describe(...)` /
 *     `it(...)` bodies execute, but `expectTypeOf` is a no-op at
 *     runtime.
 *
 * Phase 0 locks the data-layer surface only; Phase 1+ will extend
 * this with `WorkflowService` method assertions as the mutation
 * primitives ship.
 */

import { describe, expectTypeOf, it } from "vitest";
import {
  assertValidWorkflowId,
  assertValidWorkflowNodeId,
  assertValidWorkflowNodeKind,
  assertValidWorkflowNodeStatusEnum,
  assertValidWorkflowStatusEnum,
  composeWorkflowModule,
  deriveIterationCount,
  generateWorkflowId,
  generateWorkflowNodeId,
  hasLiveCoord,
  InvalidWorkflowIdError,
  InvalidWorkflowNodeIdError,
  MultipleSuccessorCoordsError,
  OrphanCoordInsertError,
  ParentlessTempError,
  ParentStateError,
  UnknownTempIdError,
  type WORKFLOW_NODES_SUBDIR,
  type WORKFLOW_SUBDIR,
  WorkflowAlreadyTerminalError,
  type WorkflowCoordinatorNodeSpec,
  type WorkflowCoordinatorNodeSpecWire,
  WorkflowEdgeAlreadyExistsError,
  WorkflowEdgeCycleError,
  type WorkflowEdgeEntity,
  WorkflowEdgeNotFoundError,
  type WorkflowEntity,
  WorkflowEnumValueError,
  WorkflowError,
  type WorkflowModule,
  type WorkflowModuleOptions,
  WorkflowMutationUnauthorizedError,
  type WorkflowNodeEntity,
  type WorkflowNodeKindHandler,
  WorkflowNodeKindUnknownError,
  WorkflowNodeNotFoundError,
  WorkflowNodeNotMutableError,
  type WorkflowNodeSpecEnvelope,
  WorkflowNodeSpecError,
  type WorkflowNodeStatus,
  type WorkflowNodeValidateCtx,
  type WorkflowNodeWireSpec,
  WorkflowNotFoundError,
  type WorkflowStatus,
  type WorkflowTaskNodeSpec,
  type WorkflowTaskNodeSpecWire,
  WouldOrphanChildError,
  workflowDir,
  workflowNodeDir,
  workflowRoot,
} from "../src/index.js";

describe("@emploke/workflow public API guard (v1.0.0)", () => {
  it("exports the concrete error classes with their canonical constructor signatures", () => {
    const errs: Error[] = [
      new WorkflowError("boom"),
      new WorkflowError("boom", { cause: new Error("upstream") }),
      new WorkflowNotFoundError("wf-id"),
      new WorkflowNodeNotFoundError("wf-id", "node-id"),
      new WorkflowEdgeNotFoundError("wf-id", "node-a", "node-b"),
      new InvalidWorkflowIdError("bad"),
      new InvalidWorkflowNodeIdError("bad"),
      new WorkflowAlreadyTerminalError("wf-id"),
      new WorkflowMutationUnauthorizedError("wf-id", "caller-id", "not coord"),
      new WorkflowNodeNotMutableError("wf-id", "node-id", "running", "removeNode"),
      new WorkflowEdgeCycleError("wf-id", "node-a", "node-b"),
      new WorkflowEdgeAlreadyExistsError("wf-id", "node-a", "node-b"),
      new WouldOrphanChildError("wf-id", "node-id", "child-id"),
      new WorkflowNodeKindUnknownError("evaluator"),
      new WorkflowNodeSpecError("task", "agent missing"),
      new MultipleSuccessorCoordsError("wf-id", "caller-id"),
      new OrphanCoordInsertError("wf-id", "caller-id"),
      new ParentStateError("wf-id", "task", "parent-id", "failed"),
      new ParentlessTempError("wf-id", "temp-1"),
      new UnknownTempIdError("wf-id", "temp-1"),
      new WorkflowEnumValueError("status", "archived", ["running", "succeeded"]),
    ];
    expectTypeOf(errs[0]!).toExtend<Error>();
  });

  it("preserves the v1 FSM enum vocabularies", () => {
    // 4-value workflow status (D1, D26).
    expectTypeOf<WorkflowStatus>().toEqualTypeOf<
      "running" | "succeeded" | "failed" | "cancelled"
    >();
    // 6-value node status (unchanged from v0.6.0; D2).
    expectTypeOf<WorkflowNodeStatus>().toEqualTypeOf<
      "not_started" | "ready" | "running" | "succeeded" | "failed" | "cancelled"
    >();
  });

  it("preserves the substrate envelope + handler interface (D12 / D18)", () => {
    expectTypeOf<WorkflowNodeSpecEnvelope>().toHaveProperty("kind");
    expectTypeOf<WorkflowNodeSpecEnvelope>().toHaveProperty("spec");

    expectTypeOf<WorkflowNodeKindHandler>().toHaveProperty("validate");
    expectTypeOf<WorkflowNodeKindHandler>().toHaveProperty("dispatch");
    expectTypeOf<WorkflowNodeKindHandler>().toHaveProperty("hasInFlightForNode");
    expectTypeOf<WorkflowNodeKindHandler>().toHaveProperty("cancel");

    expectTypeOf<WorkflowNodeValidateCtx>().toHaveProperty("workflowId");
    expectTypeOf<WorkflowNodeValidateCtx>().toHaveProperty("callerCoordNodeId");
    expectTypeOf<WorkflowNodeValidateCtx>().toHaveProperty("callerCoordSpec");
    expectTypeOf<WorkflowNodeValidateCtx>().toHaveProperty("workflowStatus");
  });

  it("preserves the v1 wire spec DTOs re-exported from @emploke/contracts", () => {
    expectTypeOf<WorkflowTaskNodeSpec>().toHaveProperty("agent");
    expectTypeOf<WorkflowTaskNodeSpec>().toHaveProperty("brief");
    expectTypeOf<WorkflowCoordinatorNodeSpec>().toHaveProperty("agent");

    // Flat discriminated-union wire projections.
    expectTypeOf<WorkflowTaskNodeSpecWire>().toExtend<{ readonly kind: "task" }>();
    expectTypeOf<WorkflowCoordinatorNodeSpecWire>().toExtend<{
      readonly kind: "coordinator";
    }>();

    // The catch-all preserves the forward-compat slot.
    expectTypeOf<WorkflowNodeWireSpec>().toExtend<{ readonly kind: string }>();
  });

  it("preserves derived-view helpers (hasLiveCoord, deriveIterationCount)", () => {
    expectTypeOf(hasLiveCoord).toBeFunction();
    expectTypeOf(hasLiveCoord).returns.toBeBoolean();
    expectTypeOf(deriveIterationCount).toBeFunction();
    expectTypeOf(deriveIterationCount).returns.toBeNumber();
  });

  it("preserves the validators + id generators", () => {
    expectTypeOf(assertValidWorkflowId).toBeFunction();
    expectTypeOf(assertValidWorkflowNodeId).toBeFunction();
    expectTypeOf(assertValidWorkflowStatusEnum).toBeFunction();
    expectTypeOf(assertValidWorkflowNodeStatusEnum).toBeFunction();
    expectTypeOf(assertValidWorkflowNodeKind).toBeFunction();
    expectTypeOf(generateWorkflowId).toBeFunction();
    expectTypeOf(generateWorkflowNodeId).toBeFunction();
    expectTypeOf(generateWorkflowId).returns.toBeString();
    expectTypeOf(generateWorkflowNodeId).returns.toBeString();
  });

  it("preserves the exported path helpers + subdir constants", () => {
    expectTypeOf(workflowDir).toBeFunction();
    expectTypeOf(workflowNodeDir).toBeFunction();
    expectTypeOf(workflowRoot).toBeFunction();
    // String-literal subtypes; assert assignability to `string` rather
    // than exact equality so renaming the literal value remains an
    // internal change while the public type stays string-shaped.
    expectTypeOf<typeof WORKFLOW_SUBDIR>().toExtend<string>();
    expectTypeOf<typeof WORKFLOW_NODES_SUBDIR>().toExtend<string>();
  });

  it("preserves the entity classes with fromRow / toRow round-trip", () => {
    expectTypeOf<typeof WorkflowEntity>().toHaveProperty("fromRow");
    expectTypeOf<WorkflowEntity>().toHaveProperty("toRow");
    expectTypeOf<typeof WorkflowNodeEntity>().toHaveProperty("fromRow");
    expectTypeOf<WorkflowNodeEntity>().toHaveProperty("toRow");
    expectTypeOf<WorkflowNodeEntity>().toHaveProperty("toEnvelope");
    expectTypeOf<typeof WorkflowEdgeEntity>().toHaveProperty("fromRow");
    expectTypeOf<WorkflowEdgeEntity>().toHaveProperty("toRow");
  });

  it("preserves the composition surface (Phase 1+ wires up the real impl)", () => {
    expectTypeOf(composeWorkflowModule).parameters.toEqualTypeOf<[WorkflowModuleOptions]>();
    expectTypeOf(composeWorkflowModule).returns.resolves.toEqualTypeOf<WorkflowModule>();
    expectTypeOf<WorkflowModule>().toHaveProperty("close");
  });
});
