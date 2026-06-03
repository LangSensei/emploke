/**
 * Compile-time public API guard for `@emploke/workflow`.
 *
 * WHAT this file does:
 *   Uses Vitest's `expectTypeOf<T>()` to lock the pkg's public surface
 *   at the TYPE level. Every public method on the service class, every
 *   exported error class, every exported DTO / option shape, and every
 *   exported path helper / constant gets a `expectTypeOf(...)`
 *   assertion below.
 *
 * WHY it is valuable:
 *   Silent renames (`launchNode` → `runNode`), accidental method
 *   removals, DTO-field drift, and dropping a node-lifecycle status arm
 *   all break downstream pkgs at compile time — but only the
 *   downstream pkg's typecheck sees the failure, which means breakage
 *   surfaces in a sibling PR (or worse, in `dashboard`) instead of in
 *   the pkg that caused it. This guard pulls the failure forward:
 *   `pnpm --filter @emploke/workflow typecheck` fails the moment the
 *   public surface drifts, BEFORE the downstream consumer notices.
 *
 * WHEN it runs:
 *   - At `pnpm typecheck` time: every `expectTypeOf` assertion is
 *     evaluated by tsc — that is where the real check happens.
 *   - At `pnpm test` time: the file loads and the `describe(...)` /
 *     `it(...)` bodies execute, but `expectTypeOf` is a no-op at
 *     runtime — vitest reports the cases as passing trivially.
 *   - `expectTypeOf` has zero runtime cost; the cost is paid once at
 *     compile time.
 *
 * HOW to extend it:
 *   Every time you ADD / RENAME / REMOVE a public method on the
 *   service, an exported error class, or an exported DTO field,
 *   update the matching `expectTypeOf` line in the SAME PR. Review
 *   enforces the coupling — a public-surface change without a guard
 *   update is a missing assertion.
 *
 * Worked example: see `packages/catalog/test/public-api-guard.test.ts`
 * for a fully-populated version locking 25+ methods and 19 error
 * classes on a real BC.
 */

