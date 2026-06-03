/**
 * Compile-time public API guard for `@emploke/schedule`.
 *
 * WHAT this file does:
 *   Uses Vitest's `expectTypeOf<T>()` to lock the pkg's public surface
 *   at the TYPE level. Every public method on the service class, every
 *   exported error class, every exported DTO / option shape, and the
 *   `describeCron` helper get a `expectTypeOf(...)` assertion below.
 *
 * WHY it is valuable:
 *   Silent renames (`registerKind` → `addKind`), accidental method
 *   removals, DTO-field drift, and dropping a per-kind error class all
 *   break downstream pkgs at compile time — but only the downstream
 *   pkg's typecheck sees the failure, which means breakage surfaces in
 *   a sibling PR (or worse, in `dashboard`) instead of in the pkg that
 *   caused it. This guard pulls the failure forward:
 *   `pnpm --filter @emploke/schedule typecheck` fails the moment the
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
  type CreateScheduleArgs,
  composeScheduleModule,
  describeCron,
  InvalidCronExprError,
  InvalidJsonPathError,
  InvalidScheduleIdError,
  InvalidTimezoneError,
  type ListScheduleOpts,
  type PatchScheduleArgs,
  type PreviewResult,
  type Schedule,
  ScheduleEnabledError,
  ScheduleError,
  ScheduleHasInFlightError,
  ScheduleKindAlreadyRegisteredError,
  type ScheduleKindHandler,
  ScheduleKindMismatchError,
  ScheduleKindNotRegisteredError,
  ScheduleKindRegistryFrozenError,
  type ScheduleModule,
  type ScheduleModuleOptions,
  ScheduleNotFoundError,
  type ScheduleService,
  type ScheduleTargetEnvelope,
  type ScheduleTrigger,
} from "../src/index.js";

describe("@emploke/schedule public API guard", () => {
  it("exports the concrete error classes with their canonical constructor signatures", () => {
    const errs: Error[] = [
      new ScheduleError("boom"),
      new ScheduleError("boom", { cause: new Error("upstream") }),
      new ScheduleNotFoundError("sid"),
      new InvalidScheduleIdError("bad"),
      new InvalidCronExprError("* * * *", "too few fields"),
      new InvalidTimezoneError("Mars/Olympus"),
      new ScheduleEnabledError("sid"),
      new ScheduleHasInFlightError("sid"),
      new ScheduleKindMismatchError("sid", "task", "workflow"),
      new ScheduleKindAlreadyRegisteredError("task"),
      new ScheduleKindNotRegisteredError("task"),
      new ScheduleKindNotRegisteredError("task", "custom message"),
      new ScheduleKindRegistryFrozenError("workflow"),
      new InvalidJsonPathError("$..bad"),
    ];
    expectTypeOf(errs[0]!).toExtend<Error>();
  });

  it("preserves the public DTO + option shapes", () => {
    // Schedule wire DTO — projected by the server to a kind-specific
    // shape; a rename here breaks both the projection and the dashboard.
    expectTypeOf<Schedule>().toHaveProperty("id");
    expectTypeOf<Schedule>().toHaveProperty("name");
    expectTypeOf<Schedule>().toHaveProperty("trigger");
    expectTypeOf<Schedule>().toHaveProperty("target");
    expectTypeOf<Schedule>().toHaveProperty("enabled");
    expectTypeOf<Schedule>().toHaveProperty("createdAt");
    expectTypeOf<Schedule>().toHaveProperty("updatedAt");

    // Opaque envelope persisted for every row.
    expectTypeOf<ScheduleTargetEnvelope>().toHaveProperty("kind");
    expectTypeOf<ScheduleTargetEnvelope>().toHaveProperty("data");

    // Trigger discriminator — only "cron" today but locked so a future
    // additive variant is a deliberate change to this guard.
    expectTypeOf<ScheduleTrigger>().toHaveProperty("kind");
    expectTypeOf<ScheduleTrigger>().toHaveProperty("expr");
    expectTypeOf<ScheduleTrigger>().toHaveProperty("tz");

    // Open-registry per-kind handler — the substrate calls these by
    // name; renaming any method silently breaks every registered handler.
    expectTypeOf<ScheduleKindHandler>().toHaveProperty("validate");
    expectTypeOf<ScheduleKindHandler>().toHaveProperty("mergePatch");
    expectTypeOf<ScheduleKindHandler>().toHaveProperty("dispatch");
    expectTypeOf<ScheduleKindHandler>().toHaveProperty("hasInFlightForSchedule");
    expectTypeOf<ScheduleKindHandler>().toHaveProperty("deleteForSchedule");

    // Args + opts consumed by the service surface.
    expectTypeOf<CreateScheduleArgs>().toHaveProperty("name");
    expectTypeOf<CreateScheduleArgs>().toHaveProperty("trigger");
    expectTypeOf<CreateScheduleArgs>().toHaveProperty("target");
    expectTypeOf<PatchScheduleArgs>().toHaveProperty("name");
    expectTypeOf<PatchScheduleArgs>().toHaveProperty("trigger");
    expectTypeOf<PatchScheduleArgs>().toHaveProperty("enabled");
    expectTypeOf<PatchScheduleArgs>().toHaveProperty("target");
    expectTypeOf<PatchScheduleArgs>().toHaveProperty("expectedKind");
    expectTypeOf<ListScheduleOpts>().toHaveProperty("enabled");
    expectTypeOf<ListScheduleOpts>().toHaveProperty("kind");
    expectTypeOf<ListScheduleOpts>().toHaveProperty("dataEquals");

    // preview() return shape — dashboard renders both fields.
    expectTypeOf<PreviewResult>().toHaveProperty("describe");
    expectTypeOf<PreviewResult>().toHaveProperty("nextRuns");
  });

  it("preserves the ScheduleService class and its public method names", () => {
    expectTypeOf<ScheduleService>().toHaveProperty("registerKind");
    expectTypeOf<ScheduleService>().toHaveProperty("get");
    expectTypeOf<ScheduleService>().toHaveProperty("list");
    expectTypeOf<ScheduleService>().toHaveProperty("create");
    expectTypeOf<ScheduleService>().toHaveProperty("patch");
    expectTypeOf<ScheduleService>().toHaveProperty("delete");
    expectTypeOf<ScheduleService>().toHaveProperty("run");
    expectTypeOf<ScheduleService>().toHaveProperty("preview");
    expectTypeOf<ScheduleService>().toHaveProperty("recover");
    expectTypeOf<ScheduleService>().toHaveProperty("shutdown");
  });

  it("preserves the re-exported describeCron helper", () => {
    expectTypeOf(describeCron).toBeFunction();
  });

  it("preserves the composition surface (composeScheduleModule + ScheduleModule + ScheduleModuleOptions)", () => {
    expectTypeOf(composeScheduleModule).parameters.toEqualTypeOf<[ScheduleModuleOptions]>();
    expectTypeOf(composeScheduleModule).returns.resolves.toEqualTypeOf<ScheduleModule>();

    expectTypeOf<ScheduleModule>().toHaveProperty("service");
    expectTypeOf<ScheduleModule>().toHaveProperty("close");
  });
});
