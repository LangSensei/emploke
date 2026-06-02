import pino, { type Logger } from "pino";
import { assertValidKindName, assertValidName, assertValidTrigger } from "./_helpers.js";
import { assertValidCronExpr, assertValidTimezone, describeCron, nextRuns } from "./cron.js";
import {
  ScheduleEnabledError,
  ScheduleError,
  ScheduleHasInFlightError,
  ScheduleKindAlreadyRegisteredError,
  ScheduleKindMismatchError,
  ScheduleKindNotRegisteredError,
  ScheduleKindRegistryFrozenError,
  ScheduleNotFoundError,
} from "./errors.js";
import { ScheduleEntity } from "./schedule-entity.js";
import type { ScheduleRepository } from "./schedule-repository.js";
import type {
  CreateScheduleArgs,
  ListScheduleOpts,
  PatchScheduleArgs,
  PreviewResult,
  Schedule,
  ScheduleKindHandler,
} from "./types.js";
import { generateScheduleId } from "./validate.js";

const silentLogger: Logger = pino({ level: "silent" });

interface ScheduleServiceOpts {
  readonly repo: ScheduleRepository;
  readonly logger?: Logger;
  readonly now?: () => Date;
  readonly randomUUID?: () => string;
}

/**
 * Public surface for `@emploke/schedule`. Owns:
 *
 *   - reads + writes against the `schedules` table
 *   - the croner-driven timer chain (`armNext` / `fire`)
 *   - `recover()` (boot-time catchup-once) and `shutdown()`
 *   - an OPEN registry of per-kind handlers
 *
 * ## Open registry (à la BullMQ / Sidekiq / Temporal)
 *
 * The substrate has no built-in knowledge of any concrete kind.
 * Callers register handlers at compose time:
 *
 * ```ts
 * const scheduleModule = await composeScheduleModule({ dbFile });
 * scheduleModule.service.registerKind("task", makeTaskKindHandler({ tasks, catalog }));
 * // future: scheduleModule.service.registerKind("workflow", makeWorkflowKindHandler({ ... }));
 * await scheduleModule.service.recover();   // freezes the registry; MUST come AFTER all registerKind
 * ```
 *
 * `recover()` freezes the registry on first call and preflights
 * every row (enabled AND disabled) for a registered handler — any
 * row whose `target_kind` was not registered throws
 * {@link ScheduleKindNotRegisteredError} naming the kind + the
 * register-before-recover requirement. This catches the
 * orphan-disabled-row failure mode where a kind drops out of the
 * compose code but its rows linger.
 *
 * ## Behaviour locks (per RFC §"Behaviour decisions")
 *
 *   - concurrency = 1 (skip-and-warn on overlap, no `last_fired_at`
 *     write on a skip)
 *   - catchup-once on boot (uses planned `firedAt`, not `now`)
 *   - no failure retry (referee never observes dispatch outcome)
 *   - hard delete; requires `enabled=false` + no in-flight
 *   - manual `run` bypasses the enabled check
 *   - `patch(trigger.*)` re-arms; `patch(target.*)` does not
 *   - `patch(enabled: …)` re-arms or cancels accordingly
 *
 * None of these are user-configurable in v1.
 */
export class ScheduleService {
  private readonly repo: ScheduleRepository;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly randomUUID: () => string;
  private readonly timers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private readonly handlers = new Map<string, ScheduleKindHandler>();
  private registryFrozen = false;
  private shutdownCalled = false;

  constructor(opts: ScheduleServiceOpts) {
    this.repo = opts.repo;
    this.logger = opts.logger ?? silentLogger;
    this.now = opts.now ?? (() => new Date());
    this.randomUUID = opts.randomUUID ?? (() => generateScheduleId());
  }

  // ─── Registry ─────────────────────────────────────────────

  /**
   * Register a per-kind handler. Throws if:
   *   - `kind` is not a non-empty `^[a-z][a-z0-9_-]*$` string
   *   - the registry was already frozen by a prior `recover()`
   *   - the same `kind` was already registered on this service
   *
   * MUST be called BEFORE `recover()`. The wiring in
   * `core/src/workspace-context.ts` does
   * `registerKind("task", handler)` then `recover()` in that order.
   */
  registerKind(kind: string, handler: ScheduleKindHandler): void {
    assertValidKindName(kind);
    if (this.registryFrozen) throw new ScheduleKindRegistryFrozenError(kind);
    if (this.handlers.has(kind)) throw new ScheduleKindAlreadyRegisteredError(kind);
    this.handlers.set(kind, handler);
  }

  private handlerFor(kind: string): ScheduleKindHandler {
    const h = this.handlers.get(kind);
    if (h === undefined) throw new ScheduleKindNotRegisteredError(kind);
    return h;
  }

