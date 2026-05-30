/**
 * Routes for `/api/workspaces/:wsId/schedules`. Sibling of
 * `routes/scheduled-tasks.ts` — this file owns CRUD + run + preview
 * for the cron-trigger entities themselves; that file owns the
 * read-only list of tasks the trigger has produced.
 *
 * Resolver-injection pattern matches `routes/tasks.ts` /
 * `routes/scheduled-tasks.ts`: the mount point hands in a function
 * that pulls the workspace-scoped `ScheduleService` out of Hono's
 * per-request context. The route file never touches workspace
 * resolution, only the schedule surface.
 *
 * ## Mutation routes (URL-discriminated by target kind)
 *
 * `POST` and `PATCH` are split by `target.kind` so each kind can
 * offer an honest, RFC 7396-style deep-merge contract on its body:
 *
 *   - `POST /task`        creates a task-kind schedule
 *   - `PATCH /task/:sid`  patches a task-kind schedule (RFC 7396
 *                         deep-merge on `target`; wholesale-replace
 *                         on `trigger`; scalar-set on
 *                         `name` / `enabled`)
 *
 * Reads (`GET /`, `GET /:sid`, `GET /:sid/preview`,
 * `GET /preview-cron`) and lifecycle ops (`DELETE /:sid`,
 * `POST /:sid/run`) stay polymorphic over kind.
 *
 * When a `workflow` target lands later it will get its own
 * `POST /workflow` + `PATCH /workflow/:sid` pair plus matching
 * service methods; no changes needed in the polymorphic routes.
 *
 * Notes:
 *
 *   - `GET /:sid` — `ScheduleService.get(sid)` returns `Schedule | null`
 *     rather than throwing on miss. The handler maps `null` to a
 *     `ScheduleNotFoundError`-shaped 404 envelope so dashboards /
 *     CLIs can `instanceof`-branch off the wire `code`. The success
 *     payload is enriched with a derived `describe` (zh_CN cron text)
 *     so callers can render it without a second round-trip; the
 *     field is computed from `trigger.expr`, NOT persisted.
 *   - `GET /:sid/preview` — `?n=` is bounded in `[1, 100]` at both
 *     the route boundary and inside `ScheduleService.preview` (see
 *     `packages/schedule/src/schedule-service.ts`). Out-of-range
 *     emits a typed 400 envelope; in-range plumbs straight through.
 *   - `GET /preview-cron` — unscoped preview for an arbitrary
 *     `(expr, tz)` pair, used by the dashboard's "New schedule"
 *     modal so the user can see `describe` + next-N fires before
 *     any entity exists (issue #222). Same `[1, 100]` bound on
 *     `?n=`, but defaults to **5** (the modal's preview count),
 *     vs the `/:sid/preview` default of 3 (the detail page count).
 *     MUST be registered before `/:sid` so the literal path wins
 *     over the param match (`:sid = "preview-cron"` is the bug
 *     this ordering prevents).
 */

import {
  describeCron,
  ScheduleError,
  ScheduleKindMismatchError,
  ScheduleNotFoundError,
  type ScheduleService,
  type ScheduleTrigger,
  type TaskTargetData,
  type TaskTargetPatch,
} from "@emploke/schedule";
// `ScheduleError` is used by both the `/:sid/preview` n-bound check
// and the new `/preview-cron` n-bound check (issue #222) for a typed
// envelope on rejection.
import { Hono } from "hono";
import { errorBody, logEvent, logFault, parseJsonBody } from "./_shared.js";

export type ScheduleServiceResolver = (c: import("hono").Context) => ScheduleService;

/**
 * Map schedule-layer errors to HTTP status. Mirrors the structure of
 * `statusForCatalogError` in `_shared.ts`; kept local because the
 * route never throws catalog or task errors directly (those bubble
 * via the catalog-driven adapters in `@emploke/core`, not via the
 * `ScheduleService` surface).
 *
 * `ScheduleKindMismatchError` maps to 404 — the resource at the
 * kind-discriminated URL is logically absent. The wire envelope is
 * rewritten to mirror `ScheduleNotFoundError` so the response body
 * does not leak whether the schedule exists under a different kind.
 */
