import pino, { type Logger } from "pino";
import { assertValidCronExpr, assertValidTimezone, describeCron, nextRuns } from "./cron.js";
import {
  AgentNotFoundError,
  AgentResolutionFailedError,
  ScheduleEnabledError,
  ScheduleError,
  ScheduleHasInFlightError,
  ScheduleKindMismatchError,
  ScheduleNotFoundError,
} from "./errors.js";
import { ScheduleEntity } from "./schedule-entity.js";
import type { ScheduleRepository } from "./schedule-repository.js";
import type {
  CreateTaskScheduleArgs,
  ListScheduleOpts,
  PatchTaskScheduleArgs,
  PreviewResult,
  Schedule,
  TaskDispatcher,
} from "./types.js";
import { generateScheduleId } from "./validate.js";

const silentLogger: Logger = pino({ level: "silent" });

interface ScheduleServiceOpts {
  readonly repo: ScheduleRepository;
  readonly taskDispatcher: TaskDispatcher;
  readonly agentValidator: (fqn: string) => Promise<void>;
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
 *
 * Behaviour locks per RFC §"Behaviour decisions":
 *
 *   - concurrency = 1 (skip-and-warn on overlap, no `last_fired_at`
 *     write on a skip)
 *   - catchup-once on boot (uses planned `firedAt`, not `now`)
 *   - no failure retry (referee never observes task outcome)
 *   - hard delete; requires `enabled=false` + no in-flight
 *   - manual `run` bypasses the enabled check
 *   - `patchTask(trigger.*)` re-arms; `patchTask(target.*)` does not
 *   - `patchTask(enabled: …)` re-arms or cancels accordingly
 *
 * None of these are user-configurable in v1.
 *
 * ## Kind-discriminated mutations
 *
 * `createTask` / `patchTask` are the v1 mutation entry points; they
 * correspond 1:1 to `POST /schedules/task` and
 * `PATCH /schedules/task/:sid`. When `target.kind = "workflow"` lands
 * later, it will get its own `createWorkflow` / `patchWorkflow`
 * methods (plus matching URL-discriminated routes); reads stay
 * polymorphic.
 */
export class ScheduleService {
  private readonly repo: ScheduleRepository;
  private readonly taskDispatcher: TaskDispatcher;
  private readonly agentValidator: (fqn: string) => Promise<void>;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly randomUUID: () => string;
  private readonly timers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private shutdownCalled = false;

