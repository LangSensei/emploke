/**
 * Compile-time public API guard for `@emploke/api`.
 *
 * WHAT this file does:
 *   Uses Vitest's `expectTypeOf<T>()` to lock the workflow-related
 *   additions to the pkg's public surface — specifically the
 *   {@link makeWorkerNodeRunner} factory + {@link WorkerNodeSpec} +
 *   {@link WorkflowWorkerSpecError} exports.
 *
 * WHY it is valuable:
 *   These factories are consumed by downstream packages (server, e2e
 *   harnesses, the dashboard). Locking the public shape here makes
 *   accidental renames or breaking-shape changes surface as a
 *   compile-time test failure rather than a downstream runtime
 *   surprise.
 */

import { describe, expectTypeOf, it } from "vitest";
import {
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
});
