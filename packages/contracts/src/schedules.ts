/**
 * Wire-shape DTOs for the schedules HTTP surface that are NOT owned
 * by `@emploke/schedule` (the schedule pkg is a kind-agnostic
 * substrate; per-kind wire shapes live here so the substrate stays
 * free of kind knowledge).
 *
 * The internal {@link import("@emploke/schedule").ScheduleTargetEnvelope}
 * keeps `target.data` opaque (`unknown`). The server's
 * `projectScheduleToWire` helper converts the envelope to the flat
 * task-wire shape for HTTP responses so dashboard / CLI consumers
 * can keep reading `schedule.target.agent` etc. without touching
 * `data`.
 */

/**
 * Task-kind target data payload — flat, matches the create-body
 * shape minus the URL-implied `kind`. Persisted opaquely as the
 * `data` of the schedule envelope; consumed flatly on the wire.
 */
export interface TaskTargetData {
  readonly agent: string;
  /** Single line, ≤ 200 chars. Mirrors `@emploke/task` `DispatchOpts.brief`. */
  readonly brief: string;
  /** Multi-line, optional. Mirrors `@emploke/task` `DispatchOpts.details` (empty string allowed). */
  readonly details?: string;
  readonly runtime?: string;
}

/**
 * RFC 7396 deep-merge patch for a task target.
 *
 *   - `agent` / `brief`: if present, set (must be a non-empty
 *     string; `null` is rejected at the route boundary because
 *     these are required-on-entity).
 *   - `details` / `runtime`: if present and string → set; if `null`
 *     → delete the field; if absent → keep existing.
 *
 * The `kind` discriminator is intentionally absent — it's implied
 * by the URL (`/schedules/task/:sid`).
 */
export interface TaskTargetPatch {
  readonly agent?: string;
  readonly brief?: string;
  readonly details?: string | null;
  readonly runtime?: string | null;
}

/**
 * Flat wire projection for a task-kind schedule target. The internal
 * envelope `{ kind: "task", data: { agent, brief, ... } }` is
 * flattened to `{ kind: "task", agent, brief, ... }` for HTTP
 * responses so existing dashboard / CLI code that reads
 * `schedule.target.agent` keeps working.
 */
export type TaskScheduleTargetWire = { readonly kind: "task" } & TaskTargetData;

/**
 * Wire-shape target on schedule responses. Flat for the task kind
 * (`TaskScheduleTargetWire`); opaque envelope for any future kind
 * the server projects through unchanged. When a second concrete
 * kind ships, add its flat wire shape here as another union member
 * and extend `projectScheduleToWire` in the server.
 */
export type ScheduleWireTarget =
  | TaskScheduleTargetWire
  | { readonly kind: string; readonly data: unknown };
