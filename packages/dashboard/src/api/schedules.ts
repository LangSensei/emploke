// PR 4/4 of #61 — workspace-scoped cron triggers. Mounted at
// `/api/workspaces/:wsId/schedules` server-side (see
// `packages/server/src/routes/schedules.ts`). The dashboard surfaces
// list + detail (read), enable-toggle + delete + run-now (narrow
// mutation slice); create / cron edit stay CLI-only in v1 per the
// #61 RFC.
//
// Mutation routes are URL-discriminated by `target.kind` (#225–#229):
// `POST /schedules/task` + `PATCH /schedules/task/:sid` for the task
// kind. The PATCH body uses RFC 7396 deep-merge semantics on
// `target` (siblings preserved; `null` deletes `details` / `runtime`)
// and wholesale-replace on `trigger`.

import type { PreviewResult, Schedule } from "@emploke/schedule";
import {
  fetchJson,
  fetchJsonWithErrorBody,
  jsonInit,
  mutateJson,
  workspacePrefix,
} from "./http.js";

/**
 * Wire-shape view of a schedule — re-exports `@emploke/schedule`'s
 * `Schedule` so the dashboard doesn't have to mirror the type by
 * hand. The schedule package is a `devDependency` (type-only import),
 * so it tree-shakes out of the runtime bundle.
 */
export type ScheduleView = Schedule;

/**
 * Response shape for `GET /schedules/:sid` — the entity plus the
 * server-computed cronstrue description (`describe`). The dashboard
 * never re-derives `describe` client-side; cronstrue isn't a
 * dashboard dep and the server is the single source of truth for
 * the locale + format (zh_CN, per the route handler).
 */
export interface ScheduleDetail extends ScheduleView {
  describe: string;
}

/**
 * Body for `PATCH /schedules/task/:sid` — RFC 7396 deep-merge for
 * `target`, wholesale-replace for `trigger`, scalar-set for
 * `name` / `enabled`. Mirrors `TaskSchedulePatchBody` in the server
 * manifest (`packages/server/src/routes/manifest.ts`). Declared
 * locally rather than re-exported from `@emploke/schedule` because
 * the dashboard imports types only.
 *
 * - `name` / `enabled` — set if present, otherwise keep.
 * - `trigger` — wholesale replace; absent means keep.
 * - `target.agent` / `brief` — set if present; `null` rejected by the
 *   server (required fields; omit to keep).
 * - `target.details` / `runtime` — string sets; `null` deletes;
 *   absent keeps. `target.kind` MUST NOT be set (URL discriminates).
 */
export interface PatchScheduleBody {
  name?: string;
  enabled?: boolean;
  trigger?: { kind: "cron"; expr: string; tz: string };
  target?: {
    agent?: string;
    brief?: string;
    details?: string | null;
    runtime?: string | null;
  };
}

/** Response shape for `GET /schedules/:sid/preview?n=N`. */
export type SchedulePreview = PreviewResult;

export interface ListSchedulesOpts {
  /** Filter by target agent FQN (e.g. `"emploke/dev"`). */
  agent?: string;
  /** Filter by enabled state. */
  enabled?: boolean;
}

export const listSchedules = (opts: ListSchedulesOpts = {}): Promise<ScheduleView[]> => {
  const qs = new URLSearchParams();
  if (opts.agent !== undefined) qs.set("agent", opts.agent);
  if (opts.enabled !== undefined) qs.set("enabled", opts.enabled ? "true" : "false");
  const suffix = qs.toString() === "" ? "" : `?${qs.toString()}`;
  return fetchJson<ScheduleView[]>(`${workspacePrefix()}/schedules${suffix}`, "schedules");
};

export const getSchedule = (sid: string): Promise<ScheduleDetail> =>
  fetchJson<ScheduleDetail>(
    `${workspacePrefix()}/schedules/${encodeURIComponent(sid)}`,
    "schedule",
  );

export interface PreviewScheduleOpts {
  /** Number of upcoming fire times to compute. Server clamps to `[1, 100]` and defaults to 3. */
  n?: number;
}

