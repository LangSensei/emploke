/**
 * Public types for `@emploke/schedule`.
 *
 * The schedule pkg is an open substrate: it stores `schedules` rows
 * with an opaque `{ kind: string, data: unknown }` envelope and
 * routes every kind-aware operation (validate, RFC 7396 merge,
 * dispatch, in-flight check, cascade delete) through a
 * {@link ScheduleKindHandler} the caller registers at compose time
 * via `ScheduleService.registerKind(kind, handler)`. The pkg has no
 * built-in knowledge of "task", "workflow", or any other concrete
 * kind — adding one requires zero edits to `packages/schedule/src/`.
 *
 * See `core/src/wiring/schedule-task-handler.ts` for the production
 * task-kind handler and `README.md` for the composition snippet.
 */

/**
 * Opaque envelope persisted by the schedule pkg for every row. The
 * `data` payload is `unknown` because the substrate deliberately
 * doesn't know the per-kind shape; the registered
 * {@link ScheduleKindHandler} owns parsing / validation / merge /
 * dispatch of `data`.
 *
 * On disk: `kind` lives in the `schedules.target_kind` column and
 * `data` is `JSON.stringify`ed into `schedules.target_json`. The
 * kind is NOT redundantly nested inside `target_json` (see
 * `ScheduleEntity.toRow`).
 */
export interface ScheduleTargetEnvelope {
  readonly kind: string;
  readonly data: unknown;
}

/**
 * Per-kind handler registered at compose time. Implementations live
 * wherever the kind is integrated — e.g. the production task handler
 * lives in `core/src/wiring/schedule-task-handler.ts` because it
 * knows about `@emploke/schedule`, `@emploke/task`, AND
 * `@emploke/catalog`. The schedule pkg itself never imports any of
 * its callers.
 *
 * All methods receive `data: unknown` and are responsible for the
 * shape check. Implementations should throw caller-meaningful errors
 * (the task handler throws task-pkg's `AgentNotFoundError` /
 * `AgentResolutionFailedError` directly on catalog miss / failure);
 * those propagate through the schedule pkg untouched, and the
 * server's error-policy table maps them to the right HTTP status.
 *
 * The interface is intentionally non-generic. Per-kind type safety
 * lives at the EDGES: route handlers narrow from `unknown` to the
 * typed shape before calling `service.create`; handlers cast
 * `unknown` immediately after their own `validate` produces a value.
 * A `ScheduleKindHandler<TData>` generic would defeat the
 * open-registry goal (every caller would need to track the kind→T
 * mapping at compile time).
 */
export interface ScheduleKindHandler {
  /**
   * Validate an inbound `data` payload (from the API body via the
   * service's `create` / `patch`). MUST throw on invalid shape; MAY
   * perform async side-effects (e.g. catalog existence lookup).
   *
   * Returns the validated / normalized payload, which the schedule
   * pkg persists as `envelope.data`. Implementations are free to
   * normalize (trim, lowercase, drop unknown keys) — the returned
   * value is what gets stored.
   *
   * When `opts.changedKeys` is provided (only on patch
   * re-validation after `mergePatch`), the handler MAY skip
   * expensive cross-checks (e.g. catalog lookup) whose inputs did
   * not change. When omitted (on `create`, or when caller
   * explicitly opts out), full validation including all
   * cross-checks runs.
   */
  validate(data: unknown, opts?: { readonly changedKeys?: readonly string[] }): Promise<unknown>;

  /**
   * Apply an RFC 7396-style patch to an existing `data` payload,
   * returning the merged result plus the keys that actually changed
   * (so the subsequent `validate` call can skip cross-checks whose
   * inputs are unchanged).
   *
   * Pure function; sync; no I/O. Pre-condition: `existing` is the
   * latest persisted `data` for some row of this kind — i.e. a
   * value the handler's own `validate` previously produced — so
   * implementations MAY cast directly to their typed shape.
   *
   * `changedKeys` are TOP-LEVEL keys of the data payload that were
   * added, modified, or removed by the patch. The schedule pkg
   * forwards them as `validate(..., { changedKeys })` so the
   * handler can skip work; the keys are NOT inspected by the
   * substrate itself.
   */
  mergePatch(
    existing: unknown,
    patch: unknown,
  ): { readonly data: unknown; readonly changedKeys: readonly string[] };

