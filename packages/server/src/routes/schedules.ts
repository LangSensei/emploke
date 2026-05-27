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
 */

import {
  type CreateScheduleArgs,
  describeCron,
  type PatchScheduleArgs,
  ScheduleError,
  ScheduleNotFoundError,
  type ScheduleService,
} from "@emploke/schedule";
import { Hono } from "hono";
import { errorBody, logEvent, logFault, parseJsonBody } from "./_shared.js";

export type ScheduleServiceResolver = (c: import("hono").Context) => ScheduleService;

/**
 * Map schedule-layer errors to HTTP status. Mirrors the structure of
 * `statusForCatalogError` in `_shared.ts`; kept local because the
 * route never throws catalog or task errors directly (those bubble
 * via the catalog-driven adapters in `@emploke/core`, not via the
 * `ScheduleService` surface).
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

  // ── POST / — create ───────────────────────────────────────────────
  app.post("/", async (c) => {
    const parsed = await parseJsonBody<{
      name?: unknown;
      target?: CreateScheduleArgs["target"];
      trigger?: CreateScheduleArgs["trigger"];
      enabled?: unknown;
    }>(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);

    const { name, target, trigger, enabled } = parsed.body;
    if (typeof name !== "string" || name.trim().length === 0) {
      return c.json({ error: "name must be a non-empty string" }, 400);
    }
    if (
      target === undefined ||
      target === null ||
      typeof target !== "object" ||
      target.kind !== "task" ||
      typeof target.agent !== "string"
    ) {
      return c.json(
        { error: "target must be { kind: 'task', agent, instructions, runtime? }" },
        400,
      );
    }
    if (
      trigger === undefined ||
      trigger === null ||
      typeof trigger !== "object" ||
      trigger.kind !== "cron"
    ) {
      return c.json({ error: "trigger must be { kind: 'cron', expr, tz }" }, 400);
    }
    if (enabled !== undefined && typeof enabled !== "boolean") {
      return c.json({ error: "enabled, when set, must be a boolean" }, 400);
    }

    try {
      const created = await resolve(c).create({
        name,
        target,
        trigger,
        ...(enabled !== undefined ? { enabled } : {}),
      });
      logEvent(c, "schedule.create", { scheduleId: created.id, agent: target.agent });
      return c.json(created, 201);
    } catch (err) {
      const { status, isUnmapped } = resolveErrorStatus(err);
      if (status >= 500) logFault(c, err, "schedules.create: 5xx fault");
      else if (isUnmapped) logFault(c, err, "schedules.create: unmapped error fell through to 400");
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

  // ── PATCH /:sid ────────────────────────────────────────────────────
  app.patch("/:sid", async (c) => {
    const sid = c.req.param("sid");
    const parsed = await parseJsonBody<Partial<PatchScheduleArgs>>(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    try {
      const updated = await resolve(c).patch(sid, parsed.body);
      logEvent(c, "schedule.patch", { scheduleId: sid });
      return c.json(updated);
    } catch (err) {
      const { status, isUnmapped } = resolveErrorStatus(err);
      if (status >= 500) logFault(c, err, "schedules.patch: 5xx fault");
      else if (isUnmapped) logFault(c, err, "schedules.patch: unmapped error fell through to 400");
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