export const previewSchedule = (
  sid: string,
  opts: PreviewScheduleOpts = {},
): Promise<SchedulePreview> => {
  const qs = new URLSearchParams();
  if (opts.n !== undefined) qs.set("n", String(opts.n));
  const suffix = qs.toString() === "" ? "" : `?${qs.toString()}`;
  return fetchJson<SchedulePreview>(
    `${workspacePrefix()}/schedules/${encodeURIComponent(sid)}/preview${suffix}`,
    "schedule preview",
  );
};

export const patchSchedule = (sid: string, body: PatchScheduleBody): Promise<ScheduleView> =>
  mutateJson<ScheduleView>(
    `${workspacePrefix()}/schedules/task/${encodeURIComponent(sid)}`,
    jsonInit("PATCH", body as object),
  );

export const deleteSchedule = (sid: string): Promise<{ deletedTaskCount: number }> =>
  mutateJson<{ deletedTaskCount: number }>(
    `${workspacePrefix()}/schedules/${encodeURIComponent(sid)}`,
    { method: "DELETE" },
  );

export const runSchedule = (sid: string): Promise<{ taskId: string }> =>
  mutateJson<{ taskId: string }>(`${workspacePrefix()}/schedules/${encodeURIComponent(sid)}/run`, {
    method: "POST",
  });

/**
 * Body for `POST /api/workspaces/:wsId/schedules/task` — mirrors the
 * server route's accepted shape
 * (`packages/server/src/routes/schedules.ts` `app.post("/task")`).
 * URL-discriminated by `target.kind` (no `kind` field on the body).
 * The dashboard's "New schedule" modal (issue #222) is the first
 * surface to use this; the CLI's `emploke schedule create` sends the
 * same wire shape directly. The `target.brief` + optional
 * `target.details` pair mirrors `@emploke/task` `DispatchOpts` (RFC
 * #61 v2).
 */
export interface CreateScheduleBody {
  name: string;
  target: { agent: string; brief: string; details?: string; runtime?: string };
  trigger: { kind: "cron"; expr: string; tz: string };
  enabled?: boolean;
}

/**
 * Create a task-kind schedule. Surfaces server-side validation errors
 * verbatim (typed envelope `{ error, code }`) via the shared
 * `extractError` helper — the modal renders these inline so the user
 * sees, e.g., "Invalid cron expression: …" rather than a generic
 * "schedule create: 400".
 */
export const createSchedule = (body: CreateScheduleBody): Promise<ScheduleView> =>
  mutateJson<ScheduleView>(`${workspacePrefix()}/schedules/task`, jsonInit("POST", body));

export interface PreviewCronArgs {
  expr: string;
  tz: string;
  /** Number of upcoming fires to compute. Server bounds `[1, 100]`; defaults to 5. */
  n?: number;
}

/**
 * Unscoped cron preview (issue #222). Calls the new
 * `GET /api/workspaces/:wsId/schedules/preview-cron?expr=&tz=&n=`
 * route so the "New schedule" modal can show `describe` + next-N
 * fires while the user is still authoring an expression, with no
 * saved entity required.
 *
 * Uses the error-preserving `fetchJsonWithErrorBody` path so the
 * modal can surface the server's `error` string ("Invalid cron
 * expression: …" / "Unknown timezone: …") inline. The plain
 * `fetchJson` helper discards the body and throws
 * `"schedule preview: 400"`, which is not acceptable UX for a live
 * preview surface.
 *
 * The optional `signal` parameter forwards an `AbortSignal` to the
 * underlying `fetch(...)` so callers (notably the debounced live
 * preview in `CreateScheduleModal`) can cancel an in-flight request
 * when a newer one supersedes it. Aborted requests reject with
 * `DOMException { name: "AbortError" }`; callers should filter that
 * shape out of their error UI.
 */
export const previewCron = (
  args: PreviewCronArgs,
  signal?: AbortSignal,
): Promise<SchedulePreview> => {
  const qs = new URLSearchParams({ expr: args.expr, tz: args.tz });
  if (args.n !== undefined) qs.set("n", String(args.n));
  return fetchJsonWithErrorBody<SchedulePreview>(
    `${workspacePrefix()}/schedules/preview-cron?${qs.toString()}`,
    signal,
  );
};