import { describe, expectTypeOf, it } from "vitest";
import {
  CorruptedWorkflowError,
  type CreateNodeArgs,
  type CreateWorkflowArgs,
  composeWorkflowModule,
  InvalidWorkflowIdError,
  InvalidWorkflowNodeIdError,
  InvalidWorkflowTransitionError,
  type NodeResultPatch,
  type TaskDispatcher,
  type TaskNodeSpec,
  type WORKFLOW_NODES_SUBDIR,
  type WORKFLOW_SUBDIR,
  type Workflow,
  WorkflowCycleError,
  type WorkflowEdge,
  WorkflowError,
  type WorkflowModule,
  type WorkflowModuleOptions,
  type WorkflowNode,
  WorkflowNodeNotFoundError,
  WorkflowNodeNotReadyError,
  type WorkflowNodeStatus,
  type WorkflowNodeType,
  WorkflowNotFoundError,
  type WorkflowOutcome,
  type WorkflowService,
  type WorkflowState,
  type WorkflowStatus,
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
      new WorkflowNodeNotReadyError("wf-id", "node-id", "upstream not done"),
      new WorkflowCycleError("wf-id", "node-a", "node-b"),
      new InvalidWorkflowIdError("bad"),
      new InvalidWorkflowNodeIdError("bad"),
      new InvalidWorkflowTransitionError("succeeded", "launchNode"),
      new InvalidWorkflowTransitionError("succeeded", "launchNode", "terminal node"),
      new CorruptedWorkflowError("wf-id", "bad schemaVersion"),
    ];
    expectTypeOf(errs[0]!).toExtend<Error>();
  });

  it("preserves the public DTO + option shapes", () => {
    // Workflow wire DTO — the dashboard renders these and the server
    // projects them; a rename breaks both immediately.
    expectTypeOf<Workflow>().toHaveProperty("id");
    expectTypeOf<Workflow>().toHaveProperty("brief");
    expectTypeOf<Workflow>().toHaveProperty("status");
    expectTypeOf<Workflow>().toHaveProperty("metadata");
    expectTypeOf<Workflow>().toHaveProperty("createdAt");

    expectTypeOf<WorkflowNode>().toHaveProperty("id");
    expectTypeOf<WorkflowNode>().toHaveProperty("workflowId");
    expectTypeOf<WorkflowNode>().toHaveProperty("type");
    expectTypeOf<WorkflowNode>().toHaveProperty("status");
    expectTypeOf<WorkflowNode>().toHaveProperty("spec");
    expectTypeOf<WorkflowNode>().toHaveProperty("data");
    expectTypeOf<WorkflowNode>().toHaveProperty("createdAt");

    expectTypeOf<WorkflowEdge>().toHaveProperty("workflowId");
    expectTypeOf<WorkflowEdge>().toHaveProperty("from");
    expectTypeOf<WorkflowEdge>().toHaveProperty("to");

    expectTypeOf<WorkflowState>().toHaveProperty("workflow");
    expectTypeOf<WorkflowState>().toHaveProperty("nodes");
    expectTypeOf<WorkflowState>().toHaveProperty("edges");

    // Lifecycle enums — every change here ripples to every consumer
    // that branches on them; locked verbatim.
    expectTypeOf<WorkflowStatus>().toEqualTypeOf<"not_started" | "running" | "idle" | "archived">();
    expectTypeOf<WorkflowOutcome>().toEqualTypeOf<"succeeded" | "failed" | "cancelled">();
    expectTypeOf<WorkflowNodeStatus>().toEqualTypeOf<
      "not_started" | "ready" | "running" | "succeeded" | "failed" | "cancelled"
    >();
    expectTypeOf<WorkflowNodeType>().toEqualTypeOf<"task">();

    // Args + spec consumed by the service.
    expectTypeOf<CreateWorkflowArgs>().toHaveProperty("brief");
    expectTypeOf<CreateNodeArgs>().toHaveProperty("type");
    expectTypeOf<CreateNodeArgs>().toHaveProperty("spec");
    expectTypeOf<TaskNodeSpec>().toHaveProperty("agent");
    expectTypeOf<TaskNodeSpec>().toHaveProperty("brief");

    // Result patch shape — orchestrator-supplied bag persisted into node.data.
    expectTypeOf<NodeResultPatch>().toBeObject();

    // TaskDispatcher port — workflow calls dispatch by name on this shape.
    expectTypeOf<TaskDispatcher>().toHaveProperty("dispatch");
  });

  it("preserves the WorkflowService class and its public method names", () => {
    expectTypeOf<WorkflowService>().toHaveProperty("get");
    expectTypeOf<WorkflowService>().toHaveProperty("getState");
    expectTypeOf<WorkflowService>().toHaveProperty("list");
    expectTypeOf<WorkflowService>().toHaveProperty("createWorkflow");
    expectTypeOf<WorkflowService>().toHaveProperty("createNode");
    expectTypeOf<WorkflowService>().toHaveProperty("addEdge");
    expectTypeOf<WorkflowService>().toHaveProperty("launchNode");
    expectTypeOf<WorkflowService>().toHaveProperty("markDone");
    expectTypeOf<WorkflowService>().toHaveProperty("markFailed");
    expectTypeOf<WorkflowService>().toHaveProperty("cancelNode");
    expectTypeOf<WorkflowService>().toHaveProperty("finishWorkflow");
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

  it("preserves the composition surface (composeWorkflowModule + WorkflowModule + WorkflowModuleOptions)", () => {
    expectTypeOf(composeWorkflowModule).parameters.toEqualTypeOf<[WorkflowModuleOptions]>();
    expectTypeOf(composeWorkflowModule).returns.resolves.toEqualTypeOf<WorkflowModule>();

    expectTypeOf<WorkflowModule>().toHaveProperty("service");
    expectTypeOf<WorkflowModule>().toHaveProperty("close");
  });
});
