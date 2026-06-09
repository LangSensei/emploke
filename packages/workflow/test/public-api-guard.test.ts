/**
 * Compile-time public API guard for `@emploke/workflow`.
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
 */

import { describe, expectTypeOf, it } from "vitest";
import {
  type AddEdgeArgs,
  type AddNodeArgs,
  type AddSubgraphArgs,
  type AddSubgraphEdgeInput,
  type AddSubgraphInsertedNode,
  type AddSubgraphNodeInput,
  type AddSubgraphResult,
  assertValidWorkflowId,
  assertValidWorkflowNodeId,
  assertValidWorkflowNodeKind,
  assertValidWorkflowNodeStatusEnum,
  assertValidWorkflowStatusEnum,
  type CancelNodeArgs,
  composeWorkflowModule,
  deriveIterationCount,
  EmptyParentsError,
  type FinishWorkflowArgs,
  generateWorkflowId,
  generateWorkflowNodeId,
  hasLiveCoord,
  InvalidWorkflowIdError,
  InvalidWorkflowNodeIdError,
  MultipleSuccessorCoordsError,
  type NodeKind,
  type NodeRef,
  OrphanCoordInsertError,
  ParentStateError,
  type RemoveEdgeArgs,
  type RemoveNodeArgs,
  type ReplaceNodeSpecArgs,
  type WORKFLOW_NODES_SUBDIR,
  type WORKFLOW_SUBDIR,
  WorkflowAlreadyTerminalError,
  type WorkflowDagSnapshot,
  WorkflowEdgeCycleError,
  type WorkflowEdgeEntity,
  WorkflowEdgeNotFoundError,
  type WorkflowEntity,
  WorkflowEnumValueError,
  WorkflowError,
  type WorkflowModule,
  type WorkflowModuleOptions,
  type WorkflowNodeEntity,
  WorkflowNodeKindShapeError,
  WorkflowNodeKindUnknownError,
  WorkflowNodeNotFoundError,
  WorkflowNodeNotMutableError,
  type WorkflowNodeRunner,
  type WorkflowNodeSpecEnvelope,
  WorkflowNodeSpecError,
  type WorkflowNodeStatus,
  type WorkflowNodeTerminalResult,
  type WorkflowNodeValidateCtx,
  WorkflowNotFoundError,
  WorkflowRemoveEdgeOrphansChildError,
  WorkflowRemoveNodeOrphansChildError,
  type WorkflowRunners,
  type WorkflowService,
  type WorkflowStatus,
  WorkflowSubgraphCyclicError,
  WorkflowSubgraphEmptyError,
  WorkflowSubgraphMultipleCoordTempsError,
  WorkflowSubgraphNodeRefUnresolvedError,
  WorkflowSubgraphTempIdInvalidError,
  WorkflowSubgraphTempParentlessError,
  workflowDir,
  workflowNodeDir,
  workflowRoot,
} from "../src/index.js";

