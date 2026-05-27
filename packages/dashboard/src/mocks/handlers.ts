/**
 * MSW request handlers for the dashboard's read surface.
 *
 * Every URL here mirrors a fetch call site in `packages/dashboard/src/api.ts`.
 * When adding a new dashboard route, mirror it here too (or add a fixture
 * entry the catch-all can serve) — otherwise designer mode will pass the
 * request through to the (non-existent) backend and log an
 * `onUnhandledRequest: "warn"` warning in the browser console.
 *
 * The handlers are deliberately read-only. Mutations (POST/PATCH/DELETE)
 * are caught by the trailing `http.all` handler that returns 501 with a
 * console.warn; tracking work for designer-mode mutations lives in
 * issue #213 (Designer mode phase 2).
 */

import { type DefaultBodyType, HttpResponse, http } from "msw";

import {
  artifactBodies,
  fixtureActiveWorkspaceId,
  fixtureActivities,
  fixtureAgents,
  fixtureSessions,
  fixtureTasks,
  fixtureWorkspaces,
} from "./fixtures/index.js";

const W = ":wsId";

function notFound(message: string): HttpResponse<DefaultBodyType> {
  return HttpResponse.json({ error: message }, { status: 404 });
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
    HttpResponse.json(fixtureTasks.filter((t) => t.origin === "standalone")),
  ),
  http.get(`/api/workspaces/${W}/scheduled-tasks`, () =>
    HttpResponse.json(fixtureTasks.filter((t) => t.origin === "schedule")),
  ),
  http.get(`/api/workspaces/${W}/tasks/:tid`, ({ params }) => {
    const task = fixtureTasks.find((t) => t.id === params.tid);
    return task ? HttpResponse.json(task) : notFound("task not found");
  }),
  http.get(`/api/workspaces/${W}/tasks/:tid/activity`, ({ params }) => {
    const tid = String(params.tid);
    const activity = fixtureActivities[tid];
    if (activity) return HttpResponse.json(activity);
    // Tasks without a hand-authored timeline still return a valid empty
    // payload — the dashboard's ActivityTab handles { activity: [] }
    // gracefully, but treats 404 as "runtime has no event log".
    if (fixtureTasks.some((t) => t.id === tid)) {
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
