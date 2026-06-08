/**
 * Compile-time public API guard for `@emploke/api`.
 *
 * WHAT this file does:
 *   Uses Vitest's `expectTypeOf<T>()` to lock the workflow-related
 *   additions to the pkg's public surface — specifically the
 *   {@link makeWorkerNodeRunner} factory + {@link WorkerNodeSpec} +
 *   {@link WorkflowWorkerSpecError} exports — and asserts that NO
 *   public type mentions `trustedCallerForTesting`. The flag is a
 *   test-only seam on `@emploke/workflow`'s `WorkflowModuleOptions`;
 *   plumbing it through `@emploke/api`'s `ApplicationOptions` would
 *   let production paths accidentally enable it.
 *
 * WHY it is valuable:
 *   This is the second half of the `trustedCallerForTesting`
 *   containment contract. The first half is the warn-log at boot in
 *   `composeWorkflowModule` when the flag is true; the second half
 *   is THIS guard, which makes it a compile-time error for any
 *   future refactor to propagate the flag up into `@emploke/api`.
 *
 * The tripwire is a `not.toHaveProperty` style assertion at the
 * indexed-access level — Type-level negative assertions cost less
 * than the maintenance burden of an integration test that boots a
 * real composition and asserts via reflection.
 */

import { describe, expectTypeOf, it } from "vitest";
import {
  type Application,
  type ApplicationOptions,
  DEFAULT_WORKER_MAX_POLL_ERRORS,
  DEFAULT_WORKER_POLL_INTERVAL_MS,
  type MakeWorkerNodeRunnerDeps,
  makeWorkerNodeRunner,
  type WorkerNodeSpec,
  WorkflowWorkerSpecError,
} from "../src/index.js";

describe("@emploke/api public API guard — M1 additions", () => {
  it("exposes makeWorkerNodeRunner factory + opts shape + spec type", () => {
    expectTypeOf(makeWorkerNodeRunner).toBeFunction();
    expectTypeOf<MakeWorkerNodeRunnerDeps>().toHaveProperty("tasks");
    expectTypeOf<MakeWorkerNodeRunnerDeps>().toHaveProperty("catalog");
    expectTypeOf<MakeWorkerNodeRunnerDeps>().toHaveProperty("logger");
    expectTypeOf<MakeWorkerNodeRunnerDeps>().toHaveProperty("pollIntervalMs");
    expectTypeOf<MakeWorkerNodeRunnerDeps>().toHaveProperty("maxPollErrors");
    expectTypeOf<WorkerNodeSpec>().toHaveProperty("agent");
    expectTypeOf<WorkerNodeSpec>().toHaveProperty("brief");
    expectTypeOf<WorkerNodeSpec["agent"]>().toBeString();
    expectTypeOf<WorkerNodeSpec["brief"]>().toBeString();
  });

  it("exposes WorkflowWorkerSpecError as an Error subclass with canonical .name", () => {
    const err = new WorkflowWorkerSpecError("bad spec");
    expectTypeOf(err).toExtend<Error>();
  });

  it("exposes the default worker poll constants", () => {
    expectTypeOf(DEFAULT_WORKER_POLL_INTERVAL_MS).toBeNumber();
    expectTypeOf(DEFAULT_WORKER_MAX_POLL_ERRORS).toBeNumber();
  });

  /**
   * Containment tripwire. The `trustedCallerForTesting` flag lives
   * on `@emploke/workflow`'s `WorkflowModuleOptions`; api-pkg tests
   * that need it use `composeWorkflowModule` directly, NOT through
   * `composeApplication`. This assertion fails the build if a future
   * refactor adds `trustedCallerForTesting` (or related flags) to
   * `ApplicationOptions` or to the `Application` runtime surface,
   * which would let production paths accidentally enable the bypass.
   */
  it("does NOT plumb trustedCallerForTesting through ApplicationOptions or Application", () => {
    expectTypeOf<ApplicationOptions>().not.toHaveProperty("trustedCallerForTesting");
    expectTypeOf<Application>().not.toHaveProperty("trustedCallerForTesting");
  });
});