  // ─── Reads ────────────────────────────────────────────────

  async get(id: string): Promise<Schedule | null> {
    const entity = await this.repo.read(id);
    return entity === null ? null : entity.toDto();
  }

  async list(opts: ListScheduleOpts = {}): Promise<readonly Schedule[]> {
    const entities = await this.repo.list(opts);
    return entities.map((e) => e.toDto());
  }

  // ─── Writes ───────────────────────────────────────────────

  /**
   * Create a new schedule of any registered kind. Order:
   *   1. Synchronous schedule-level invariants (name, trigger) —
   *      these throw a `ScheduleError` BEFORE any handler.validate
   *      so a malformed shape never reaches catalog lookup as a
   *      misleading not-found.
   *   2. Handler lookup — throws
   *      {@link ScheduleKindNotRegisteredError} early if the kind
   *      wasn't registered at compose time.
   *   3. `handler.validate(data)` (async) — handler-owned shape
   *      check + cross-checks (e.g. catalog existence for the task
   *      kind).
   *   4. Entity construction + nextFireAt computation BEFORE
   *      `repo.insert` so the list endpoint's ORDER BY can sort the
   *      freshly-created row alongside the rest.
   *   5. `armNext` only when `enabled === true`.
   */
  async create(args: CreateScheduleArgs): Promise<Schedule> {
    assertValidName(args.name);
    assertValidTrigger(args.trigger);
    const handler = this.handlerFor(args.target.kind);
    const validatedData = await handler.validate(args.target.data);
    const id = this.randomUUID();
    const now = this.now();
    let entity = ScheduleEntity.create(
      {
        name: args.name,
        trigger: args.trigger,
        target: { kind: args.target.kind, data: validatedData },
        ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
      },
      { id, now },
    );
    if (entity.enabled) {
      const [nextIso] = nextRuns(entity.trigger.expr, entity.trigger.tz, now, 1);
      entity = entity.withNextFireAt(nextIso);
    }
    await this.repo.insert(entity);
    if (entity.enabled) this.armNext(entity);
    return entity.toDto();
  }

  /**
   * Patch an existing schedule. Composes
   * {@link ScheduleEntity.withMetadata}, {@link ScheduleEntity.withTrigger}
   * and {@link ScheduleEntity.withTarget} with a single `now` so one
   * logical patch produces exactly one `updatedAt` stamp.
   *
   * When `args.expectedKind` is provided, throws
   * {@link ScheduleKindMismatchError} on disagreement with the
   * loaded entity's kind. Kind-discriminated route handlers (e.g.
   * `PATCH /task/:sid`) use this to project the mismatch to a 404
   * envelope without leaking the actual kind.
   *
   * Target patch flow: `handler.mergePatch(existing.data, patch)`
   * (sync, pure) produces the merged data + `changedKeys`; then
   * `handler.validate(merged, { changedKeys })` re-validates so the
   * handler can skip expensive cross-checks whose inputs didn't
   * change (e.g. catalog lookup when only `brief` changed).
   *
   * Re-arms the timer ONLY when `trigger` or `enabled` actually
   * changed. Target-only patches do NOT re-arm (mirrors current
   * behaviour — the next-fire schedule is independent of payload).
   */
  async patch(id: string, args: PatchScheduleArgs): Promise<Schedule> {
    const existing = await this.repo.read(id);
    if (existing === null) throw new ScheduleNotFoundError(id);
    if (args.expectedKind !== undefined && existing.target.kind !== args.expectedKind) {
      throw new ScheduleKindMismatchError(id, args.expectedKind, existing.target.kind);
    }
    const handler = this.handlerFor(existing.target.kind);

    const now = this.now();
    let patched = existing;
    const hasMetadata = args.name !== undefined || args.enabled !== undefined;
    if (hasMetadata) {
      patched = patched.withMetadata(
        {
          ...(args.name !== undefined ? { name: args.name } : {}),
          ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
        },
        now,
      );
    }
    if (args.trigger !== undefined) {
      patched = patched.withTrigger(args.trigger, now);
    }
    if (args.target !== undefined) {
      const { data: merged, changedKeys } = handler.mergePatch(
        existing.target.data,
        args.target.patch,
      );
      const validatedMerged = await handler.validate(merged, { changedKeys });
      patched = patched.withTarget({ kind: existing.target.kind, data: validatedMerged }, now);
    }

    const triggerChanged = args.trigger !== undefined;
    const enabledChanged = args.enabled !== undefined && args.enabled !== existing.enabled;

    if (triggerChanged || enabledChanged) {
      this.cancelTimer(id);
      // `withNextFireAt` is deliberately outside the single-`now` /
      // single-`updatedAt` invariant above: re-arming is internal
      // scheduler state, not a user-visible edit, so it must not
      // re-stamp `updatedAt`.
      if (patched.enabled) {
        const [nextIso] = nextRuns(patched.trigger.expr, patched.trigger.tz, now, 1);
        patched = patched.withNextFireAt(nextIso);
      } else {
        patched = patched.withNextFireAt(undefined);
      }
    }

    await this.repo.update(patched);

    if (patched.enabled && (triggerChanged || enabledChanged)) {
      this.armNext(patched);
    }
    return patched.toDto();
  }