function statusForScheduleError(err: unknown): number | null {
  if (!(err instanceof Error)) return null;
  switch (err.name) {
    case "InvalidScheduleIdError":
    case "InvalidCronExprError":
    case "InvalidTimezoneError":
    case "ScheduleError":
      return 400;
    case "ScheduleNotFoundError":
    case "ScheduleKindMismatchError":
    case "AgentNotFoundError":
      return 404;
    case "ScheduleEnabledError":
    case "ScheduleHasInFlightError":
      return 409;
    default:
      return null;
  }
}

function resolveErrorStatus(err: unknown): { status: number; isUnmapped: boolean } {
  const mapped = statusForScheduleError(err);
  return { status: mapped ?? 400, isUnmapped: mapped === null };
}

const ALLOWED_TASK_CREATE_KEYS = new Set(["name", "target", "trigger", "enabled"]);
const ALLOWED_TASK_PATCH_KEYS = new Set(["name", "target", "trigger", "enabled"]);
const ALLOWED_TASK_TARGET_KEYS = new Set(["agent", "brief", "details", "runtime"]);

interface ValidationFail {
  readonly ok: false;
  readonly error: string;
}
interface ValidationOk<T> {
  readonly ok: true;
  readonly value: T;
}
type ValidationResult<T> = ValidationOk<T> | ValidationFail;

/** Validate a raw value as a {@link TaskTargetData} for `POST /task`. */
function validateTaskTargetData(raw: unknown): ValidationResult<TaskTargetData> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "target must be an object" };
  }
  const obj = raw as Record<string, unknown>;
  // `kind` is URL-implied; reject if the caller sends it to avoid
  // contradictions with the URL discriminator.
  if ("kind" in obj) {
    return {
      ok: false,
      error: "target.kind must not be set on POST /schedules/task (kind is implied by the URL)",
    };
  }
  for (const k of Object.keys(obj)) {
    if (!ALLOWED_TASK_TARGET_KEYS.has(k)) {
      return { ok: false, error: `target has unknown key "${k}"` };
    }
  }
  const { agent, brief, details, runtime } = obj;
  if (typeof agent !== "string" || agent.trim().length === 0) {
    return { ok: false, error: "target.agent must be a non-empty string" };
  }
  if (typeof brief !== "string" || brief.trim().length === 0) {
    return { ok: false, error: "target.brief must be a non-empty string" };
  }
  if (brief.includes("\n") || brief.includes("\r")) {
    return {
      ok: false,
      error: "target.brief must be a single line — pass long content via target.details",
    };
  }
  if (brief.trim().length > 200) {
    return { ok: false, error: "target.brief must be at most 200 chars" };
  }
  if (details !== undefined && typeof details !== "string") {
    return { ok: false, error: "target.details, when set, must be a string" };
  }
  if (runtime !== undefined && (typeof runtime !== "string" || runtime.trim().length === 0)) {
    return { ok: false, error: "target.runtime, when set, must be a non-empty string" };
  }
  return {
    ok: true,
    value: {
      agent,
      brief,
      ...(details !== undefined ? { details } : {}),
      ...(runtime !== undefined ? { runtime } : {}),
    },
  };
}

/**
 * Validate a raw value as a {@link TaskTargetPatch} for
 * `PATCH /task/:sid`. RFC 7396 semantics: `null` on optional
 * `details`/`runtime` deletes; `null` on required `agent`/`brief` is
 * rejected with a clear 400.
 */
