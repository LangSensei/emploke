import { assertValidCronExpr, assertValidTimezone } from "./cron.js";
import { ScheduleError } from "./errors.js";
import type { NewScheduleRow, ScheduleRow } from "./schema.js";
import type {
  CreateTaskScheduleArgs,
  Schedule,
  ScheduleTarget,
  ScheduleTrigger,
  TaskScheduleTarget,
  TaskTargetPatch,
} from "./types.js";
import { assertValidScheduleId } from "./validate.js";

/**
 * Pure value-object representation of one schedule. Repository
 * returns this; service maps it to the wire `Schedule` DTO.
 *
 * Invariants enforced (synchronously) at construction and on every
 * `with*` mutation:
 *
 *   1. `id` matches `SCHEDULE_ID_RE` (UUID v4).
 *   2. `trigger.kind === 'cron'` → 5-field expression + valid IANA tz.
 *   3. `target.kind === 'task'` → non-empty `agent`; `brief` is a
 *      non-empty single-line string ≤ 200 chars; `details?` if set
 *      must be a string (empty string allowed, mirroring `@emploke/task`).
 *
 * Agent existence is NOT an entity invariant — it requires async
 * catalog lookup, so it lives in {@link ScheduleService}.
 *
 * ## Mutation API
 *
 * Three composable methods split the old `withPatched`:
 *
 *   - {@link withMetadata} — scalar set of `name` / `enabled`.
 *   - {@link withTrigger}  — atomic replace of the whole trigger object.
 *   - {@link withTaskTarget} — RFC 7396 deep merge of the target's
 *     flat record (only valid when the current entity has
 *     `target.kind === "task"`); `null` on optional `details` /
 *     `runtime` deletes the field.
 *
 * The service composes the three in order with a single `now`
 * timestamp so one logical patch produces exactly one `updatedAt`
 * stamp.
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
    args: CreateTaskScheduleArgs,
    opts: { readonly id: string; readonly now: Date },
  ): ScheduleEntity {
    assertValidScheduleId(opts.id);
    assertValidName(args.name);
    assertValidTrigger(args.trigger);
    const target: TaskScheduleTarget = { kind: "task", ...args.target };
    assertValidTarget(target);
    const nowIso = opts.now.toISOString();
    return new ScheduleEntity(
      opts.id,
      args.name,
      args.trigger,
      target,
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
    return {
      id: this.id,
      name: this.name,
      triggerKind: this.trigger.kind,
      triggerExpr: this.trigger.expr,
      triggerTz: this.trigger.tz,
      targetKind: this.target.kind,
      targetJson: JSON.stringify(this.target),
      enabled: this.enabled,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      lastFiredAt: this.lastFiredAt ?? null,
      nextFireAt: this.nextFireAt ?? null,
    };
  }

  /**
   * Scalar set of `name` / `enabled`. Either field is optional; an
   * empty patch is a no-op apart from the `updatedAt` stamp (callers
   * skip the call entirely when the slice is absent).
   */
  withMetadata(
    args: { readonly name?: string; readonly enabled?: boolean },
    now: Date,
  ): ScheduleEntity {
    const name = args.name !== undefined ? args.name : this.name;
    if (args.name !== undefined) assertValidName(name);
    const enabled = args.enabled !== undefined ? args.enabled : this.enabled;
    return new ScheduleEntity(
      this.id,
      name,
      this.trigger,
      this.target,
      enabled,
      this.createdAt,
      now.toISOString(),
      this.lastFiredAt,
      this.nextFireAt,
    );
  }

  /** Replace the trigger atomically. Re-validates the new value. */
  withTrigger(trigger: ScheduleTrigger, now: Date): ScheduleEntity {
    assertValidTrigger(trigger);
    return new ScheduleEntity(
      this.id,
      this.name,
      trigger,
      this.target,
      this.enabled,
      this.createdAt,
      now.toISOString(),
      this.lastFiredAt,
      this.nextFireAt,
    );
  }

  /**
   * RFC 7396 deep-merge a task target. The current entity must already
   * be a task; callers (service) guard this with
   * {@link ScheduleKindMismatchError}.
   *
   *   - `agent` / `brief` set if present (validation rejects empty).
   *   - `details` / `runtime` set if string; deleted if `null`; kept
   *     if absent.
   *
   * Re-validates the merged target via {@link assertValidTarget} so
   * trim + nonEmpty + brief-line / 200-char limits are enforced exactly
   * as on create.
   */
  withTaskTarget(patch: TaskTargetPatch, now: Date): ScheduleEntity {
    if (this.target.kind !== "task") {
      throw new ScheduleError(
        `Cannot apply task target patch to schedule "${this.id}" (target.kind="${this.target.kind}")`,
      );
    }
    const merged = mergeTaskTarget(this.target, patch);
    assertValidTarget(merged);
    return new ScheduleEntity(
      this.id,
      this.name,
      this.trigger,
      merged,
      this.enabled,
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
   * `ScheduleService.createTask` (pre-arm with no prior fire) and
   * `ScheduleService.patchTask` (trigger / enabled change recomputes
   * the next fire without faking a fire).
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

/**
 * Apply the RFC 7396 merge rules for a task target patch.
 *
 * `kind` is fixed — callers cannot change it via patch. `agent` and
 * `brief` may be set but not deleted (they are required-on-entity);
 * the route layer rejects `null` for these with a 400 before we get
 * here, but `assertValidTarget` is the entity-side belt-and-braces.
 *
 * `details` and `runtime` accept `string | null | undefined`:
 *   - string  → set
 *   - `null`  → delete the field on the merged record
 *   - absent  → keep existing
 */
function mergeTaskTarget(
  existing: TaskScheduleTarget,
  patch: TaskTargetPatch,
): TaskScheduleTarget {
  const agent = patch.agent !== undefined ? patch.agent : existing.agent;
  const brief = patch.brief !== undefined ? patch.brief : existing.brief;

  let details: string | undefined;
  if (patch.details === null) {
    details = undefined;
  } else if (patch.details !== undefined) {
    details = patch.details;
  } else {
    details = existing.details;
  }

  let runtime: string | undefined;
  if (patch.runtime === null) {
    runtime = undefined;
  } else if (patch.runtime !== undefined) {
    runtime = patch.runtime;
  } else {
    runtime = existing.runtime;
  }

  return {
    kind: "task",
    agent,
    brief,
    ...(details !== undefined ? { details } : {}),
    ...(runtime !== undefined ? { runtime } : {}),
  };
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
      // Brief mirrors `@emploke/task`'s assertValidBrief: non-empty
      // single-line string ≤ 200 chars.
      if (typeof target.brief !== "string" || target.brief.trim().length === 0) {
        throw new ScheduleError("Task target requires non-empty brief");
      }
      if (target.brief.includes("\n") || target.brief.includes("\r")) {
        throw new ScheduleError(
          "Task target brief must be a single line (no newline characters); pass long content via details",
        );
      }
      if (target.brief.trim().length > 200) {
        throw new ScheduleError("Task target brief must be 200 characters or fewer");
      }
      // Details is optional and unconstrained beyond `typeof string`
      // — empty string is allowed (mirrors `@emploke/task` exactly).
      if (target.details !== undefined && typeof target.details !== "string") {
        throw new ScheduleError("Task target details, when set, must be a string");
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
      const brief = obj.brief;
      const details = obj.details;
      const runtime = obj.runtime;
      if (typeof agent !== "string" || agent.length === 0) {
        throw new ScheduleError(`Schedule "${row.id}" corrupted: target_json.agent missing`);
      }
      // Fail-fast guard for pre-v2 (RFC #61 v2) rows that still carry
      // `instructions` instead of `brief`. Migration 0001 does not
      // rewrite target_json, so a local dev DB created before the
      // redesign would otherwise leak through as a cryptic
      // undefined-property error deep in the dispatch loop. No
      // production rows exist (pre-release).
      if (brief === undefined && obj.instructions !== undefined) {
        throw new ScheduleError(
          `Schedule "${row.id}" uses pre-v2 target shape (target_json carries "instructions", not "brief"). This row was created before RFC #61 v2; delete your local dev DB (typically under ~/.emploke/) and re-create the schedule, or hand-rewrite target_json from {instructions} to {brief, details?} via SQL.`,
        );
      }
      if (typeof brief !== "string" || brief.length === 0) {
        throw new ScheduleError(`Schedule "${row.id}" corrupted: target_json.brief missing`);
      }
      if (details !== undefined && typeof details !== "string") {
        throw new ScheduleError(
          `Schedule "${row.id}" corrupted: target_json.details, when set, must be a string`,
        );
      }
      const target: ScheduleTarget = {
        kind: "task",
        agent,
        brief,
        ...(details !== undefined ? { details } : {}),
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
