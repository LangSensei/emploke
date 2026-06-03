/**
 * Compile-time public API guard for `@emploke/task`.
 *
 * WHAT this file does:
 *   Uses Vitest's `expectTypeOf<T>()` to lock the pkg's public surface
 *   at the TYPE level. Every public method on the service class, every
 *   exported error class, every exported DTO / option shape, and every
 *   exported utility function (framing, paths, validate, workdir,
 *   task-meta) gets a `expectTypeOf(...)` assertion below.
 *
 * WHY it is valuable:
 *   Silent renames (`dispatch` → `dispatchTask`), accidental method
 *   removals, DTO-field drift, and quietly dropping a utility function
 *   that schedule/workflow/api re-consume all break downstream pkgs
 *   at compile time — but only the downstream pkg's typecheck sees the
 *   failure, which means breakage surfaces in a sibling PR (or worse,
 *   in `dashboard`) instead of in the pkg that caused it. This guard
 *   pulls the failure forward: `pnpm --filter @emploke/task typecheck`
 *   fails the moment the public surface drifts, BEFORE the downstream
 *   consumer notices.
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
  type AgentEntry,
  AgentNotFoundError,
  AgentResolutionFailedError,
  assertFramingPromptIsSafe,
  assertValidTaskId,
  CorruptedTaskError,
  composeTaskModule,
  type DispatchOpts,
  EntryNotReadyError,
  formatTaskMd,
  generateTaskId,
  InvalidTaskIdError,
  InvalidTransition,
  type ListTaskOpts,
  listWorkdirFiles,
  ManagerShuttingDownError,
  RuntimeDoesNotSupportTasksError,
  readTaskRuntimeMetadata,
  safeJoinUnderRoot,
  type Task,
  type TaskCancellation,
  TaskError,
  type TaskFailure,
  TaskIdAllocationFailedError,
  type TaskModule,
  type TaskModuleOptions,
  TaskNotFoundError,
  type TaskOrigin,
  type TaskRuntimeMetadata,
  type TaskService,
  type TaskServiceConfig,
  type TaskStatus,
  type TaskSuccess,
  type TerminalStatus,
} from "../src/index.js";

describe("@emploke/task public API guard", () => {
  it("exports the concrete error classes with their canonical constructor signatures", () => {
    const errs: Error[] = [
      new TaskError("boom"),
      new TaskError("boom", { cause: new Error("upstream") }),
      new InvalidTransition("succeeded", "complete"),
      new InvalidTaskIdError("bad-id"),
      new InvalidTaskIdError(42),
      new AgentNotFoundError("public/demo"),
      new AgentNotFoundError("public/demo", new Error("upstream")),
      new AgentResolutionFailedError("public/demo"),
      new AgentResolutionFailedError("public/demo", new Error("upstream")),
      new TaskNotFoundError("20260101-deadbeef"),
      new RuntimeDoesNotSupportTasksError("gemini"),
      new EntryNotReadyError("public/demo", undefined),
      new EntryNotReadyError("public/demo", { disabledByUser: true }),
      new TaskIdAllocationFailedError(5),
      new CorruptedTaskError("20260101-deadbeef", "bad schemaVersion"),
      new ManagerShuttingDownError(),
    ];
    expectTypeOf(errs[0]!).toExtend<Error>();
  });

  it("preserves the public DTO + option shapes", () => {
    // Task wire DTO — the dashboard renders these fields and the
    // server projects them; a rename here breaks both immediately.
    expectTypeOf<Task>().toHaveProperty("id");
    expectTypeOf<Task>().toHaveProperty("agent");
    expectTypeOf<Task>().toHaveProperty("brief");
    expectTypeOf<Task>().toHaveProperty("origin");
    expectTypeOf<Task>().toHaveProperty("status");
    expectTypeOf<Task>().toHaveProperty("metadata");
    expectTypeOf<Task>().toHaveProperty("createdAt");
    expectTypeOf<Task>().toHaveProperty("startedAt");

    // Lifecycle enums — the wire shape is fixed; adding/removing
    // status arms here ripples to every consumer that branches on them.
    expectTypeOf<TaskStatus>().toEqualTypeOf<"running" | "succeeded" | "failed" | "cancelled">();
    expectTypeOf<TerminalStatus>().toEqualTypeOf<"succeeded" | "failed" | "cancelled">();
    expectTypeOf<TaskOrigin>().toEqualTypeOf<"standalone" | "workflow" | "schedule">();

    // Terminal payloads — discriminated unions; assert the discriminator
    // surface so a missing variant trips at compile time.
    expectTypeOf<TaskSuccess>().toHaveProperty("output");
    expectTypeOf<TaskFailure>().toHaveProperty("kind");
    expectTypeOf<TaskFailure>().toHaveProperty("message");
    expectTypeOf<TaskCancellation>().toHaveProperty("kind");
    expectTypeOf<TaskCancellation>().toHaveProperty("message");

    // Option bags consumed by the service surface.
    expectTypeOf<DispatchOpts>().toHaveProperty("agent");
    expectTypeOf<DispatchOpts>().toHaveProperty("brief");
    expectTypeOf<DispatchOpts>().toHaveProperty("origin");
    expectTypeOf<ListTaskOpts>().toHaveProperty("agent");
    expectTypeOf<ListTaskOpts>().toHaveProperty("statuses");
    expectTypeOf<ListTaskOpts>().toHaveProperty("origin");

    // Service config exposes the catalog/runtime ports + workspace context.
    expectTypeOf<TaskServiceConfig>().toHaveProperty("agentResolver");
    expectTypeOf<TaskServiceConfig>().toHaveProperty("contentSource");
    expectTypeOf<TaskServiceConfig>().toHaveProperty("runtimeRegistry");
    expectTypeOf<TaskServiceConfig>().toHaveProperty("workspaceDir");
    expectTypeOf<TaskServiceConfig>().toHaveProperty("workspaceId");

    // Catalog-side port shape consumed by dispatch.
    expectTypeOf<AgentEntry>().toHaveProperty("status");

    // task-meta DTO — schedule/workflow read it via readTaskRuntimeMetadata.
    expectTypeOf<TaskRuntimeMetadata>().toBeObject();
  });

  it("preserves the TaskService class and its public method names", () => {
    expectTypeOf<TaskService>().toHaveProperty("dispatch");
    expectTypeOf<TaskService>().toHaveProperty("list");
    expectTypeOf<TaskService>().toHaveProperty("get");
    expectTypeOf<TaskService>().toHaveProperty("cancel");
    expectTypeOf<TaskService>().toHaveProperty("delete");
    expectTypeOf<TaskService>().toHaveProperty("hasInFlightForSchedule");
    expectTypeOf<TaskService>().toHaveProperty("deleteForSchedule");
    expectTypeOf<TaskService>().toHaveProperty("getTaskActivity");
    expectTypeOf<TaskService>().toHaveProperty("getTaskActivityStream");
    expectTypeOf<TaskService>().toHaveProperty("recoverOrphaned");
    expectTypeOf<TaskService>().toHaveProperty("liveCount");
    expectTypeOf<TaskService>().toHaveProperty("shutdown");
    expectTypeOf<TaskService>().toHaveProperty("close");
    expectTypeOf<TaskService>().toHaveProperty("resolveArtifactPath");
  });

  it("preserves the re-exported utility functions consumed by sibling pkgs", () => {
    // framing.ts — schedule/api re-consume these for task workdir setup.
    expectTypeOf(assertFramingPromptIsSafe).toBeFunction();
    expectTypeOf(formatTaskMd).toBeFunction();
    // paths.ts — server uses safeJoinUnderRoot for artifact resolution.
    expectTypeOf(safeJoinUnderRoot).toBeFunction();
    // validate.ts — schedule/api validate caller-supplied task ids.
    expectTypeOf(assertValidTaskId).toBeFunction();
    expectTypeOf(generateTaskId).toBeFunction();
    // task-meta.ts — server projects runtime metadata into the wire shape.
    expectTypeOf(readTaskRuntimeMetadata).toBeFunction();
    // workdir.ts — server enumerates artifact files via this helper.
    expectTypeOf(listWorkdirFiles).toBeFunction();
  });

  it("preserves the composition surface (composeTaskModule + TaskModule + TaskModuleOptions)", () => {
    expectTypeOf(composeTaskModule).parameters.toEqualTypeOf<[TaskModuleOptions]>();
    expectTypeOf(composeTaskModule).returns.resolves.toEqualTypeOf<TaskModule>();

    expectTypeOf<TaskModule>().toHaveProperty("service");
    expectTypeOf<TaskModule>().toHaveProperty("close");

    expectTypeOf<TaskModuleOptions>().toHaveProperty("dbFile");
    expectTypeOf<TaskModuleOptions>().toHaveProperty("agentResolver");
    expectTypeOf<TaskModuleOptions>().toHaveProperty("contentSource");
    expectTypeOf<TaskModuleOptions>().toHaveProperty("runtimeRegistry");
    expectTypeOf<TaskModuleOptions>().toHaveProperty("workspaceDir");
    expectTypeOf<TaskModuleOptions>().toHaveProperty("workspaceId");
  });
});