function validateTaskTargetPatch(raw: unknown): ValidationResult<TaskTargetPatch> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "target must be an object" };
  }
  const obj = raw as Record<string, unknown>;
  if ("kind" in obj) {
    return {
      ok: false,
      error:
        "target.kind must not be set on PATCH /schedules/task/:sid (kind is implied by the URL)",
    };
  }
  for (const k of Object.keys(obj)) {
    if (!ALLOWED_TASK_TARGET_KEYS.has(k)) {
      return { ok: false, error: `target has unknown key "${k}"` };
    }
  }
  const patch: {
    agent?: string;
    brief?: string;
    details?: string | null;
    runtime?: string | null;
  } = {};
  if ("agent" in obj) {
    const v = obj.agent;
    if (v === null) {
      return { ok: false, error: "target.agent cannot be null (required field; omit to keep)" };
    }
    if (typeof v !== "string" || v.trim().length === 0) {
      return { ok: false, error: "target.agent must be a non-empty string" };
    }
    patch.agent = v;
  }
  if ("brief" in obj) {
    const v = obj.brief;
    if (v === null) {
      return { ok: false, error: "target.brief cannot be null (required field; omit to keep)" };
    }
    if (typeof v !== "string" || v.trim().length === 0) {
      return { ok: false, error: "target.brief must be a non-empty string" };
    }
    if (v.includes("\n") || v.includes("\r")) {
      return {
        ok: false,
        error: "target.brief must be a single line — pass long content via target.details",
      };
    }
    if (v.trim().length > 200) {
      return { ok: false, error: "target.brief must be at most 200 chars" };
    }
    patch.brief = v;
  }
  if ("details" in obj) {
    const v = obj.details;
    if (v === null) {
      patch.details = null;
    } else if (typeof v === "string") {
      patch.details = v;
    } else {
      return {
        ok: false,
        error: "target.details must be a string (set), null (delete), or omitted (keep)",
      };
    }
  }
  if ("runtime" in obj) {
    const v = obj.runtime;
    if (v === null) {
      patch.runtime = null;
    } else if (typeof v === "string" && v.trim().length > 0) {
      patch.runtime = v;
    } else {
      return {
        ok: false,
        error: "target.runtime must be a non-empty string (set), null (delete), or omitted (keep)",
      };
    }
  }
  return { ok: true, value: patch };
}

/** Validate a raw value as a full {@link ScheduleTrigger}. */
function validateTrigger(raw: unknown): ValidationResult<ScheduleTrigger> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "trigger must be an object" };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.kind !== "cron") {
    return { ok: false, error: 'trigger.kind must be "cron"' };
  }
  if (typeof obj.expr !== "string" || obj.expr.trim().length === 0) {
    return { ok: false, error: "trigger.expr must be a non-empty string" };
  }
  if (typeof obj.tz !== "string" || obj.tz.trim().length === 0) {
    return { ok: false, error: "trigger.tz must be a non-empty string" };
  }
  return { ok: true, value: { kind: "cron", expr: obj.expr, tz: obj.tz } };
}

