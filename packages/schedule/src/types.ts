/**
 * Public types for `@emploke/schedule`.
 *
 * Discriminated unions on both `target` and `trigger` from day 1.
 * v1 ships only the `task` target and `cron` trigger leaves; future
 * additions (`workflow` target, `interval` trigger) are additive
 * with no schema bump.
 */

export type ScheduleTarget = {
  readonly kind: "task";
  readonly agent: string;
  readonly instructions: string;
  readonly runtime?: string;
};
// Future: | { kind: "workflow"; workflowId: string; inputs?: Record<string, unknown> }

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

export interface CreateScheduleArgs {
  readonly name: string;
  readonly trigger: ScheduleTrigger;
  readonly target: ScheduleTarget;
  readonly enabled?: boolean;
}

export interface PatchScheduleArgs {
  readonly name?: string;
  readonly trigger?: ScheduleTrigger;
  readonly target?: ScheduleTarget;
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
 * production wiring (in PR 3) adapts `TaskService.dispatch` +
 * `TaskService.hasInFlightForSchedule` to it structurally.
 *
 * `origin: "schedule"` and the `metadata.scheduleId` + `metadata.firedAt`
 * keys are wire-shape contract enforced by PR 1's `TaskOrigin` extension
 * + functional index `tasks_schedule_id_idx`. Do not deviate.
 */
export interface TaskDispatcher {
  dispatch(opts: {
    readonly agent: string;
    readonly instructions: string;
    readonly runtime?: string;
    readonly origin: "schedule";
    readonly metadata: { readonly scheduleId: string; readonly firedAt: string };
  }): Promise<{ readonly id: string }>;
  hasInFlightForSchedule(scheduleId: string): Promise<boolean>;
}