  /**
   * Dispatch the target as a fire-event. The schedule pkg passes
   * already-validated `data`. Returns a substrate-side identifier
   * (task id, workflow run id, …) for audit and for
   * `ScheduleService.run()`'s `dispatchId` return.
   */
  dispatch(opts: {
    readonly scheduleId: string;
    readonly firedAt: string;
    readonly data: unknown;
  }): Promise<{ readonly id: string }>;

  /**
   * Whether this kind currently has a dispatched-but-incomplete
   * unit-of-work for `scheduleId`. Used by
   * `ScheduleService.delete()` pre-flight AND by the automated
   * `fire` path's concurrency check.
   */
  hasInFlightForSchedule(scheduleId: string): Promise<boolean>;

  /**
   * Cascade-delete the kind's historical units-of-work for
   * `scheduleId`. Returns count removed. Implementations MUST
   * filter to terminal status only (mirrors current task semantics)
   * to defend against TOCTOU between the schedule pkg's
   * `hasInFlight` pre-flight and this call.
   */
  deleteForSchedule(scheduleId: string): Promise<{ readonly deletedCount: number }>;
}

export type ScheduleTrigger = {
  readonly kind: "cron";
  readonly expr: string;
  readonly tz: string;
};
// Future: | { kind: "interval"; everyMs: number }

/**
 * Wire-shape DTO returned by `ScheduleService` reads. The `target`
 * field is the internal opaque envelope; the server's route layer
 * projects to a kind-specific flat wire shape (e.g.
 * `{ kind: "task", agent, brief, ... }`) for HTTP responses via
 * `projectScheduleToWire` so dashboard / CLI consumers keep reading
 * flat fields.
 */
export interface Schedule {
  readonly id: string;
  readonly name: string;
  readonly trigger: ScheduleTrigger;
  readonly target: ScheduleTargetEnvelope;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastFiredAt?: string;
  readonly nextFireAt?: string;
}

/**
 * Args for `ScheduleService.create`. Kind-neutral: the `target`
 * carries `{ kind, data }` and the registered handler validates the
 * `data` payload.
 */
export interface CreateScheduleArgs {
  readonly name: string;
  readonly trigger: ScheduleTrigger;
  readonly target: ScheduleTargetEnvelope;
  readonly enabled?: boolean;
}

/**
 * Args for `ScheduleService.patch`. Sparse — only the supplied
 * fields are updated. `target.patch` is opaque to the substrate; the
 * handler's `mergePatch(existing.data, patch)` produces the merged
 * data which is then revalidated.
 *
 * `expectedKind` lets the route layer enforce kind-discriminated
 * URLs (e.g. `PATCH /task/:sid` passes `expectedKind: "task"`); on
 * mismatch the service throws {@link ScheduleKindMismatchError},
 * which the route projects to a 404 to avoid leaking the actual kind.
 */
export interface PatchScheduleArgs {
  readonly name?: string;
  readonly trigger?: ScheduleTrigger;
  readonly enabled?: boolean;
  readonly target?: { readonly patch: unknown };
  readonly expectedKind?: string;
}

/**
 * Opts for `ScheduleService.list`. All filters are AND-combined.
 *
 *   - `enabled`: equality on the `enabled` column.
 *   - `kind`: equality on `target_kind`. When set together with
 *     `dataEquals`, engages the partial JSON-extract index
 *     `schedules_target_agent_idx` (defined `WHERE target_kind =
 *     'task'`, so only task-kind queries benefit).
 *   - `dataEquals`: generic equality on a JSON path inside
 *     `target_json`. The `path` is validated against the
 *     `^\$(\.[a-zA-Z_][a-zA-Z0-9_]*)+$` grammar to prevent SQL
 *     injection (the `value` is parameter-bound and is safe).
 */
export interface ListScheduleOpts {
  readonly enabled?: boolean;
  readonly kind?: string;
  readonly dataEquals?: {
    readonly path: string;
    readonly value: string | number | boolean;
  };
}

export interface PreviewResult {
  readonly describe: string;
  readonly nextRuns: readonly string[];
}
