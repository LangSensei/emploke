import { assertValidCronExpr, assertValidTimezone } from "./cron.js";
import { ScheduleError } from "./errors.js";
import type { NewScheduleRow, ScheduleRow } from "./schema.js";
import type {
  CreateScheduleArgs,
  PatchScheduleArgs,
  Schedule,
  ScheduleTarget,
  ScheduleTrigger,
} from "./types.js";
import { assertValidScheduleId } from "./validate.js";

/**
 * Pure value-object representation of one schedule. Repository
 * returns this; service maps it to the wire `Schedule` DTO.
 *
 * Invariants enforced (synchronously) at construction and on every
 * `withPatched`:
 *
 *   1. `id` matches `SCHEDULE_ID_RE` (UUID v4).
 *   2. `trigger.kind === 'cron'` → 5-field expression + valid IANA tz.
 *   3. `target.kind === 'task'` → non-empty `agent` + non-empty
 *      `instructions`.
 *   4. `targetAgent` denormalised column is set iff `target.kind === 'task'`.
 *
 * Agent existence is NOT an entity invariant — it requires async
 * catalog lookup, so it lives in {@link ScheduleService}.
 *
 * Not re-exported from `index.ts`: external consumers see only the
 * `Schedule` DTO. The entity is the contract between the repository
 * and the service inside this pkg.
 */
export class ScheduleEntity {
  private constructor(
    readonly id: string,
    readonly name: string,
    readonly trigger: ScheduleTrigger,
    readonly target: ScheduleTarget,
    readonly enabled: boolean,
    readonly createdAt: string,
    readonly updatedAt: string,
    readonly lastFiredAt: string | undefined,
    readonly nextFireAt: string | undefined,
  ) {}

  static create(
    args: CreateScheduleArgs,
    opts: { readonly id: string; readonly now: Date },
  ): ScheduleEntity {
    assertValidScheduleId(opts.id);
    assertValidName(args.name);
    assertValidTrigger(args.trigger);
    assertValidTarget(args.target);
    const nowIso = opts.now.toISOString();
    return new ScheduleEntity(
      opts.id,
      args.name,
      args.trigger,
      args.target,
      args.enabled ?? true,
      nowIso,
      nowIso,
      undefined,
      undefined,
    );
  }

  /** Hydrate from a Drizzle row (parses `target_json`, narrows kinds). */
  static fromStored(row: ScheduleRow): ScheduleEntity {
    assertValidScheduleId(row.id);
    const trigger: ScheduleTrigger = parseTriggerRow(row);
    const target: ScheduleTarget = parseTargetRow(row);
    // Defense-in-depth: re-assert the denormalised column matches the JSON.
    if (target.kind === "task" && row.targetAgent !== target.agent) {
      throw new ScheduleError(
        `Schedule "${row.id}" corrupted: target_agent="${row.targetAgent}" does not match target_json.agent="${target.agent}"`,
      );
    }
    return new ScheduleEntity(
      row.id,
      row.name,
      trigger,
      target,
      row.enabled,
      row.createdAt,
      row.updatedAt,
      row.lastFiredAt ?? undefined,
      row.nextFireAt ?? undefined,
    );
  }

  /** Wire-shape projection. */
  toDto(): Schedule {
    return {
      id: this.id,
      name: this.name,
      trigger: this.trigger,
      target: this.target,
      enabled: this.enabled,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      ...(this.lastFiredAt !== undefined ? { lastFiredAt: this.lastFiredAt } : {}),
      ...(this.nextFireAt !== undefined ? { nextFireAt: this.nextFireAt } : {}),
    };
  }

  /** Project to a Drizzle row for the repository. */
  toRow(): NewScheduleRow {
    const targetAgent = this.target.kind === "task" ? this.target.agent : null;
    return {
      id: this.id,
      name: this.name,
      triggerKind: this.trigger.kind,
      triggerExpr: this.trigger.expr,
      triggerTz: this.trigger.tz,
      targetKind: this.target.kind,
      targetJson: JSON.stringify(this.target),
      targetAgent,
      enabled: this.enabled,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      lastFiredAt: this.lastFiredAt ?? null,
      nextFireAt: this.nextFireAt ?? null,
    };
  }

