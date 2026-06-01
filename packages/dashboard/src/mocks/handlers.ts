/**
 * MSW request handlers for the dashboard's read surface.
 *
 * Every URL here mirrors a fetch call site in `packages/dashboard/src/api.ts`.
 * When adding a new dashboard route, mirror it here too (or add a fixture
 * entry the catch-all can serve) — otherwise designer mode will pass the
 * request through to the (non-existent) backend and log an
 * `onUnhandledRequest: "warn"` warning in the browser console.
 *
 * The handlers are read-only PLUS a narrow mutation slice for
 * `/schedules*` (PR 4/4 of #61). General mutation support across
 * the rest of the surface is still tracked in #213 (Designer mode
 * phase 2); the catch-all returns 501 for any non-GET mutation that
 * doesn't match a handler above it.
 */

import { type DefaultBodyType, HttpResponse, http } from "msw";

import type {
  CreateScheduleBody,
  PatchScheduleBody,
  ScheduleDetail,
  ScheduleView,
} from "../api/index.js";
import {
  artifactBodies,
  fixtureActiveWorkspaceId,
  fixtureActivities,
  fixtureAgents,
  fixtureSchedules,
  fixtureSessions,
  fixtureTasks,
  fixtureWorkspaces,
} from "./fixtures/index.js";

const W = ":wsId";

function notFound(message: string): HttpResponse<DefaultBodyType> {
  return HttpResponse.json({ error: message }, { status: 404 });
}

/**
 * Ephemeral, in-memory copy of the schedule fixtures so PATCH /
 * DELETE / POST run mutate this slot without polluting the
 * source-of-truth fixture array. A browser refresh re-imports this
 * module and resets the slot — designer mode is intentionally
 * non-persistent (designer iteration ≠ a real backend).
 */
const schedulesState: ScheduleDetail[] = fixtureSchedules.map((s) => ({ ...s }));

/**
 * Ephemeral, in-memory copy of the task fixtures so synthetic
 * schedule-launched task rows (appended by POST /schedules/:sid/run)
 * surface in the per-schedule "Recent fires" panel. Reset on refresh,
 * same lifetime as `schedulesState`.
 */
const tasksState = fixtureTasks.map((t) => ({ ...t }));

let synthFireSeq = 0;

/**
 * Short, deterministic-enough random id helper for synthesised
 * schedule entities (mock mode only). `crypto.randomUUID()` exists in
 * every modern browser; we slice 8 hex chars off the start for a
 * compact-looking sched id (`sched-1a2b3c4d`). Tests that need a
 * stable id can still set their own fixture and avoid the POST path.
 */
function cryptoRandom8(): string {
  return (globalThis.crypto?.randomUUID?.() ?? `${Math.random().toString(16).slice(2)}-x`).slice(
    0,
    8,
  );
}

