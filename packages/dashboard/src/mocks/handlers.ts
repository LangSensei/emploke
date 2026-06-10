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
  CreateWorkflowBody,
  PatchScheduleBody,
  ScheduleDetail,
  ScheduleView,
  WorkflowHeaderWire,
  WorkflowNodeWire,
} from "../api/index.js";
import {
  artifactBodies,
  fixtureActiveWorkspaceId,
  fixtureActivities,
  fixtureAgents,
  fixtureSchedules,
  fixtureSessions,
  fixtureTasks,
  fixtureWorkflowArtifacts,
  fixtureWorkflowDags,
  fixtureWorkflows,
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
 * Ephemeral workflow mutation slice. Header rows live in
 * `workflowsState`, DAGs in `dagsState` keyed by workflow id. Both
 * reset on browser refresh — designer mode is non-persistent. Headers
 * are stored as mutable copies of the readonly fixtures so the cancel
 * handler can flip status / endedAt in place. The DAG shape uses a
 * local mutable mirror of the wire type so the cancel handler can
 * re-attach the updated header and re-write the node array without
 * colliding with the wire-type's `readonly` modifiers.
 */
interface MutableWorkflowDag {
  workflow: WorkflowHeaderWire;
  nodes: WorkflowNodeWire[];
  edges: { from: string; to: string }[];
}

const workflowsState: WorkflowHeaderWire[] = fixtureWorkflows.map((w) => ({ ...w }));
const dagsState: Map<string, MutableWorkflowDag> = new Map(
  Array.from(fixtureWorkflowDags.entries()).map(([id, dag]) => [
    id,
    {
      workflow: { ...dag.workflow },
      nodes: dag.nodes.map((n) => ({ ...n })),
      edges: dag.edges.map((e) => ({ ...e })),
    },
  ]),
);

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

/**
 * Full UUIDv4 for mock workflow node ids. Node ids must satisfy
 * `assertValidWorkflowNodeId`'s UUIDv4 grammar — the 8-char slice
 * produced by `cryptoRandom8` would throw at the substrate layer.
 * Falls back to a hand-shaped UUIDv4-like string when `crypto.randomUUID`
 * is absent (older test runners) so the mock still satisfies the
 * UUIDv4 regex.
 */
function cryptoUuid(): string {
  const u = globalThis.crypto?.randomUUID?.();
  if (u !== undefined) return u;
  const hex = (n: number) =>
    Math.floor(Math.random() * 16 ** n)
      .toString(16)
      .padStart(n, "0");
  // y in [8,9,a,b] per RFC 4122 §4.4
  const y = "89ab"[Math.floor(Math.random() * 4)];
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${y}${hex(3)}-${hex(12)}`;
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
    return HttpResponse.json({ ok: true, deletedDispatchCount: 0 });
  }),
  http.post(`/api/workspaces/${W}/schedules/:sid/run`, ({ params }) => {
    const row = schedulesState.find((s) => s.id === params.sid);
    if (!row) return notFound("schedule not found");
    // Synthesise a freshly-running task so:
    //   1. the "Recent fires" panel (which polls
    //      `/scheduled-tasks?scheduleId=…`) surfaces it on the
    //      next refresh triggered by the parent's `refreshToken`
    //      bump after Run now;
    //   2. clicking the row swaps the right-pane into Mode B
    //      (`FireTaskDetailPane`), which fetches the task by id
    //      and renders it inside the schedules page (no
    //      cross-page navigation).
    synthFireSeq += 1;
    const dispatchId = `sched-${row.id}-run-${synthFireSeq}`;
    const firedAt = new Date().toISOString();
    tasksState.unshift({
      id: dispatchId,
      agent: row.target.agent,
      brief: `${row.name} (manual run)`,
      origin: "schedule",
      status: "running",
      metadata: {
        workdir: `/mock/workspaces/designer/tasks/${dispatchId}`,
        ...(row.target.runtime !== undefined ? { runtime: row.target.runtime } : {}),
        scheduleId: row.id,
        firedAt,
      },
      createdAt: firedAt,
      startedAt: firedAt,
    });
    return HttpResponse.json({ dispatchId });
  }),

  // ── workflows (workspace-scoped) ─────────────────────────────
  // List + detail + DAG + create + cancel. Workflow rows live in
  // `workflowsState` and DAGs in `dagsState`; both reset on browser
  // refresh, same lifetime as `schedulesState`.
  http.get(`/api/workspaces/${W}/workflows`, ({ request }) => {
    const url = new URL(request.url);
    const q = url.searchParams.get("q") ?? "";
    const coordinatorAgent = url.searchParams.get("coordinatorAgent") ?? "";
    const createdSince = url.searchParams.get("createdSince") ?? "";
    let rows = workflowsState.slice();
    if (q !== "") rows = rows.filter((w) => w.id.includes(q));
    if (coordinatorAgent !== "") {
      rows = rows.filter((w) => w.coordinatorAgent === coordinatorAgent);
    }
    if (createdSince !== "") rows = rows.filter((w) => w.createdAt >= createdSince);
    rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return HttpResponse.json(rows);
  }),
  http.post(`/api/workspaces/${W}/workflows`, async ({ request }) => {
    const body = (await request.json()) as CreateWorkflowBody;
    if (typeof body.brief !== "string" || body.brief.trim() === "") {
      return HttpResponse.json({ error: "brief must be a non-empty string" }, { status: 400 });
    }
    if (typeof body.coordinatorAgent !== "string" || body.coordinatorAgent.trim() === "") {
      return HttpResponse.json(
        { error: "coordinatorAgent must be a non-empty agent FQN" },
        { status: 400 },
      );
    }
    const id = `wf-${cryptoRandom8()}`;
    const now = new Date().toISOString();
    const created: WorkflowHeaderWire = {
      id,
      brief: body.brief.trim(),
      ...(typeof body.details === "string" && body.details.trim() !== ""
        ? { details: body.details }
        : {}),
      status: "running",
      coordinatorAgent: body.coordinatorAgent,
      metadata: body.metadata ?? {},
      createdAt: now,
      startedAt: now,
      iterationCount: 0,
    };
    workflowsState.unshift(created);
    const coordNode: WorkflowNodeWire = {
      id: cryptoUuid(),
      workflowId: id,
      status: "running",
      phase: 0,
      spec: { kind: "coordinator", agent: body.coordinatorAgent },
      metadata: {},
      createdAt: now,
      readyAt: now,
      runningAt: now,
    };
    dagsState.set(id, {
      workflow: { ...created },
      nodes: [coordNode],
      edges: [],
    });
    return HttpResponse.json(created, { status: 201 });
  }),
  http.get(`/api/workspaces/${W}/workflows/:wfid`, ({ params }) => {
    const row = workflowsState.find((w) => w.id === params.wfid);
    return row ? HttpResponse.json(row) : notFound("workflow not found");
  }),
  http.get(`/api/workspaces/${W}/workflows/:wfid/dag`, ({ params }) => {
    const dag = dagsState.get(String(params.wfid));
    if (!dag) return notFound("workflow not found");
    const row = workflowsState.find((w) => w.id === params.wfid);
    if (row) dag.workflow = { ...row };
    return HttpResponse.json(dag);
  }),
  http.post(`/api/workspaces/${W}/workflows/:wfid/cancel`, async ({ params, request }) => {
    const idx = workflowsState.findIndex((w) => w.id === params.wfid);
    if (idx === -1) return notFound("workflow not found");
    const current = workflowsState[idx]!;
    if (current.status !== "running") {
      return HttpResponse.json(
        { error: `workflow is already ${current.status}; cancel is a no-op` },
        { status: 409 },
      );
    }
    // v2.2 wire: `{ cancellation: { kind?: 'user', message } }`. The
    // mock parses the message into the persisted `cancellation`
    // payload so the dashboard's optimistic re-render and the post-
    // cancel header show the operator-supplied reason.
    const body = (await request.json().catch(() => ({}))) as {
      cancellation?: { kind?: string; message?: string };
    };
    const message =
      typeof body?.cancellation?.message === "string" ? body.cancellation.message : "";
    const now = new Date().toISOString();
    const cancelled: WorkflowHeaderWire = {
      ...current,
      status: "cancelled",
      endedAt: now,
      cancellation: { kind: "user", message },
    };
    workflowsState[idx] = cancelled;
    const dag = dagsState.get(cancelled.id);
    if (dag) {
      dag.workflow = { ...cancelled };
      dag.nodes = dag.nodes.map((n) =>
        n.status === "ready" || n.status === "running"
          ? {
              ...n,
              status: "cancelled",
              endedAt: now,
            }
          : n,
      );
    }
    return HttpResponse.json(cancelled);
  }),
  // ── Workflow artifacts (list + bytes) ────────────────────────────
  http.get(`/api/workspaces/${W}/workflows/:wfid/artifacts`, ({ params }) => {
    const wfid = String(params.wfid);
    if (!workflowsState.some((w) => w.id === wfid)) {
      return notFound("workflow not found");
    }
    const list = fixtureWorkflowArtifacts.get(wfid) ?? [];
    return HttpResponse.json({ artifacts: list });
  }),
  http.get(`/api/workspaces/${W}/workflows/:wfid/artifacts/:encodedPath`, ({ params }) => {
    const wfid = String(params.wfid);
    const encodedPath = String(params.encodedPath);
    let decoded: string;
    try {
      decoded = decodeURIComponent(encodedPath);
    } catch {
      return HttpResponse.json({ error: "bad encoding" }, { status: 400 });
    }
    if (decoded.includes("..") || decoded.includes("\0")) {
      return HttpResponse.json({ error: "traversal" }, { status: 400 });
    }
    // Designer mode serves a tiny stub blob keyed on extension so
    // the Artifacts tab can render markdown / image / generic
    // previews end-to-end without wiring real fixture bytes.
    const list = fixtureWorkflowArtifacts.get(wfid);
    const exists = (list ?? []).some((a) => {
      if (decoded.startsWith("summary/")) {
        return a.kind === "workflow-summary" && a.path === decoded.slice("summary/".length);
      }
      if (decoded.startsWith("nodes/")) {
        const tail = decoded.slice("nodes/".length);
        const sep = tail.indexOf("/");
        if (sep <= 0) return false;
        const nodeId = tail.slice(0, sep);
        const restPath = tail.slice(sep + 1);
        return a.kind === "node" && a.nodeId === nodeId && a.path === restPath;
      }
      return false;
    });
    if (!exists) return HttpResponse.json({ error: "artifact not found" }, { status: 404 });
    const ext = decoded.slice(decoded.lastIndexOf(".") + 1).toLowerCase();
    if (ext === "md") {
      return new HttpResponse(
        `# Designer mode placeholder\n\nWorkflow \`${wfid}\` artifact \`${decoded}\`.\n`,
        { headers: { "Content-Type": "text/markdown; charset=utf-8" } },
      );
    }
    if (ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "webp") {
      // Same 1x1 transparent PNG (RFC-compliant) used for designer-mode previews.
      const pngBytes = Uint8Array.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
        0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00,
        0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
      ]);
      return new HttpResponse(pngBytes, { headers: { "Content-Type": "image/png" } });
    }
    return new HttpResponse(`Designer-mode artifact stub: ${decoded}\n`, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }),

  // ── catch-all: 501 mutations + pass-through unknown GETs ─────
  // GETs that no handler above matched fall through to MSW's
  // `onUnhandledRequest: "warn"` setting (configured in browser.ts),
  // which logs a console warning so designers see what's missing.
  http.all("/api/*", ({ request }) => {
    if (request.method !== "GET") {
      console.warn(
        `[mocks] ${request.method} ${request.url} — not mocked (only /schedules is implemented today; #213)`,
      );
      return HttpResponse.json(
        {
          error:
            "Mutation route not implemented in mock mode — only the /schedules slice is mocked today (#213)",
        },
        { status: 501 },
      );
    }
    return undefined;
  }),
];