  /**
   * Apply a patch and stamp `updatedAt`. Returns a new entity (no
   * in-place mutation). Re-validates every changed field.
   */
  withPatched(patch: PatchScheduleArgs, now: Date): ScheduleEntity {
    const name = patch.name !== undefined ? patch.name : this.name;
    if (patch.name !== undefined) assertValidName(name);
    const trigger = patch.trigger !== undefined ? patch.trigger : this.trigger;
    if (patch.trigger !== undefined) assertValidTrigger(trigger);
    const target = patch.target !== undefined ? patch.target : this.target;
    if (patch.target !== undefined) assertValidTarget(target);
    const enabled = patch.enabled !== undefined ? patch.enabled : this.enabled;
    return new ScheduleEntity(
      this.id,
      name,
      trigger,
      target,
      enabled,
      this.createdAt,
      now.toISOString(),
      this.lastFiredAt,
      this.nextFireAt,
    );
  }

  /** Record a fire — does not stamp `updatedAt` (firing is not a user edit). */
  withFired(firedAt: string, nextFireAt: string | undefined): ScheduleEntity {
    return new ScheduleEntity(
      this.id,
      this.name,
      this.trigger,
      this.target,
      this.enabled,
      this.createdAt,
      this.updatedAt,
      firedAt,
      nextFireAt,
    );
  }

  /**
   * Set or clear `nextFireAt` without touching `lastFiredAt`. Used by
   * `ScheduleService.create` (pre-arm with no prior fire) and
   * `ScheduleService.patch` (trigger / enabled change recomputes the
   * next fire without faking a fire).
   */
  withNextFireAt(nextFireAt: string | undefined): ScheduleEntity {
    return new ScheduleEntity(
      this.id,
      this.name,
      this.trigger,
      this.target,
      this.enabled,
      this.createdAt,
      this.updatedAt,
      this.lastFiredAt,
      nextFireAt,
    );
  }
}

function assertValidName(name: string): void {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new ScheduleError(`Schedule name must be a non-empty string`);
  }
}

function assertValidTrigger(trigger: ScheduleTrigger): void {
  if (trigger === null || typeof trigger !== "object") {
    throw new ScheduleError("Schedule trigger must be an object");
  }
  switch (trigger.kind) {
    case "cron":
      assertValidCronExpr(trigger.expr);
      assertValidTimezone(trigger.tz);
      return;
    default: {
      const _exhaustive: never = trigger.kind;
      throw new ScheduleError(`Unknown trigger kind: ${String(_exhaustive)}`);
    }
  }
}

function assertValidTarget(target: ScheduleTarget): void {
  if (target === null || typeof target !== "object") {
    throw new ScheduleError("Schedule target must be an object");
  }
  switch (target.kind) {
    case "task": {
      if (typeof target.agent !== "string" || target.agent.trim().length === 0) {
        throw new ScheduleError("Task target requires non-empty agent");
      }
      if (typeof target.instructions !== "string" || target.instructions.trim().length === 0) {
        throw new ScheduleError("Task target requires non-empty instructions");
      }
      if (
        target.runtime !== undefined &&
        (typeof target.runtime !== "string" || target.runtime.trim().length === 0)
      ) {
        throw new ScheduleError("Task target runtime, when set, must be a non-empty string");
      }
      return;
    }
    default: {
      const _exhaustive: never = target.kind;
      throw new ScheduleError(`Unknown target kind: ${String(_exhaustive)}`);
    }
  }
}

function parseTriggerRow(row: ScheduleRow): ScheduleTrigger {
  switch (row.triggerKind) {
    case "cron":
      return { kind: "cron", expr: row.triggerExpr, tz: row.triggerTz };
    default:
      throw new ScheduleError(
        `Schedule "${row.id}" corrupted: unknown trigger_kind="${row.triggerKind}"`,
      );
  }
}

function parseTargetRow(row: ScheduleRow): ScheduleTarget {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.targetJson);
  } catch (err) {
    throw new ScheduleError(
      `Schedule "${row.id}" corrupted: target_json is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ScheduleError(`Schedule "${row.id}" corrupted: target_json must decode to an object`);
  }
  const obj = parsed as Record<string, unknown>;
  switch (row.targetKind) {
    case "task": {
      const agent = obj.agent;
      const instructions = obj.instructions;
      const runtime = obj.runtime;
      if (typeof agent !== "string" || agent.length === 0) {
        throw new ScheduleError(`Schedule "${row.id}" corrupted: target_json.agent missing`);
      }
      if (typeof instructions !== "string" || instructions.length === 0) {
        throw new ScheduleError(`Schedule "${row.id}" corrupted: target_json.instructions missing`);
      }
      const target: ScheduleTarget = {
        kind: "task",
        agent,
        instructions,
        ...(runtime !== undefined ? { runtime: runtime as string } : {}),
      };
      return target;
    }
    default:
      throw new ScheduleError(
        `Schedule "${row.id}" corrupted: unknown target_kind="${row.targetKind}"`,
      );
  }
}