export const handlers = [
  // ── catalog (workspace-scoped) ───────────────────────────────
  http.get(`/api/workspaces/${W}/catalog/overview`, () =>
    HttpResponse.json({
      counts: {
        skills: 6,
        agents: fixtureAgents.length,
        mcps: 3,
        blocked: fixtureAgents.filter((a) => a.status === "blocked").length,
        orphaned: 0,
      },
    }),
  ),
  http.get(`/api/workspaces/${W}/catalog/agents`, () => HttpResponse.json(fixtureAgents)),
  http.get(`/api/workspaces/${W}/catalog/skills`, () => HttpResponse.json([])),
  http.get(`/api/workspaces/${W}/catalog/mcps`, () => HttpResponse.json([])),

  // ── tasks (workspace-scoped) ─────────────────────────────────
  // PR 1 of #61 split `/tasks` into standalone-only and
  // `/scheduled-tasks` for schedule-launched runs; both routes share
  // this fixture set with origin-based filtering.
  http.get(`/api/workspaces/${W}/tasks`, () =>
    HttpResponse.json(tasksState.filter((t) => t.origin === "standalone")),
  ),
  http.get(`/api/workspaces/${W}/scheduled-tasks`, ({ request }) => {
    const url = new URL(request.url);
    const scheduleId = url.searchParams.get("scheduleId");
    let rows = tasksState.filter((t) => t.origin === "schedule");
    if (scheduleId !== null) {
      rows = rows.filter((t) => {
        const sid = (t.metadata as Record<string, unknown> | undefined)?.scheduleId;
        return typeof sid === "string" && sid === scheduleId;
      });
    }
    return HttpResponse.json(rows);
  }),
  http.get(`/api/workspaces/${W}/tasks/:tid`, ({ params }) => {
    const task = tasksState.find((t) => t.id === params.tid);
    return task ? HttpResponse.json(task) : notFound("task not found");
  }),
  http.get(`/api/workspaces/${W}/tasks/:tid/activity`, ({ params }) => {
    const tid = String(params.tid);
    const activity = fixtureActivities[tid];
    if (activity) return HttpResponse.json(activity);
    // Tasks without a hand-authored timeline still return a valid empty
    // payload — the dashboard's ActivityTab handles { activity: [] }
    // gracefully, but treats 404 as "runtime has no event log".
    if (tasksState.some((t) => t.id === tid)) {
      return HttpResponse.json({ activity: [], result: null, totalItems: 0 });
    }
    return new HttpResponse(null, { status: 404 });
  }),
  http.get(`/api/workspaces/${W}/tasks/:tid/artifact/:name`, ({ params }) => {
    const key = `${params.tid}/${params.name}`;
    const entry = artifactBodies.get(key);
    if (!entry) return new HttpResponse(null, { status: 404 });
    return new HttpResponse(entry.body, {
      headers: { "content-type": entry.contentType },
    });
  }),

  // ── sessions (workspace-scoped) ──────────────────────────────
  http.get(`/api/workspaces/${W}/sessions`, () => HttpResponse.json(fixtureSessions)),
  http.get(`/api/workspaces/${W}/sessions/:sid`, ({ params }) => {
    const sess = fixtureSessions.find((s) => s.id === params.sid);
    return sess ? HttpResponse.json(sess) : notFound("session not found");
  }),

  // ── workspaces + global metadata ─────────────────────────────
  http.get("/api/workspaces", () => HttpResponse.json(fixtureWorkspaces)),
  http.get("/api/workspaces/current", () => HttpResponse.json({ id: fixtureActiveWorkspaceId })),
  http.get("/api/runtimes", () =>
    HttpResponse.json([
      { kind: "copilot", capabilities: { remoteSession: true } },
      { kind: "claude", capabilities: {} },
    ]),
  ),
  http.get("/api/config", () =>
    HttpResponse.json({
      emplokeHome: "/mock/emploke-home",
      currentWorkspace: fixtureActiveWorkspaceId,
      host: "localhost",
      port: 41817,
      pathSeparator: "/",
      tasks: { pollIntervalMs: 5000 },
    }),
  ),
  // /api/health is also where `serverClock.ts` reads `serverNow` from,
  // so this handler keeps "Today" / "7d" filter cutoffs working.
  http.get("/api/health", () => {
    const now = new Date().toISOString();
    return HttpResponse.json({
      status: "ok",
      name: "@emploke/server (mock)",
      version: "0.0.0-mock",
      startedAt: "2026-05-20T08:00:00.000Z",
      uptimeSec: 3600,
      serverNow: now,
    });
  }),

  // SSE stream for a running task. 204 closes the EventSource cleanly so
  // the browser does NOT enter its ~3-second reconnect loop and spam the
  // console. Phase 2 (#213) can replace this with a synthetic stream that
  // emits a couple of `event: activity` frames to exercise mergeStreamItem.
  http.get(
    `/api/workspaces/${W}/tasks/:tid/activity/stream`,
    () =>
      new HttpResponse(null, {
        status: 204,
        headers: { "content-type": "text/event-stream" },
      }),
  ),

  // ── schedules (workspace-scoped, PR 4/4 of #61) ──────────────
  // List + detail + preview are read-only; PATCH (enabled toggle),
  // DELETE, and POST /:sid/run form the narrow mutation slice the
  // dashboard's detail surface drives. State lives in
  // `schedulesState` and resets on browser refresh.
  http.get(`/api/workspaces/${W}/schedules`, ({ request }) => {
    const url = new URL(request.url);
    const agent = url.searchParams.get("agent");
    const enabled = url.searchParams.get("enabled");
    let rows = schedulesState.slice();
    if (agent !== null) rows = rows.filter((s) => s.target.agent === agent);
    if (enabled === "true") rows = rows.filter((s) => s.enabled);
    if (enabled === "false") rows = rows.filter((s) => !s.enabled);
    rows.sort((a, b) => (a.nextFireAt ?? "").localeCompare(b.nextFireAt ?? ""));
    // Strip `describe` from the list view to mirror the server's
    // `GET /` response shape (the describe enrichment is per-GET).
    return HttpResponse.json(rows.map(({ describe: _describe, ...rest }) => rest));
  }),
  // POST /schedules/task — issue #222's "New schedule" modal lands
  // here. URL-discriminated by `target.kind` (#225–#229): the body
  // carries no `target.kind` and the mock injects `"task"` before
  // storing. Mirrors the server route's validation shape (name +
  // target with required agent/brief + trigger.kind=cron).
  // Synthesises ids, timestamps, and a hand-wavy describe — designer
  // mode is intentionally rough on the describe accuracy; cronstrue
  // is a server-side dep.
  http.post(`/api/workspaces/${W}/schedules/task`, async ({ request }) => {
    const body = (await request.json()) as CreateScheduleBody;
    if (typeof body.name !== "string" || body.name.trim() === "") {
      return HttpResponse.json({ error: "name must be a non-empty string" }, { status: 400 });
    }
    if (
      body.target === undefined ||
      body.target === null ||
      typeof body.target.agent !== "string" ||
      typeof body.target.brief !== "string"
    ) {
      return HttpResponse.json(
        { error: "target must be { agent, brief, details?, runtime? }" },
        { status: 400 },
      );
    }
    if (
      body.trigger === undefined ||
      body.trigger === null ||
      body.trigger.kind !== "cron" ||
      typeof body.trigger.expr !== "string" ||
      typeof body.trigger.tz !== "string"
    ) {
      return HttpResponse.json(
        { error: "trigger must be { kind: 'cron', expr, tz }" },
        { status: 400 },
      );
    }
    const id = `sched-${cryptoRandom8()}`;
    const now = new Date().toISOString();
    const created: ScheduleDetail = {
      id,
      name: body.name.trim(),
      target: { kind: "task", ...body.target },
      trigger: body.trigger,
      enabled: body.enabled ?? true,
      createdAt: now,
      updatedAt: now,
      nextFireAt: new Date(Date.now() + 60_000).toISOString(),
      lastFiredAt: undefined,
      describe: `Mock describe for ${body.trigger.expr}`,
    };
    schedulesState.unshift(created);
    // Server's POST returns 201 with the entity (no `describe` —
    // that's enriched only on GET /:sid). Mirror exactly so the
    // wire shape lines up.
    const { describe: _describe, ...entity } = created;
    return HttpResponse.json(entity satisfies ScheduleView, { status: 201 });
  }),
  // GET /schedules/preview-cron — issue #222's unscoped preview.
  // MUST come BEFORE the GET /:sid handlers so MSW matches the
  // literal `preview-cron` path before the `:sid` wildcard.
  // Designer mode synthesises hourly-spaced nextRuns; cronstrue is
  // not a dashboard dep, so describe is a hand-rolled passthrough.
  http.get(`/api/workspaces/${W}/schedules/preview-cron`, ({ request }) => {
    const u = new URL(request.url);
    const expr = u.searchParams.get("expr") ?? "";
    const tz = u.searchParams.get("tz") ?? "";
    if (!expr || !tz) {
      return HttpResponse.json({ error: "expr+tz required" }, { status: 400 });
    }
    const rawN = u.searchParams.get("n");
    const n = Math.min(100, Math.max(1, Number.parseInt(rawN ?? "5", 10) || 5));
    const base = Date.now();
    const nextRuns = Array.from({ length: n }, (_, i) =>
      new Date(base + (i + 1) * 3_600_000).toISOString(),
    );
    return HttpResponse.json({ describe: `Mock describe for ${expr}`, nextRuns });
  }),
  http.get(`/api/workspaces/${W}/schedules/:sid`, ({ params }) => {
    const row = schedulesState.find((s) => s.id === params.sid);
    return row ? HttpResponse.json(row) : notFound("schedule not found");
  }),
  http.get(`/api/workspaces/${W}/schedules/:sid/preview`, ({ params, request }) => {
    const row = schedulesState.find((s) => s.id === params.sid);
    if (!row) return notFound("schedule not found");
    // Server enforces `[1, 100]`; mirror exactly so screenshots at the
    // boundary line up with prod behaviour.
    const nRaw = new URL(request.url).searchParams.get("n");
    const n = Math.min(100, Math.max(1, Number.parseInt(nRaw ?? "3", 10) || 3));
    const base = row.nextFireAt ? new Date(row.nextFireAt).getTime() : Date.now();
    const nextRuns = Array.from({ length: n }, (_, i) =>
      new Date(base + i * 3_600_000).toISOString(),
    );
    return HttpResponse.json({ describe: row.describe, nextRuns });
  }),
  // PATCH /schedules/task/:sid — URL-discriminated by `target.kind`
  // (#225–#229). `target` uses RFC 7396 deep-merge semantics: present
  // string sets, `null` deletes (`details` / `runtime`), absent keeps.
  // `trigger` is wholesale-replace; `name` / `enabled` are scalar-set.
  http.patch(`/api/workspaces/${W}/schedules/task/:sid`, async ({ params, request }) => {
    const idx = schedulesState.findIndex((s) => s.id === params.sid);
    if (idx === -1) return notFound("schedule not found");
    const body = (await request.json()) as PatchScheduleBody;
    const current = schedulesState[idx]!;
    let nextTarget = current.target;
    if (body.target !== undefined) {
      // Deep-merge per RFC 7396: keep `kind` (URL discriminates),
      // honour `null` on optional fields as delete, ignore absent.
      const t = { ...current.target };
      if (body.target.agent !== undefined) t.agent = body.target.agent;
      if (body.target.brief !== undefined) t.brief = body.target.brief;
      if (body.target.details === null) delete t.details;
      else if (body.target.details !== undefined) t.details = body.target.details;
      if (body.target.runtime === null) delete t.runtime;
      else if (body.target.runtime !== undefined) t.runtime = body.target.runtime;
      nextTarget = t;
    }
    const merged: ScheduleDetail = {
      ...current,
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.trigger !== undefined ? { trigger: body.trigger } : {}),
      target: nextTarget,
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      updatedAt: new Date().toISOString(),
    };
    schedulesState[idx] = merged;
    // Server's PATCH returns the entity without the describe enrichment
    // (re-derived only on GET); mirror that shape so the dashboard
    // doesn't get a stale describe baked into list rows.
    const { describe: _describe, ...entity } = merged;
    return HttpResponse.json(entity);
  }),
  http.delete(`/api/workspaces/${W}/schedules/:sid`, ({ params }) => {
    const idx = schedulesState.findIndex((s) => s.id === params.sid);
    if (idx === -1) return notFound("schedule not found");
    schedulesState.splice(idx, 1);
    return HttpResponse.json({ ok: true, deletedTaskCount: 0 });
  }),
  http.post(`/api/workspaces/${W}/schedules/:sid/run`, ({ params }) => {
    const row = schedulesState.find((s) => s.id === params.sid);
    if (!row) return notFound("schedule not found");
    // Synthesise a freshly-running task so the "Recent fires" panel
    // (which polls `/scheduled-tasks?scheduleId=…`) surfaces it on
    // the next refresh, and the dashboard's deep-link navigate to
    // `/runtime/tasks?taskId=<new>` shows a valid row instead of a
    // 404 "not found" detail pane.
    synthFireSeq += 1;
    const taskId = `sched-${row.id}-run-${synthFireSeq}`;
    const firedAt = new Date().toISOString();
    tasksState.unshift({
      id: taskId,
      agent: row.target.agent,
      brief: `${row.name} (manual run)`,
      origin: "schedule",
      status: "running",
      metadata: {
        workdir: `/mock/workspaces/designer/tasks/${taskId}`,
        ...(row.target.runtime !== undefined ? { runtime: row.target.runtime } : {}),
        scheduleId: row.id,
        firedAt,
      },
      createdAt: firedAt,
      startedAt: firedAt,
    });
    return HttpResponse.json({ taskId });
  }),

  // ── catch-all: 501 mutations + pass-through unknown GETs ─────
  // GETs that no handler above matched fall through to MSW's
  // `onUnhandledRequest: "warn"` setting (configured in browser.ts),
  // which logs a console warning so designers see what's missing.
  http.all("/api/*", ({ request }) => {
    if (request.method !== "GET") {
      console.warn(
        `[mocks] ${request.method} ${request.url} — read-only mocks; phase 2 tracked in #213`,
      );
      return HttpResponse.json(
        { error: "Mutations are not implemented in read-only mock mode (#213)" },
        { status: 501 },
      );
    }
    return undefined;
  }),
];