describe("@emploke/workflow public API guard", () => {
  it("exports the concrete error classes with their canonical constructor signatures", () => {
    const errs: Error[] = [
      new WorkflowError("boom"),
      new WorkflowError("boom", { cause: new Error("upstream") }),
      new WorkflowNotFoundError("wf-id"),
      new WorkflowNodeNotFoundError("wf-id", "node-id"),
      new InvalidWorkflowIdError("bad"),
      new InvalidWorkflowNodeIdError("bad"),
      new WorkflowAlreadyTerminalError("wf-id"),
      new WorkflowNodeNotMutableError("wf-id", "node-id", "running", "removeNode"),
      new WorkflowEdgeCycleError("wf-id", "node-a", "node-b"),
      // Defensive guard — fires only when a persisted row carries a
      // kind value outside `NodeKind`, signalling schema corruption
      // or a row written by an older binary. Unreachable through
      // typed callers because `runnerFor` accepts `NodeKind`.
      new WorkflowNodeKindUnknownError("evaluator"),
      new WorkflowNodeKindShapeError(""),
      new WorkflowNodeSpecError("worker", "agent missing"),
      new MultipleSuccessorCoordsError("wf-id", "coord-parent-id"),
      new OrphanCoordInsertError("wf-id"),
      new ParentStateError("wf-id", "worker", "parent-id", "failed"),
      // Zero-arg now: structural precondition (≥1 parent) is workflow-
      // independent, so the error doesn't take an id.
      new EmptyParentsError(),
      new WorkflowEnumValueError("status", "archived", ["running", "succeeded"]),
    ];
    expectTypeOf(errs[0]!).toExtend<Error>();
  });

  it("preserves the FSM enum vocabularies", () => {
    // Four-value workflow status: one non-terminal (`running`) and
    // three terminals. The "actively coordinating right now" view is
    // intentionally derived, not persisted.
    expectTypeOf<WorkflowStatus>().toEqualTypeOf<
      "running" | "succeeded" | "failed" | "cancelled"
    >();
    // Six-value node status; applies to both worker-kind and
    // coordinator-kind nodes.
    expectTypeOf<WorkflowNodeStatus>().toEqualTypeOf<
      "not_started" | "ready" | "running" | "succeeded" | "failed" | "cancelled"
    >();
  });

  it("locks the closed NodeKind enum to {'coordinator', 'worker'}", () => {
    // Closed-enum substrate: adding a new kind requires updating
    // `NodeKind`, adding a `WorkflowRunners` field, and the exhaustive
    // `switch (kind)` branches inside the service. This assertion
    // fails on every kind addition/removal — that's the point.
    expectTypeOf<NodeKind>().toEqualTypeOf<"coordinator" | "worker">();
  });

  it("preserves the substrate envelope + runner interface", () => {
    // The envelope's `kind` is the closed-enum type so any downstream
    // pattern-match on it is exhaustive.
    expectTypeOf<WorkflowNodeSpecEnvelope>().toHaveProperty("kind");
    expectTypeOf<WorkflowNodeSpecEnvelope>().toHaveProperty("spec");

    expectTypeOf<WorkflowNodeRunner>().toHaveProperty("validate");
    expectTypeOf<WorkflowNodeRunner>().toHaveProperty("dispatch");
    expectTypeOf<WorkflowNodeRunner>().toHaveProperty("hasInFlightForNode");
    expectTypeOf<WorkflowNodeRunner>().toHaveProperty("cancel");

    expectTypeOf<WorkflowNodeValidateCtx>().toHaveProperty("workflowId");
    expectTypeOf<WorkflowNodeValidateCtx>().toHaveProperty("workflowStatus");
  });

  it("M1 (#325 D1): exposes WorkflowNodeTerminalResult discriminated union", () => {
    // The terminal-result type is the runner's push-back shape. Three
    // arms (succeeded / failed / cancelled). Failed requires a string
    // reason; the others do not. `output` is opaque on succeeded /
    // failed; cancelled has no output. Locking the exact shape here
    // means a downstream pkg's exhaustive pattern-match stays
    // exhaustive even after refactors.
    expectTypeOf<WorkflowNodeTerminalResult>().toEqualTypeOf<
      | { readonly status: "succeeded"; readonly output?: unknown }
      | { readonly status: "failed"; readonly reason: string; readonly output?: unknown }
      | { readonly status: "cancelled"; readonly reason: string }
    >();
  });

  it("M1 (#325 D1): dispatch opts include the additive onTerminal callback", () => {
    // The ONLY interface change at this layer is the new
    // `onTerminal` field inside `dispatch`'s opts parameter. Lock
    // the parameter shape here so a future refactor renaming or
    // removing the callback is a compile-time failure rather than
    // a silent breakage of the engine ↔ runner contract.
    type DispatchParam = Parameters<WorkflowNodeRunner["dispatch"]>[0];
    expectTypeOf<DispatchParam>().toHaveProperty("workflowId");
    expectTypeOf<DispatchParam>().toHaveProperty("nodeId");
    expectTypeOf<DispatchParam>().toHaveProperty("spec");
    expectTypeOf<DispatchParam>().toHaveProperty("nodeDir");
    expectTypeOf<DispatchParam>().toHaveProperty("onTerminal");
    expectTypeOf<DispatchParam["onTerminal"]>().toEqualTypeOf<
      (result: WorkflowNodeTerminalResult) => void
    >();
  });

  it("requires a runner per NodeKind via WorkflowRunners", () => {
    // Both fields non-optional: `composeWorkflowModule({ runners: {
    // coordinator } })` is a TypeScript compile error, not a runtime
    // throw. This is the static replacement for the deleted runtime
    // `service.registerKind(...)` / `service.recover()` registry.
    expectTypeOf<WorkflowRunners>().toHaveProperty("coordinator");
    expectTypeOf<WorkflowRunners>().toHaveProperty("worker");
    expectTypeOf<WorkflowRunners["coordinator"]>().toEqualTypeOf<WorkflowNodeRunner>();
    expectTypeOf<WorkflowRunners["worker"]>().toEqualTypeOf<WorkflowNodeRunner>();
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

  it("preserves the composition surface", () => {
    expectTypeOf(composeWorkflowModule).parameters.toEqualTypeOf<[WorkflowModuleOptions]>();
    expectTypeOf(composeWorkflowModule).returns.resolves.toEqualTypeOf<WorkflowModule>();
    expectTypeOf<WorkflowModule>().toHaveProperty("service");
    expectTypeOf<WorkflowModule>().toHaveProperty("close");
    // `runners` is part of the composition surface — every caller
    // must supply both arms of `WorkflowRunners`.
    expectTypeOf<WorkflowModuleOptions>().toHaveProperty("runners");
  });

  it("M1 (#325 D5): WorkflowModule exposes the engine alongside service + close", () => {
    // The engine field is the structural seam composition callers
    // use to drive `start()` (currently a no-op) and `stop()`
    // (drains in-flight per-workflow tick chains). The type is left
    // opaque-ish (no static reference to the class) — downstream
    // consumers should not import the engine directly; they
    // interact through the module.
    expectTypeOf<WorkflowModule>().toHaveProperty("engine");
  });

  it("preserves the service class", () => {
    expectTypeOf<WorkflowService>().toHaveProperty("getWorkflow");
    expectTypeOf<WorkflowService>().toHaveProperty("getDag");
    expectTypeOf<WorkflowService>().toHaveProperty("getNode");
    expectTypeOf<WorkflowService>().toHaveProperty("getNodeDir");
    expectTypeOf<WorkflowService>().toHaveProperty("createWorkflow");
    expectTypeOf<WorkflowService>().toHaveProperty("addNode");
    expectTypeOf<WorkflowService>().toHaveProperty("addEdge");
    expectTypeOf<WorkflowService>().toHaveProperty("cancelNode");
    expectTypeOf<WorkflowService>().toHaveProperty("finishWorkflow");
    expectTypeOf<WorkflowService>().toHaveProperty("cancelWorkflow");
    expectTypeOf<WorkflowService>().toHaveProperty("dispatchAtomic");
    // Phase 2b structural mutation primitives.
    expectTypeOf<WorkflowService>().toHaveProperty("removeNode");
    expectTypeOf<WorkflowService>().toHaveProperty("removeEdge");
    expectTypeOf<WorkflowService>().toHaveProperty("replaceNodeSpec");
    expectTypeOf<WorkflowService>().toHaveProperty("addSubgraph");
    // Engine-facing terminal writer + engine wire-up.
    expectTypeOf<WorkflowService>().toHaveProperty("markNodeTerminal");
    expectTypeOf<WorkflowService>().toHaveProperty("setEngine");
    expectTypeOf<WorkflowDagSnapshot>().toHaveProperty("workflow");
    expectTypeOf<WorkflowDagSnapshot>().toHaveProperty("nodes");
    expectTypeOf<WorkflowDagSnapshot>().toHaveProperty("edges");
  });

  it("R4: the four mutation Args carry `workflowId` (NOT `callerCoordNodeId`)", () => {
    // R4 derivation: the substrate determines the calling coord from
    // `workflowId` (the unique running coord per workflow, invariant
    // #2). The leaked-id field `callerCoordNodeId` is removed from
    // these Args; only the structural `workflowId` remains. Adding
    // it back here is a compile-time error — this guard ensures it
    // never silently re-appears.
    expectTypeOf<AddNodeArgs>().toHaveProperty("workflowId");
    expectTypeOf<AddEdgeArgs>().toHaveProperty("workflowId");
    expectTypeOf<CancelNodeArgs>().toHaveProperty("workflowId");
    expectTypeOf<FinishWorkflowArgs>().toHaveProperty("workflowId");
    expectTypeOf<AddNodeArgs["workflowId"]>().toBeString();
    expectTypeOf<AddEdgeArgs["workflowId"]>().toBeString();
    expectTypeOf<CancelNodeArgs["workflowId"]>().toBeString();
    expectTypeOf<FinishWorkflowArgs["workflowId"]>().toBeString();
    // Defence-in-depth: `callerCoordNodeId` must NOT be exposed on
    // any of the four mutation Args. `not.toHaveProperty` is the
    // type-level assertion that fails if a future refactor leaks
    // the derived id back into the public surface.
    expectTypeOf<AddNodeArgs>().not.toHaveProperty("callerCoordNodeId");
    expectTypeOf<AddEdgeArgs>().not.toHaveProperty("callerCoordNodeId");
    expectTypeOf<CancelNodeArgs>().not.toHaveProperty("callerCoordNodeId");
    expectTypeOf<FinishWorkflowArgs>().not.toHaveProperty("callerCoordNodeId");
  });

  it("R4 (Phase 2b): the structural mutation Args carry `workflowId` only", () => {
    // Same R4 contract for the four Phase 2b mutation Args. Repeats
    // the assertion so the failure message points at the new
    // primitives if a future refactor leaks `callerCoordNodeId`.
    expectTypeOf<RemoveNodeArgs>().toHaveProperty("workflowId");
    expectTypeOf<RemoveEdgeArgs>().toHaveProperty("workflowId");
    expectTypeOf<ReplaceNodeSpecArgs>().toHaveProperty("workflowId");
    expectTypeOf<AddSubgraphArgs>().toHaveProperty("workflowId");
    expectTypeOf<RemoveNodeArgs["workflowId"]>().toBeString();
    expectTypeOf<RemoveEdgeArgs["workflowId"]>().toBeString();
    expectTypeOf<ReplaceNodeSpecArgs["workflowId"]>().toBeString();
    expectTypeOf<AddSubgraphArgs["workflowId"]>().toBeString();
    expectTypeOf<RemoveNodeArgs>().not.toHaveProperty("callerCoordNodeId");
    expectTypeOf<RemoveEdgeArgs>().not.toHaveProperty("callerCoordNodeId");
    expectTypeOf<ReplaceNodeSpecArgs>().not.toHaveProperty("callerCoordNodeId");
    expectTypeOf<AddSubgraphArgs>().not.toHaveProperty("callerCoordNodeId");
  });

  it("Phase 2b Args carry the per-method structural fields", () => {
    expectTypeOf<RemoveNodeArgs>().toHaveProperty("nodeId");
    expectTypeOf<RemoveNodeArgs["nodeId"]>().toBeString();
    expectTypeOf<RemoveEdgeArgs>().toHaveProperty("fromNodeId");
    expectTypeOf<RemoveEdgeArgs>().toHaveProperty("toNodeId");
    expectTypeOf<RemoveEdgeArgs["fromNodeId"]>().toBeString();
    expectTypeOf<RemoveEdgeArgs["toNodeId"]>().toBeString();
    expectTypeOf<ReplaceNodeSpecArgs>().toHaveProperty("nodeId");
    expectTypeOf<ReplaceNodeSpecArgs>().toHaveProperty("newSpec");
    expectTypeOf<ReplaceNodeSpecArgs>().not.toHaveProperty("newKind");
    expectTypeOf<AddSubgraphArgs>().toHaveProperty("nodes");
    expectTypeOf<AddSubgraphArgs>().toHaveProperty("edges");
  });

  it("NodeRef is a discriminated union over the existing | temp tag", () => {
    // The substrate accepts either a real persisted node id or a
    // batch-local tempId; the discriminator `kind` MUST stay narrow
    // so consumers can switch exhaustively.
    expectTypeOf<NodeRef>().toEqualTypeOf<
      | { readonly kind: "existing"; readonly id: string }
      | { readonly kind: "temp"; readonly tempId: string }
    >();
  });

  it("AddSubgraph node + edge + result shapes pin the public contract", () => {
    expectTypeOf<AddSubgraphNodeInput>().toHaveProperty("tempId");
    expectTypeOf<AddSubgraphNodeInput>().toHaveProperty("kind");
    expectTypeOf<AddSubgraphNodeInput>().toHaveProperty("spec");
    expectTypeOf<AddSubgraphNodeInput["tempId"]>().toBeString();
    expectTypeOf<AddSubgraphNodeInput["kind"]>().toEqualTypeOf<NodeKind>();

    expectTypeOf<AddSubgraphEdgeInput>().toHaveProperty("from");
    expectTypeOf<AddSubgraphEdgeInput>().toHaveProperty("to");
    expectTypeOf<AddSubgraphEdgeInput["from"]>().toEqualTypeOf<NodeRef>();
    expectTypeOf<AddSubgraphEdgeInput["to"]>().toEqualTypeOf<NodeRef>();

    expectTypeOf<AddSubgraphResult>().toHaveProperty("insertedNodes");
    expectTypeOf<AddSubgraphInsertedNode>().toHaveProperty("tempId");
    expectTypeOf<AddSubgraphInsertedNode>().toHaveProperty("nodeId");
    expectTypeOf<AddSubgraphInsertedNode>().toHaveProperty("phase");
    expectTypeOf<AddSubgraphInsertedNode["phase"]>().toBeNumber();
  });

  it("exports the Phase 2b error classes with their canonical constructor signatures", () => {
    const errs: Error[] = [
      new WorkflowEdgeNotFoundError("wf-id", "from-id", "to-id"),
      new WorkflowRemoveNodeOrphansChildError("wf-id", "node-id", "child-id"),
      new WorkflowRemoveEdgeOrphansChildError("wf-id", "from-id", "to-id"),
      new WorkflowSubgraphEmptyError(),
      new WorkflowSubgraphTempIdInvalidError("duplicate tempId"),
      new WorkflowSubgraphTempParentlessError("tempId-x"),
      new WorkflowSubgraphNodeRefUnresolvedError("wf-id", "temp", "missing"),
      new WorkflowSubgraphCyclicError("wf-id", "from", "to"),
      new WorkflowSubgraphMultipleCoordTempsError("wf-id"),
    ];
    expectTypeOf(errs[0]!).toExtend<Error>();
  });
});
