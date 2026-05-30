/**
 * Public types for `@emploke/schedule`.
 *
 * Discriminated unions on both `target` and `trigger` from day 1.
 * v1 ships only the `task` target and `cron` trigger leaves; future
 * additions (`workflow` target, `interval` trigger) are additive
 * with no schema bump.
 *
 * ## Mutation contract (URL-discriminated)
 *
 * Reads and lifecycle operations (`get`, `list`, `delete`, `run`,
 * `preview`) are polymorphic over `target.kind`. Mutations split by
 * kind so each PATCH body can give callers an honest, RFC 7396-style
 * deep-merge contract:
 *
 *   - {@link CreateTaskScheduleArgs} drives `POST /schedules/task`
 *     (server injects `kind: "task"` before persisting).
 *   - {@link PatchTaskScheduleArgs} drives `PATCH /schedules/task/:sid`.
 *     `name` / `enabled` are scalar-set; `trigger` replaces wholesale
 *     (it's a small atomic shape); `target` is RFC 7396 deep-merged on
 *     a flat record (a `null` on optional `details` / `runtime` deletes
 *     the field; required `agent` / `brief` cannot be `null`).
 *
 * When a `workflow` target lands later, it will get its own
 * `Create/PatchWorkflowScheduleArgs` plus `POST/PATCH
 * /schedules/workflow[/:sid]` routes; reads stay polymorphic.
 */

export type ScheduleTarget = TaskScheduleTarget;
// Future: | WorkflowScheduleTarget

/** Persisted target shape for `target.kind === "task"`. */
export type TaskScheduleTarget = {
  readonly kind: "task";
} & TaskTargetData;

/**
 * Kind-less view of a task target's payload — the wire shape for
 * `POST /schedules/task` and `PATCH /schedules/task/:sid` bodies
 * (the URL discriminates the kind so `kind` is implicit there).
 */
export interface TaskTargetData {
  readonly agent: string;
  /** Single line, ≤ 200 chars. Mirrors `@emploke/task` DispatchOpts.brief. */
  readonly brief: string;
  /** Multi-line, optional. Mirrors `@emploke/task` DispatchOpts.details (empty string allowed). */
  readonly details?: string;
  readonly runtime?: string;
}

/**
 * RFC 7396 deep-merge patch for a task target.
 *
 * Field semantics:
 *   - `agent` / `brief`: if present, set (must be a non-empty string;
 *     `null` is rejected at the route boundary because these are
 *     required-on-entity).
 *   - `details` / `runtime`: if present and string → set; if `null` →
 *     delete the field; if absent → keep existing.
 *
 * The `kind` discriminator is intentionally absent — it's implied by
 * the URL (`/schedules/task/:sid`).
 */
export interface TaskTargetPatch {
  readonly agent?: string;
  readonly brief?: string;
  readonly details?: string | null;
  readonly runtime?: string | null;
}

export type ScheduleTrigger = {
  readonly kind: "cron";
  readonly expr: string;
  readonly tz: string;
};
// Future: | { kind: "interval"; everyMs: number }

/** Wire-shape DTO returned by `ScheduleService` reads. */
export interface Schedule {
  readonly id: string;
  readonly name: string;
  readonly trigger: ScheduleTrigger;
  readonly target: ScheduleTarget;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastFiredAt?: string;
  readonly nextFireAt?: string;
}

/**
 * Args for `ScheduleService.createTask` — also the wire shape of
 * `POST /schedules/task` minus the URL-implied `target.kind`.
 */
export interface CreateTaskScheduleArgs {
  readonly name: string;
  readonly trigger: ScheduleTrigger;
  readonly target: TaskTargetData;
  readonly enabled?: boolean;
}

/**
 * Args for `ScheduleService.patchTask` — also the wire shape of
 * `PATCH /schedules/task/:sid`. See {@link TaskTargetPatch} for the
 * target merge semantics; `trigger` replaces wholesale; `name` /
 * `enabled` are scalar set.
 */
export interface PatchTaskScheduleArgs {
  readonly name?: string;
  readonly trigger?: ScheduleTrigger;
  readonly target?: TaskTargetPatch;
  readonly enabled?: boolean;
}

export interface ListScheduleOpts {
  readonly agent?: string;
  readonly enabled?: boolean;
}

export interface PreviewResult {
  readonly describe: string;
  readonly nextRuns: readonly string[];
}

/**
 * Capability the schedule pkg consumes for dispatching tasks. Schedule
 * pkg never imports from `@emploke/task` — this interface is what
 * `composeScheduleModule({ taskDispatcher })` accepts, and the
 * production wiring (in `@emploke/core`) adapts `TaskService.dispatch` +
 * `TaskService.hasInFlightForSchedule` to it structurally.
 *
 * The dispatch opts mirror `@emploke/task` `DispatchOpts` (brief +
 * details?) so the adapter in `@emploke/core` is a pass-through with
 * no brief synthesis. RFC #61 v2.
 *
 * `origin: "schedule"` and the `metadata.scheduleId` + `metadata.firedAt`
 * keys are wire-shape contract enforced by PR 1's `TaskOrigin` extension
 * + functional index `tasks_schedule_id_idx`. Do not deviate.
 */
export interface TaskDispatcher {
  dispatch(opts: {
    readonly agent: string;
    readonly brief: string;
    readonly details?: string;
    readonly runtime?: string;
    readonly origin: "schedule";
    readonly metadata: { readonly scheduleId: string; readonly firedAt: string };
  }): Promise<{ readonly id: string }>;
  hasInFlightForSchedule(scheduleId: string): Promise<boolean>;
  /**
   * Cascade-delete historical task runs for `scheduleId`. The
   * implementation (production binding: `TaskService.deleteForSchedule`)
   * removes only TERMINAL tasks, never touching anything still running.
   *
   * Returns the count of DB rows actually removed so the caller can
   * surface it in the API response / CLI output / audit log. Workdir
   * cleanup is fire-and-forget on the implementation side (orphan dirs
   * on a background-purge failure are an acknowledged failure mode per
   * ADR-001 §3.5).
   *
   * Called from `ScheduleService.delete` AFTER the timer has been
   * cancelled and the in-flight check has passed. The caller separately
   * re-checks `hasInFlightForSchedule` after this method returns to
   * defend against a racing manual `run()` that inserted a fresh
   * running task between the original in-flight check and the cascade.
   */
  deleteForSchedule(scheduleId: string): Promise<{ readonly deletedCount: number }>;
}