  /**
   * Cascade-delete the schedule along with every TERMINAL unit-of-
   * work it has fired (via the registered handler's
   * `deleteForSchedule`). In-flight protection is two-layered: the
   * pre-flight `hasInFlightForSchedule` guard rejects the delete
   * with {@link ScheduleHasInFlightError} if a dispatch is currently
   * running, and the cascade itself filters to terminal status only
   * (handler-side invariant) so a racing dispatch is never destroyed.
   *
   * Ordering: cancel the timer FIRST (so the croner clock can't
   * dispatch another unit while we cascade), THEN cascade historical
   * units, THEN re-check `hasInFlightForSchedule` (TOCTOU defence
   * against a racing manual `run()`), THEN delete the schedule row.
   */
  async delete(id: string): Promise<{ readonly deletedDispatchCount: number }> {
    const existing = await this.repo.read(id);
    if (existing === null) throw new ScheduleNotFoundError(id);
    if (existing.enabled) throw new ScheduleEnabledError(id);
    const handler = this.handlerFor(existing.target.kind);
    if (await handler.hasInFlightForSchedule(id)) {
      throw new ScheduleHasInFlightError(id);
    }
    this.cancelTimer(id);
    const { deletedCount } = await handler.deleteForSchedule(id);
    if (await handler.hasInFlightForSchedule(id)) {
      // TOCTOU: a concurrent manual `run()` slipped a fresh
      // dispatch in between our original check and the cascade.
      // The cascade's terminal-only filter left it alone; refuse
      // the schedule delete so the user never observes an orphan
      // dispatch pointing at a dead schedule.
      throw new ScheduleHasInFlightError(id);
    }
    await this.repo.delete(id);
    return { deletedDispatchCount: deletedCount };
  }

  /**
   * Manual fire — bypasses the `enabled` gate and the concurrency
   * check. Records `last_fired_at` and recomputes `next_fire_at`
   * (does NOT re-arm; the existing timer continues independently).
   * Returns the handler's substrate-side `id` as `dispatchId`.
   */
  async run(id: string): Promise<{ readonly dispatchId: string }> {
    const entity = await this.repo.read(id);
    if (entity === null) throw new ScheduleNotFoundError(id);
    const firedAt = this.now().toISOString();
    const dispatchId = await this.dispatch(entity, firedAt);
    const [nextIso] = nextRuns(entity.trigger.expr, entity.trigger.tz, this.now(), 1);
    await this.repo.recordFired(id, firedAt, nextIso ?? null);
    return { dispatchId };
  }

  /**
   * Compute the next `n` fires for `expr` in `tz` plus a
   * human-readable description. `n` is bounded to `[1, 100]` to
   * avoid O(n) explosion if a caller passes an unbounded value.
   */
  async preview(expr: string, tz: string, n = 3): Promise<PreviewResult> {
    assertValidCronExpr(expr);
    assertValidTimezone(tz);
    if (!Number.isInteger(n) || n < 1 || n > 100) {
      throw new ScheduleError(`preview n must be an integer in [1, 100], got ${n}`);
    }
    const describe = describeCron(expr);
    const nextRunsArr = nextRuns(expr, tz, this.now(), n);
    return { describe, nextRuns: nextRunsArr };
  }

  // ─── Lifecycle ────────────────────────────────────────────

