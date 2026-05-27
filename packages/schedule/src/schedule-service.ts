import pino, { type Logger } from "pino";
import { assertValidCronExpr, assertValidTimezone, describeCron, nextRuns } from "./cron.js";
import {
  AgentNotFoundError,
  ScheduleEnabledError,
  ScheduleHasInFlightError,
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
 *   - `patch(trigger.*)` re-arms; `patch(target.*)` does not
 *   - `patch(enabled: …)` re-arms or cancels accordingly
 *
 * None of these are user-configurable in v1.
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
   * Create a new schedule. Validates id, cron + tz, target shape,
   * and (async) agent existence via the injected `agentValidator`.
   *
   * Note: the service does NOT default `trigger.tz` — callers (PR 3
   * REST layer) must supply it. The user-facing default is `"UTC"`
   * (passed in by the REST layer when the user didn't pick one).
   *
   * Computes `next_fire_at` immediately so the list endpoint's
   * ORDER BY can sort the freshly-created row alongside the rest;
   * arms the timer when `enabled === true`.
   */
  async create(args: CreateScheduleArgs): Promise<Schedule> {
    if (args.target.kind === "task") {
      await this.assertAgentExists(args.target.agent);
    }
    const id = this.randomUUID();
    const now = this.now();
    let entity = ScheduleEntity.create(args, { id, now });
    if (entity.enabled) {
      const [nextIso] = nextRuns(entity.trigger.expr, entity.trigger.tz, now, 1);
      entity = entity.withNextFireAt(nextIso);
    }
    await this.repo.insert(entity);
    if (entity.enabled) this.armNext(entity);
    return entity.toDto();
  }

  async patch(id: string, args: PatchScheduleArgs): Promise<Schedule> {
    const existing = await this.repo.read(id);
    if (existing === null) throw new ScheduleNotFoundError(id);
    if (args.target?.kind === "task") {
      await this.assertAgentExists(args.target.agent);
    }
    let patched = existing.withPatched(args, this.now());
    const triggerChanged = args.trigger !== undefined;
    const enabledChanged = args.enabled !== undefined && args.enabled !== existing.enabled;

    if (triggerChanged || enabledChanged) {
      this.cancelTimer(id);
      if (patched.enabled) {
        const [nextIso] = nextRuns(patched.trigger.expr, patched.trigger.tz, this.now(), 1);
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

  async delete(id: string): Promise<void> {
    const existing = await this.repo.read(id);
    if (existing === null) throw new ScheduleNotFoundError(id);
    if (existing.enabled) throw new ScheduleEnabledError(id);
    if (await this.taskDispatcher.hasInFlightForSchedule(id)) {
      throw new ScheduleHasInFlightError(id);
    }
    this.cancelTimer(id);
    await this.repo.delete(id);
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

  async preview(expr: string, tz: string): Promise<PreviewResult> {
    assertValidCronExpr(expr);
    assertValidTimezone(tz);
    const describe = describeCron(expr);
    const nextRunsArr = nextRuns(expr, tz, this.now(), 3);
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
      throw new AgentNotFoundError(agent, { cause: err });
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
          instructions: target.instructions,
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
