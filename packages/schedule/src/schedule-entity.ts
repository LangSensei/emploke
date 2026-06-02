import { assertValidName, assertValidTrigger } from "./_helpers.js";
import { ScheduleError } from "./errors.js";
import type { NewScheduleRow, ScheduleRow } from "./schema.js";
import type {
  CreateScheduleArgs,
  Schedule,
  ScheduleTargetEnvelope,
  ScheduleTrigger,
} from "./types.js";
import { assertValidScheduleId } from "./validate.js";

/**
 * Pure value-object representation of one schedule. Repository
 * returns this; service maps it to the wire `Schedule` DTO.
 *
 * The entity is a stupid container for the schedule envelope: it
 * stores `{ kind, data: unknown }` and does NOT introspect the data.
 * All kind-aware logic (shape validation, RFC 7396 merge, dispatch)
 * lives in the registered `ScheduleKindHandler`. The entity's
 * remaining invariants are kind-agnostic:
 *
 *   1. `id` matches the UUID v4 grammar (see `validate.ts`).
 *   2. `name` is a non-empty trimmed string.
 *   3. `trigger.kind === "cron"` → 5-field expression + valid IANA tz.
 *
 * Target-shape invariants and async cross-checks (e.g. agent existence
 * for the task kind) belong to the handler — `ScheduleService.create`
 * calls `handler.validate(args.target.data)` BEFORE constructing the
 * entity, so anything that lands here has already passed the handler's
 * shape check.
 *
 * ## Mutation API
 *
 *   - {@link withMetadata} — scalar set of `name` / `enabled`.
 *   - {@link withTrigger}  — atomic replace of the whole trigger object.
 *   - {@link withTarget}   — atomic replace of the whole envelope
 *     (service composes patch via `handler.mergePatch` +
 *     `handler.validate` BEFORE calling this; the entity does no
 *     deep-merge of its own).
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
    readonly target: ScheduleTargetEnvelope,
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
    // Target data is opaque here: the service called
    // `handler.validate(args.target.data)` and replaced `data` with
    // the validated value before constructing args, so the kind
    // handler already enforced its shape rules.
    const nowIso = opts.now.toISOString();
    return new ScheduleEntity(
      opts.id,
      args.name,
      args.trigger,
      { kind: args.target.kind, data: args.target.data },
      args.enabled ?? true,
      nowIso,
      nowIso,
      undefined,
      undefined,
    );
  }

  /** Hydrate from a Drizzle row (parses `target_json` opaquely). */
  static fromStored(row: ScheduleRow): ScheduleEntity {
    assertValidScheduleId(row.id);
    const trigger = parseTriggerRow(row);
    const target = parseTargetRow(row);
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

  /**
   * Project to a Drizzle row for the repository. `target_json` stores
   * the DATA payload only, not the full envelope — `kind` already
   * lives in its own column (`target_kind`). Double-encoding it
   * inside the JSON would make every read pay for redundant
   * parse/destructure and would silently allow a row whose
   * `target_kind` column disagreed with the JSON `kind` field.
   */
  toRow(): NewScheduleRow {
    return {
      id: this.id,
      name: this.name,
      triggerKind: this.trigger.kind,
      triggerExpr: this.trigger.expr,
      triggerTz: this.trigger.tz,
      targetKind: this.target.kind,
      targetJson: JSON.stringify(this.target.data),
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
   * Replace the target envelope wholesale. The service composes the
   * RFC 7396 patch (via the registered handler's `mergePatch` +
   * `validate`) BEFORE calling this — the entity does no merging of
   * its own. The new envelope's `kind` MUST match the existing
   * `kind` (changing kind on an existing row is not supported in v1).
   */
  withTarget(envelope: ScheduleTargetEnvelope, now: Date): ScheduleEntity {
    if (envelope.kind !== this.target.kind) {
      throw new ScheduleError(
        `Cannot change target.kind on schedule "${this.id}" (current="${this.target.kind}", attempted="${envelope.kind}")`,
      );
    }
    return new ScheduleEntity(
      this.id,
      this.name,
      this.trigger,
      { kind: envelope.kind, data: envelope.data },
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
   * Set or clear `nextFireAt` without touching `lastFiredAt`. Used
   * by `ScheduleService.create` (pre-arm with no prior fire) and
   * `ScheduleService.patch` (trigger / enabled change recomputes
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

/**
 * Hydrate the envelope from a row. Generic: `kind` comes straight
 * from the `target_kind` column and `data` is `JSON.parse`d as
 * unknown. The schedule pkg does NOT invoke
 * `handler.validate(data)` on reads — persisted data is trusted (it
 * was validated by the handler at create / patch time). Re-validating
 * on every read would (a) require a catalog round-trip per row in
 * the list endpoint and (b) be redundant. Handlers that want
 * belt-and-braces re-checks on dispatch can do so inside
 * `handler.dispatch` themselves.
 */
function parseTargetRow(row: ScheduleRow): ScheduleTargetEnvelope {
  let data: unknown;
  try {
    data = JSON.parse(row.targetJson);
  } catch (err) {
    throw new ScheduleError(
      `Schedule "${row.id}" corrupted: target_json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { kind: row.targetKind, data };
}