export function schedulesRoutes(resolve: ScheduleServiceResolver): Hono {
  const app = new Hono();

  // ── GET / — list with optional agent / enabled filters ────────────
  app.get("/", async (c) => {
    const agent = c.req.query("agent");
    const enabledRaw = c.req.query("enabled");
    let enabled: boolean | undefined;
    if (enabledRaw !== undefined) {
      if (enabledRaw !== "true" && enabledRaw !== "false") {
        return c.json({ error: 'enabled must be "true" or "false"' }, 400);
      }
      enabled = enabledRaw === "true";
    }
    try {
      const list = await resolve(c).list({
        ...(agent !== undefined ? { agent } : {}),
        ...(enabled !== undefined ? { enabled } : {}),
      });
      return c.json(list);
    } catch (err) {
      const { status, isUnmapped } = resolveErrorStatus(err);
      if (status >= 500) logFault(c, err, "schedules.list: 5xx fault");
      else if (isUnmapped) logFault(c, err, "schedules.list: unmapped error fell through to 400");
      // biome-ignore lint/suspicious/noExplicitAny: same cast pattern as tasks/scheduled-tasks routes
      return c.json(errorBody(err), status as any);
    }
  });

  // ── POST /task — create a task-kind schedule ──────────────────────
  // URL-discriminated: the body carries no `target.kind` (the URL
  // declares it). Server injects `kind: "task"` before forwarding
  // to `ScheduleService.createTask`.
  app.post("/task", async (c) => {
    const parsed = await parseJsonBody<Record<string, unknown>>(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const body = parsed.body;
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ error: "request body must be an object" }, 400);
    }
    for (const k of Object.keys(body)) {
      if (!ALLOWED_TASK_CREATE_KEYS.has(k)) {
        return c.json({ error: `request body has unknown key "${k}"` }, 400);
      }
    }
    const { name, target, trigger, enabled } = body;

    if (typeof name !== "string" || name.trim().length === 0) {
      return c.json({ error: "name must be a non-empty string" }, 400);
    }
    if (enabled !== undefined && typeof enabled !== "boolean") {
      return c.json({ error: "enabled, when set, must be a boolean" }, 400);
    }
    const targetResult = validateTaskTargetData(target);
    if (!targetResult.ok) return c.json({ error: targetResult.error }, 400);
    const triggerResult = validateTrigger(trigger);
    if (!triggerResult.ok) return c.json({ error: triggerResult.error }, 400);

    try {
      const created = await resolve(c).createTask({
        name,
        target: targetResult.value,
        trigger: triggerResult.value,
        ...(enabled !== undefined ? { enabled } : {}),
      });
      logEvent(c, "schedule.create", {
        scheduleId: created.id,
        agent: targetResult.value.agent,
      });
      return c.json(created, 201);
    } catch (err) {
      const { status, isUnmapped } = resolveErrorStatus(err);
      if (status >= 500) logFault(c, err, "schedules.task.create: 5xx fault");
      else if (isUnmapped)
        logFault(c, err, "schedules.task.create: unmapped error fell through to 400");
      // biome-ignore lint/suspicious/noExplicitAny: see above
      return c.json(errorBody(err), status as any);
    }
  });

  // ── GET /preview-cron — preview an arbitrary (expr, tz) ──────────
  // Unscoped sibling of `/:sid/preview` for the "still being
  // authored" UI flow (issue #222). Wraps `ScheduleService.preview`
  // directly — no entity lookup. MUST be registered BEFORE
  // `app.get('/:sid')` so the literal `preview-cron` path wins over
  // `:sid = "preview-cron"` param matching.
  //
  // Defaults: `n = 5` (matches the modal's preview count). Same
  // `[1, 100]` integer bound + strict parse as `/:sid/preview` so
  // `?n=1abc` is rejected (not silently accepted as `1`).
  app.get("/preview-cron", async (c) => {
    const expr = c.req.query("expr");
    const tz = c.req.query("tz");
    if (typeof expr !== "string" || expr.trim() === "") {
      return c.json({ error: "expr query param is required" }, 400);
    }
    if (typeof tz !== "string" || tz.trim() === "") {
      return c.json({ error: "tz query param is required" }, 400);
    }
    // Modal default of 5; issue #222 picked 5 over the /:sid/preview
    // default of 3 because the modal has more vertical space and
    // 5 fires is a clearer "what does this cron actually mean"
    // signal for the user.
    let n = 5;
    const nRaw = c.req.query("n");
    if (nRaw !== undefined) {
      const parsed = Number.parseInt(nRaw, 10);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100 || `${parsed}` !== nRaw) {
        return c.json(errorBody(new ScheduleError("n must be an integer in [1, 100]")), 400);
      }
      n = parsed;
    }
    try {
      const preview = await resolve(c).preview(expr, tz, n);
      return c.json(preview);
    } catch (err) {
      const { status, isUnmapped } = resolveErrorStatus(err);
      if (status >= 500) logFault(c, err, "schedules.previewCron: 5xx fault");
      else if (isUnmapped)
        logFault(c, err, "schedules.previewCron: unmapped error fell through to 400");
      // biome-ignore lint/suspicious/noExplicitAny: see above
      return c.json(errorBody(err), status as any);
    }
  });

  // ── GET /:sid — get one ───────────────────────────────────────────
  app.get("/:sid", async (c) => {
    const sid = c.req.param("sid");
    try {
      const found = await resolve(c).get(sid);
      if (found === null) {
        // `ScheduleService.get` returns `Schedule | null`; project the
        // null branch into the same typed-error envelope every other
        // route uses, so callers can branch on `code`.
        const notFound = new ScheduleNotFoundError(sid);
        return c.json(errorBody(notFound), 404);
      }
      // Enrich with derived cron `describe` so dashboards / CLI `show`
      // can render the human-readable text without a second round-trip.
      // NOT persisted on the entity — `trigger.expr` is the single
      // source of truth.
      return c.json({ ...found, describe: describeCron(found.trigger.expr) });
    } catch (err) {
      const { status, isUnmapped } = resolveErrorStatus(err);
      if (status >= 500) logFault(c, err, "schedules.get: 5xx fault");
      else if (isUnmapped) logFault(c, err, "schedules.get: unmapped error fell through to 400");
      // biome-ignore lint/suspicious/noExplicitAny: see above
      return c.json(errorBody(err), status as any);
    }
  });

  // ── PATCH /task/:sid — patch a task-kind schedule ─────────────────
  // Body semantics (RFC 7396 deep-merge for `target`):
  //   - `name`, `enabled`           — scalar set if present
  //   - `trigger`                   — wholesale replace if present
  //                                   (small atomic shape)
  //   - `target.agent` / `brief`    — set if present; `null` rejected
  //                                   (required fields; omit to keep)
  //   - `target.details` / `runtime` — string sets; `null` deletes;
  //                                   absent keeps
  //   - `target.kind`               — rejected (URL discriminates)
  //
  // Returns 404 (with a generic `ScheduleNotFoundError` envelope) if
  // `:sid` exists but its `target.kind !== "task"` — the resource at
  // this kind-discriminated URL is logically absent and the wire
  // shape must not leak the actual kind.
  app.patch("/task/:sid", async (c) => {
    const sid = c.req.param("sid");
    const parsed = await parseJsonBody<Record<string, unknown>>(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const body = parsed.body;
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ error: "request body must be an object" }, 400);
    }
    for (const k of Object.keys(body)) {
      if (!ALLOWED_TASK_PATCH_KEYS.has(k)) {
        return c.json({ error: `request body has unknown key "${k}"` }, 400);
      }
    }

    const patch: {
      name?: string;
      enabled?: boolean;
      trigger?: ScheduleTrigger;
      target?: TaskTargetPatch;
    } = {};

    if ("name" in body) {
      const v = body.name;
      if (typeof v !== "string" || v.trim().length === 0) {
        return c.json({ error: "name must be a non-empty string" }, 400);
      }
      patch.name = v;
    }
    if ("enabled" in body) {
      const v = body.enabled;
      if (typeof v !== "boolean") {
        return c.json({ error: "enabled must be a boolean" }, 400);
      }
      patch.enabled = v;
    }
    if ("trigger" in body) {
      const r = validateTrigger(body.trigger);
      if (!r.ok) return c.json({ error: r.error }, 400);
      patch.trigger = r.value;
    }
    if ("target" in body) {
      const r = validateTaskTargetPatch(body.target);
      if (!r.ok) return c.json({ error: r.error }, 400);
      patch.target = r.value;
    }

    try {
      const updated = await resolve(c).patchTask(sid, patch);
      logEvent(c, "schedule.patch", { scheduleId: sid });
      return c.json(updated);
    } catch (err) {
      // Project `ScheduleKindMismatchError` to the standard
      // `ScheduleNotFoundError` envelope so the wire shape does not
      // leak whether the schedule exists under another kind. The
      // server log still carries the original error for debugging.
      if (err instanceof ScheduleKindMismatchError) {
        logEvent(c, "schedule.patch.kind_mismatch", {
          scheduleId: sid,
          expected: err.expected,
          actual: err.actual,
        });
        return c.json(errorBody(new ScheduleNotFoundError(sid)), 404);
      }
      const { status, isUnmapped } = resolveErrorStatus(err);
      if (status >= 500) logFault(c, err, "schedules.task.patch: 5xx fault");
      else if (isUnmapped)
        logFault(c, err, "schedules.task.patch: unmapped error fell through to 400");
      // biome-ignore lint/suspicious/noExplicitAny: see above
      return c.json(errorBody(err), status as any);
    }
  });

  // ── DELETE /:sid ──────────────────────────────────────────────────
  app.delete("/:sid", async (c) => {
    const sid = c.req.param("sid");
    try {
      await resolve(c).delete(sid);
      logEvent(c, "schedule.delete", { scheduleId: sid });
      return c.json({ ok: true });
    } catch (err) {
      const { status, isUnmapped } = resolveErrorStatus(err);
      if (status >= 500) logFault(c, err, "schedules.delete: 5xx fault");
      else if (isUnmapped) logFault(c, err, "schedules.delete: unmapped error fell through to 400");
      // biome-ignore lint/suspicious/noExplicitAny: see above
      return c.json(errorBody(err), status as any);
    }
  });

  // ── POST /:sid/run — manual fire-now ──────────────────────────────
  app.post("/:sid/run", async (c) => {
    const sid = c.req.param("sid");
    try {
      const { taskId } = await resolve(c).run(sid);
      logEvent(c, "schedule.run", { scheduleId: sid, taskId });
      return c.json({ taskId });
    } catch (err) {
      const { status, isUnmapped } = resolveErrorStatus(err);
      if (status >= 500) logFault(c, err, "schedules.run: 5xx fault");
      else if (isUnmapped) logFault(c, err, "schedules.run: unmapped error fell through to 400");
      // biome-ignore lint/suspicious/noExplicitAny: see above
      return c.json(errorBody(err), status as any);
    }
  });

  // ── GET /:sid/preview ─────────────────────────────────────────────
  // `?n=` is bounded in `[1, 100]` here AND inside
  // `ScheduleService.preview` — see the service for the second-layer
  // check. Out-of-range emits a typed 400 envelope (code:
  // `ScheduleError`) before the service is touched; in-range plumbs
  // straight through.
  app.get("/:sid/preview", async (c) => {
    const sid = c.req.param("sid");
    const nRaw = c.req.query("n");
    let n: number | undefined;
    if (nRaw !== undefined) {
      const parsed = Number.parseInt(nRaw, 10);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100 || `${parsed}` !== nRaw) {
        return c.json(errorBody(new ScheduleError("n must be an integer in [1, 100]")), 400);
      }
      n = parsed;
    }
    try {
      const service = resolve(c);
      const entity = await service.get(sid);
      if (entity === null) {
        const notFound = new ScheduleNotFoundError(sid);
        return c.json(errorBody(notFound), 404);
      }
      const preview = await service.preview(entity.trigger.expr, entity.trigger.tz, n ?? 3);
      return c.json(preview);
    } catch (err) {
      const { status, isUnmapped } = resolveErrorStatus(err);
      if (status >= 500) logFault(c, err, "schedules.preview: 5xx fault");
      else if (isUnmapped)
        logFault(c, err, "schedules.preview: unmapped error fell through to 400");
      // biome-ignore lint/suspicious/noExplicitAny: see above
      return c.json(errorBody(err), status as any);
    }
  });

  return app;
}