  constructor(opts: ScheduleServiceOpts) {
    this.repo = opts.repo;
    this.taskDispatcher = opts.taskDispatcher;
    this.agentValidator = opts.agentValidator;
    this.logger = opts.logger ?? silentLogger;
    this.now = opts.now ?? (() => new Date());
    this.randomUUID = opts.randomUUID ?? (() => generateScheduleId());
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
   * Create a new task-kind schedule. Validates id, cron + tz, target
   * shape synchronously, then (async) agent existence via the injected
   * `agentValidator`. The synchronous-first ordering means an invalid
   * target shape (empty agent / brief, etc.) surfaces a schedule
   * validation error rather than a misleading agent-existence error.
   *
   * Note: the service does NOT default `trigger.tz` — callers (REST
   * layer) must supply it. The user-facing default is `"UTC"` (passed
   * in by the REST layer when the user didn't pick one).
   *
   * Computes `next_fire_at` immediately so the list endpoint's
   * ORDER BY can sort the freshly-created row alongside the rest;
   * arms the timer when `enabled === true`.
   */
  async createTask(args: CreateTaskScheduleArgs): Promise<Schedule> {
    const id = this.randomUUID();
    const now = this.now();
    // Synchronous shape validation first; only then the async agent lookup.
    // An invalid target shape surfaces as a ScheduleError rather than a
    // misleading AgentNotFoundError.
    let entity = ScheduleEntity.create(args, { id, now });
    await this.assertAgentExists(args.target.agent);
    if (entity.enabled) {
      const [nextIso] = nextRuns(entity.trigger.expr, entity.trigger.tz, now, 1);
      entity = entity.withNextFireAt(nextIso);
    }
    await this.repo.insert(entity);
    if (entity.enabled) this.armNext(entity);
    return entity.toDto();
  }

  /**
   * Patch a task-kind schedule. Composes
   * {@link ScheduleEntity.withMetadata}, {@link ScheduleEntity.withTrigger}
   * and {@link ScheduleEntity.withTaskTarget} with a single `now` so
   * one logical patch produces exactly one `updatedAt` stamp.
   *
   * Maps an existing schedule whose `target.kind !== "task"` to
   * `ScheduleKindMismatchError` — the route layer projects that to a
   * standard 404 so the wire shape does not leak the actual kind.
   *
   * `agentValidator` is invoked only when the patch supplies a new
   * `target.agent`, and only after the entity-side shape validation
   * has succeeded (so a malformed agent never reaches the async
   * lookup as an "agent not found" 404).
   */
  async patchTask(id: string, args: PatchTaskScheduleArgs): Promise<Schedule> {
    const existing = await this.repo.read(id);
    if (existing === null) throw new ScheduleNotFoundError(id);
    if (existing.target.kind !== "task") {
      throw new ScheduleKindMismatchError(id, "task", existing.target.kind);
    }

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
      patched = patched.withTaskTarget(args.target, now);
    }

    // Async agent existence lookup runs only when the patch supplied a
    // new agent string, and only after the entity-side validation
    // above accepted the merged shape.
    if (args.target?.agent !== undefined) {
      await this.assertAgentExists(args.target.agent);
    }

    const triggerChanged = args.trigger !== undefined;
    const enabledChanged = args.enabled !== undefined && args.enabled !== existing.enabled;

    if (triggerChanged || enabledChanged) {
      this.cancelTimer(id);
      // `withNextFireAt` is deliberately outside the single-`now` /
      // single-`updatedAt` invariant above: re-arming is internal
      // scheduler state, not a user-visible edit, so it must not
      // re-stamp `updatedAt`. The method intentionally takes no `now`.
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
   * Cascade-delete the schedule along with every TERMINAL task it has
   * fired. In-flight tasks are protected by two layers: (1) the
   * pre-flight `hasInFlightForSchedule` guard rejects the delete with
   * `ScheduleHasInFlightError` if a task is currently running, and (2)
   * the cascade itself filters to terminal status only — even if
   * something raced past the guard, it would be skipped, not destroyed.
   *
   * Ordering matters. We cancel the timer FIRST (so the croner clock
   * can't dispatch another task while we cascade), then cascade
   * historical tasks, then re-check `hasInFlightForSchedule` (defence
   * against a racing manual `ScheduleService.run` that inserted a
   * fresh running task between the original check and the cascade),
   * then delete the schedule row.
   *
   * Failure modes (cross-table atomicity is impossible because the
   * task and schedule modules each hold their own better-sqlite3
   * connection to `workspace.db`):
   *   - cascade throws: schedule row remains. Caller can retry; the
   *     cascade is idempotent (already-deleted rows no-op).
   *   - re-check finds new in-flight: throws ScheduleHasInFlightError;
   *     schedule remains. Already-cascaded historical tasks are
   *     gone (acceptable — the user committed to deletion).
   *   - repo.delete throws after a successful cascade: schedule
   *     remains, tasks gone. Retry succeeds (cascade no-ops, schedule
   *     deletes). Net result is identical to a clean first attempt.
   */
  async delete(id: string): Promise<{ readonly deletedTaskCount: number }> {
    const existing = await this.repo.read(id);
    if (existing === null) throw new ScheduleNotFoundError(id);
    if (existing.enabled) throw new ScheduleEnabledError(id);
    if (await this.taskDispatcher.hasInFlightForSchedule(id)) {
      throw new ScheduleHasInFlightError(id);
    }
    this.cancelTimer(id);
    const { deletedCount } = await this.taskDispatcher.deleteForSchedule(id);
    if (await this.taskDispatcher.hasInFlightForSchedule(id)) {
      // TOCTOU: a concurrent manual `run()` slipped a fresh task in
      // between our original check and the cascade. The cascade's
      // terminal-only filter left it alone; refuse the schedule delete
      // so the user can never observe an orphan task pointing at a
      // dead schedule.
      throw new ScheduleHasInFlightError(id);
    }
    await this.repo.delete(id);
    return { deletedTaskCount: deletedCount };
  }

  /**
   * Manual fire — bypasses the `enabled` gate and the concurrency
   * check. Records `last_fired_at` and recomputes `next_fire_at`
   * (does NOT re-arm; the existing timer continues independently).
   */
  async run(id: string): Promise<{ readonly taskId: string }> {
    const entity = await this.repo.read(id);
    if (entity === null) throw new ScheduleNotFoundError(id);
    const firedAt = this.now().toISOString();
    const taskId = await this.dispatch(entity, firedAt);
    const [nextIso] = nextRuns(entity.trigger.expr, entity.trigger.tz, this.now(), 1);
    await this.repo.recordFired(id, firedAt, nextIso ?? null);
    return { taskId };
  }

  /**
   * Compute the next `n` fires for `expr` in `tz` plus a human-readable
   * description. `n` is optional and defaults to 3 (the legacy v1
   * fixed count) so existing 2-arg call sites keep working unchanged.
   *
   * `n` is bounded to `[1, 100]` to avoid O(n) explosion if a caller
   * (route layer, JSON-RPC manifest, future programmatic user) passes
   * an unbounded value. The route's `?n=` query enforces the same
   * range, so callers see the typed `ScheduleError` envelope before
   * they reach the cron engine.
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
   * Boot-time recovery. For every enabled schedule:
   *
   *   - if `next_fire_at` is in the past → catchup-fire EXACTLY ONCE
   *     with `firedAt` set to the planned (past) time, then re-arm
   *     the next tick from `now`. Multiple missed fires collapse
   *     into one — the user only sees one catchup task per schedule
   *     per outage.
   *   - if `next_fire_at` is in the future (or unset) → just arm.
   *
   * Disabled schedules are skipped entirely.
   */
  async recover(): Promise<void> {
    this.shutdownCalled = false;
    const all = await this.repo.list();
    const now = this.now();
    for (const entity of all) {
      if (!entity.enabled) continue;
      if (
        entity.nextFireAt !== undefined &&
        new Date(entity.nextFireAt).getTime() <= now.getTime()
      ) {
        // Catchup once with the planned (past) firedAt.
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
      // Re-read in case recordFired updated next_fire_at; cheap.
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

  private async assertAgentExists(agent: string): Promise<void> {
    try {
      await this.agentValidator(agent);
    } catch (err) {
      // The schedule-agent-validator (packages/core/src/wiring/
      // schedule-agent-validator.ts) throws schedule's own
      // `AgentNotFoundError` on null catalog lookup. Anything else
      // from the validator is a catalog-system fault.
      if (err instanceof AgentNotFoundError) throw err;
      throw new AgentResolutionFailedError(agent, { cause: err });
    }
  }

  private armNext(entity: ScheduleEntity): void {
    if (this.shutdownCalled) return;
    if (!entity.enabled) return;
    const [iso] = nextRuns(entity.trigger.expr, entity.trigger.tz, this.now(), 1);
    if (iso === undefined) return; // cron exhausted (shouldn't happen for standard exprs)
    const delay = Math.max(0, new Date(iso).getTime() - this.now().getTime());
    const id = entity.id;
    const handle = setTimeout(() => {
      void this.fire(id);
    }, delay);
    this.timers.set(id, handle);
  }

  /**
   * Tick handler. Re-reads the latest entity (the in-flight one may
   * have been patched while sleeping); runs the concurrency check;
   * dispatches via the discriminated switch on `target.kind`;
   * records the fire; re-arms.
   */
  private async fire(id: string): Promise<void> {
    this.timers.delete(id);
    if (this.shutdownCalled) return;
    const entity = await this.repo.read(id);
    if (entity === null || !entity.enabled) return;
    if (await this.taskDispatcher.hasInFlightForSchedule(entity.id)) {
      this.logger.warn(
        { scheduleId: entity.id },
        "schedule fire skipped (previous task still running)",
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
   * Dispatch via the discriminated switch on `target.kind`. The
   * `never` assertion in the default branch enforces exhaustiveness
   * — v1 has only `"task"`, but the future `"workflow"` branch is
   * the whole reason discriminated unions are there from day 1.
   */
  private async dispatch(entity: ScheduleEntity, firedAt: string): Promise<string> {
    const target = entity.target;
    switch (target.kind) {
      case "task": {
        const result = await this.taskDispatcher.dispatch({
          agent: target.agent,
          brief: target.brief,
          ...(target.details !== undefined ? { details: target.details } : {}),
          ...(target.runtime !== undefined ? { runtime: target.runtime } : {}),
          origin: "schedule",
          metadata: { scheduleId: entity.id, firedAt },
        });
        return result.id;
      }
      default: {
        const _exhaustive: never = target.kind;
        throw new Error(`Unknown target kind: ${String(_exhaustive)}`);
      }
    }
  }

  private cancelTimer(id: string): void {
    const handle = this.timers.get(id);
    if (handle !== undefined) {
      clearTimeout(handle);
      this.timers.delete(id);
    }
  }
}
