/**
 * Pkg-internal helpers shared between service / repository / entity.
 * Pure functions; throw `ScheduleError` subclasses on invalid input.
 *
 * Kept out of `validate.ts` so the public surface (`generateScheduleId`,
 * `assertValidScheduleId`) stays narrowly scoped to the id grammar.
 */

import { assertValidCronExpr, assertValidTimezone } from "./cron.js";
import { InvalidJsonPathError, ScheduleError } from "./errors.js";
import type { ScheduleTrigger } from "./types.js";

/**
 * Kind names appear in `schedules.target_kind` (a TEXT column) and in
 * error messages quoted back to operators. We keep the grammar
 * deliberately narrow:
 *   - lowercase ASCII letter first
 *   - then any of lowercase letters, digits, underscore, hyphen
 *
 * This rules out empty / whitespace-only registrations (the kind would
 * otherwise be a confusing "" in error messages) and forbids special
 * characters that might collide with JSON-path syntax or future
 * URL-discriminated route segments.
 */
const KIND_NAME_RE = /^[a-z][a-z0-9_-]*$/;

export function assertValidKindName(kind: unknown): asserts kind is string {
  if (typeof kind !== "string" || !KIND_NAME_RE.test(kind)) {
    throw new ScheduleError(
      `Invalid schedule kind name: ${JSON.stringify(kind)}. Must match ${KIND_NAME_RE.source}`,
    );
  }
}

/**
 * JSON-path grammar accepted by `ListScheduleOpts.dataEquals.path`.
 * Used to defend the `json_extract(target_json, <path>) = ?` SQL
 * fragment from injection — the path is string-concatenated into the
 * Drizzle `sql` template because Drizzle parameterises only the
 * `?`-placeholder values, not the `json_extract` first argument.
 *
 * Grammar: `$` followed by one or more `.field` segments where each
 * field is a JS-identifier-shaped token. Bracket-notation, wildcards,
 * array indices, and quoted keys are intentionally NOT supported —
 * the schedule pkg only ever exposes opaque top-level field equality
 * to its callers (`{ kind: "task", dataEquals: { path: "$.agent" } }`
 * et al). If a future kind needs richer paths, extend this regex
 * (and add tests) at that point.
 */
const JSON_PATH_RE = /^\$(\.[a-zA-Z_][a-zA-Z0-9_]*)+$/;

export function assertValidJsonPath(path: unknown): asserts path is string {
  if (typeof path !== "string" || !JSON_PATH_RE.test(path)) {
    throw new InvalidJsonPathError(typeof path === "string" ? path : String(path));
  }
}

/**
 * Kind-agnostic invariants on the `name` field. Shared by
 * `ScheduleService.create` (synchronous pre-validate gate) and
 * `ScheduleEntity.withMetadata` / `.create` (entity-side
 * defence-in-depth).
 */
export function assertValidName(name: unknown): asserts name is string {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new ScheduleError(`Schedule name must be a non-empty string`);
  }
}

/**
 * Kind-agnostic invariants on the `trigger` field. Shared by service
 * (pre-validate gate) and entity (constructor / withTrigger). The
 * full per-kind validation (cron expr + tz for `kind === "cron"`)
 * lives here; future trigger kinds (`interval`, etc.) extend the
 * switch.
 */
export function assertValidTrigger(trigger: ScheduleTrigger): void {
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