  /**
   * Boot-time recovery. Freezes the registry on first call (so
   * subsequent `registerKind` throws), preflights every row's
   * `target_kind` against the registry (any unregistered kind on a
   * row — enabled or disabled — throws
   * {@link ScheduleKindNotRegisteredError} naming the kind + the
   * register-before-recover requirement), then for every enabled
   * schedule:
   *
   *   - if `next_fire_at` is in the past → catchup-fire EXACTLY
   *     ONCE with `firedAt` set to the planned (past) time, then
   *     re-arm the next tick from `now`. Multiple missed fires
   *     collapse into one — the user only sees one catchup unit
   *     per schedule per outage.
   *   - if `next_fire_at` is in the future (or unset) → just arm.
   *
   * Disabled schedules are skipped after the preflight check.
   *
   * Idempotent: repeated calls after the first return immediately
   * (the registry stays frozen; no double-arming).
   *
   * **On preflight failure, the registry remains frozen.** The only
   * correct recovery path is to dispose this service via
   * `composeScheduleModule().close()` and rebuild. Calling
   * `registerKind()` after a failed `recover()` will throw
   * `ScheduleKindRegistryFrozenError`; calling `recover()` again
   * will return immediately without re-running preflight. Freeze-
   * before-preflight prevents registry mutation while recovery is
   * verifying persisted rows and arming timers — callers must
   * complete all `registerKind()` calls BEFORE `recover()` starts.
   * Canonical wiring at `packages/core/src/workspace-context.ts:309-313`
   * handles this correctly by running `teardown()` on any error and
   * rebuilding from scratch.
   */
  async recover(): Promise<void> {
    if (this.registryFrozen) return;
    this.registryFrozen = true;
    // Preflight: every row's kind must be registered. We project
    // just (id, targetKind) so a workspace with thousands of
    // disabled rows doesn't pull every blob into memory.
    const preflightRows = await this.repo.allRowsForPreflight();
    for (const row of preflightRows) {
      if (!this.handlers.has(row.targetKind)) {
        throw new ScheduleKindNotRegisteredError(
          row.targetKind,
          `Schedule row "${row.id}" has target_kind="${row.targetKind}" but no handler is registered. Call service.registerKind("${row.targetKind}", handler) at compose time before service.recover().`,
        );
      }
    }
    this.shutdownCalled = false;
    const all = await this.repo.list();
    const now = this.now();
    for (const entity of all) {
      if (!entity.enabled) continue;
      if (
        entity.nextFireAt !== undefined &&
        new Date(entity.nextFireAt).getTime() <= now.getTime()
      ) {
        const plannedFiredAt = entity.nextFireAt;
        try {
          await this.dispatch(entity, plannedFiredAt);
        } catch (err) {
          this.logger.warn(
            { scheduleId: entity.id, err },
            "schedule recover: catchup dispatch failed",
          );
        }
        const [nextIso] = nextRuns(entity.trigger.expr, entity.trigger.tz, now, 1);
        await this.repo.recordFired(entity.id, plannedFiredAt, nextIso ?? null);
      }
      const fresh = await this.repo.read(entity.id);
      if (fresh?.enabled) this.armNext(fresh);
    }
  }

  async shutdown(): Promise<void> {
    this.shutdownCalled = true;
    for (const handle of this.timers.values()) {
      clearTimeout(handle);
    }
    this.timers.clear();
  }

  // ─── Internals ────────────────────────────────────────────

  private armNext(entity: ScheduleEntity): void {
    if (this.shutdownCalled) return;
    if (!entity.enabled) return;
    const [iso] = nextRuns(entity.trigger.expr, entity.trigger.tz, this.now(), 1);
    if (iso === undefined) return;
    const delay = Math.max(0, new Date(iso).getTime() - this.now().getTime());
    const id = entity.id;
    const handle = setTimeout(() => {
      void this.fire(id);
    }, delay);
    this.timers.set(id, handle);
  }

  /**
   * Tick handler. Re-reads the latest entity (the in-flight one may
   * have been patched while sleeping); runs the concurrency check
   * via the kind handler; dispatches; records the fire; re-arms.
   */
  private async fire(id: string): Promise<void> {
    this.timers.delete(id);
    if (this.shutdownCalled) return;
    const entity = await this.repo.read(id);
    if (entity === null || !entity.enabled) return;
    const handler = this.handlerFor(entity.target.kind);
    if (await handler.hasInFlightForSchedule(entity.id)) {
      this.logger.warn(
        { scheduleId: entity.id },
        "schedule fire skipped (previous dispatch still running)",
      );
      this.armNext(entity);
      return;
    }
    const firedAt = this.now().toISOString();
    try {
      await this.dispatch(entity, firedAt);
    } catch (err) {
      this.logger.warn({ scheduleId: entity.id, err }, "schedule fire: dispatch failed");
      // Per RFC: no failure retry — record the fire and re-arm.
    }
    const [nextIso] = nextRuns(entity.trigger.expr, entity.trigger.tz, this.now(), 1);
    await this.repo.recordFired(entity.id, firedAt, nextIso ?? null);
    this.armNext(entity);
  }

  /**
   * Route the fire through the registered handler. Trusts the
   * envelope's `data` (validated at create / patch time — see
   * `parseTargetRow` in schedule-entity.ts for why reads are
   * trusted).
   */
  private async dispatch(entity: ScheduleEntity, firedAt: string): Promise<string> {
    const handler = this.handlerFor(entity.target.kind);
    const { id: dispatchId } = await handler.dispatch({
      scheduleId: entity.id,
      firedAt,
      data: entity.target.data,
    });
    return dispatchId;
  }

  private cancelTimer(id: string): void {
    const handle = this.timers.get(id);
    if (handle !== undefined) {
      clearTimeout(handle);
      this.timers.delete(id);
    }
  }
}
