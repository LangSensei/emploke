/**
 * Single source of truth for the emploke HTTP API surface.
 *
 * Each route is declared once as a {@link RouteSpec}, carrying:
 *  - `method` and `path` — used at server-boot to mount the Hono handler
 *    and at CLI/MCP-call to construct the URL
 *  - **phantom** request and response types — `RouteSpec<Req, Res>`
 *    parametrises the spec with the wire shapes so consumers (server
 *    handler, CLI client, future MCP wrapper) can type-check against
 *    the same contract
 *
 * **Drift protection** comes from two complementary mechanisms:
 *  1. The reflection test in `packages/server/test/route-manifest.test.ts`
 *     asserts that every Hono-registered route equals exactly one
 *     {@link ROUTES} entry — adding a route without updating the manifest
 *     (or vice versa) fails CI.
 *  2. The CLI's `ApiClient.call(key, opts)` is generic over `keyof ROUTES`
 *     — `key` autocompletes from the manifest, `opts.body` is typed by the
 *     route's request body type, and the return value is typed by the
 *     response type. CLI calls cannot reference a route that doesn't
 *     exist in the manifest, and a request body that doesn't match the
 *     declared shape fails to compile.
 *
 * Schema-drift protection on the **server** side is partial in this
 * iteration: handlers import their request-body types from this module
 * but still construct response payloads ad-hoc. A future `typedHandler`
 * wrapper can lock the response shape to `RouteRes<K>` at compile time;
 * for now the reflection test catches path/method drift and code review
 * catches body-shape drift between handlers and the manifest declarations.
 */

import type {
  Agent,
  AgentEntry,
  AgentInstallBody,
  AgentMetadataPatch,
  CatalogInstallResult,
  CatalogSyncResult,
  Mcp,
  Skill,
  SkillEntry,
  SkillInstallBody,
  SkillMetadataPatch,
} from "@emploke/catalog";
import type { ActivityItem, TruncationInfo } from "@emploke/runtime";
import type { PreviewResult, Schedule } from "@emploke/schedule";
import type { Session } from "@emploke/session";
import type { Task, TaskStatus } from "@emploke/task";
import type { HealthResponse } from "./health.js";
import type { ResolveManifest } from "./plan-to-manifest.js";
import type { RuntimeInfo } from "./runtimes.js";
import type { ScheduleWireTarget } from "./schedules.js";
import type { ServerConfig } from "./server-config.js";
import type {
  CreateWorkflowBody,
  WorkflowDagWire,
  WorkflowHeaderWire,
  WorkflowListQuery,
} from "./workflows.js";

// ──────────────────────────────────────────────────────────────────────
// Route spec primitives
// ──────────────────────────────────────────────────────────────────────

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Per-route request shape. Each field is optional so callers can declare
 * only what the route actually accepts:
 *
 *  - `body`   — JSON body (POST / PUT / PATCH). Undefined for GET / DELETE.
 *  - `query`  — query-string parameters. Each value is sent as a string;
 *               handlers parse / validate.
 *  - `params` — path placeholders. Keys MUST match every `:name` token in
 *               the route's `path` string; the CLI client substitutes them
 *               in URL construction.
 */
export interface RouteRequest {
  readonly body?: unknown;
  readonly query?: unknown;
  readonly params?: unknown;
}

/**
 * Compile-time contract for one HTTP route. The `_req` and `_res` fields
 * are phantom — never assigned, never read; they exist solely to carry
 * the type parameters through `typeof ROUTES[K]` lookups so consumers
 * can write `RouteReq<typeof ROUTES["..."]>` and get the right shape.
 */
export interface RouteSpec<Req extends RouteRequest = Record<string, never>, Res = unknown> {
  readonly method: HttpMethod;
  readonly path: string;
  /** Phantom; never read at runtime. */
  readonly _req: Req;
  /** Phantom; never read at runtime. */
  readonly _res: Res;
}

/**
 * Construct a typed {@link RouteSpec}. The `_req` and `_res` slots are
 * filled with a runtime placeholder (`undefined as any`) — the values are
 * never read, but TypeScript needs the property to exist for the generic
 * inference to flow through `typeof ROUTES[K]`.
 */
export function defineRoute<Req extends RouteRequest = Record<string, never>, Res = unknown>(
  method: HttpMethod,
  path: string,
): RouteSpec<Req, Res> {
  // biome-ignore lint/suspicious/noExplicitAny: phantom slots; never read.
  return { method, path, _req: undefined as any, _res: undefined as any };
}

/** Extract the request shape carried by a {@link RouteSpec}. */
export type RouteReq<R> = R extends RouteSpec<infer Req, unknown> ? Req : never;
/** Extract the response shape carried by a {@link RouteSpec}. */
export type RouteRes<R> = R extends RouteSpec<RouteRequest, infer Res> ? Res : never;

// ──────────────────────────────────────────────────────────────────────
// Shared request / response types
// ──────────────────────────────────────────────────────────────────────

/**
 * Wire shape of a workspace as returned by the workspaces routes. Subset
 * of the `@emploke/workspace` aggregate — only the fields the dashboard /
 * CLI need; internal book-keeping fields stay private to the package.
 *
 * `workspaceDir` is the workspace's root directory. The shorter name
 * `workdir` is reserved for derived per-entity working directories
 * (`Session.workdir` / `Task.workdir`).
 */
export interface WorkspaceSummary {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly workspaceDir: string;
  readonly lastOpenedAt: string;
}

/** POST /api/workspaces body. */
export interface WorkspaceCreateBody {
  /** Display name (required). */
  readonly name: string;
  /** Absolute filesystem path. When omitted, server mints `<EMPLOKE_HOME>/workspaces/<uuid>`. */
  readonly workspaceDir?: string;
}

/** PUT /api/workspaces/current body. */
export interface WorkspaceCurrentPutBody {
  readonly id: string;
}

/** PATCH /api/workspaces/:id body. The only mutable field today is `name`. */
export interface WorkspacePatchBody {
  /** New display name. Skipped when `undefined`. */
  readonly name?: string;
}

/** GET /api/workspaces/current response. `null` when no workspace is selected. */
export interface WorkspaceCurrentRes {
  readonly id: string | null;
}

/** GET /api/workspaces/:id/sessions query params. ISO 8601 timestamps. */
export interface SessionListQuery {
  readonly agent?: string;
  readonly createdSince?: string;
  readonly activeSince?: string;
}

/** POST /api/workspaces/:id/sessions body. */
export interface SessionCreateBody {
  readonly agent: string;
  readonly runtime?: string;
}

/** DELETE /api/workspaces/:id/sessions/:sid query params. `1` = enabled. */
export interface SessionDeleteQuery {
  readonly purge?: "1";
}

/** POST /api/workspaces/:id/sessions/:sid/spawn body. */
export interface SessionSpawnBody {
  /** When `true`, build a remote-launch command instead of a local one. */
  readonly remote?: boolean;
}

/** Response from the spawn route. Indicates whether terminal launch succeeded. */
export type SessionSpawnRes =
  | { readonly ok: true; readonly launcher: string; readonly display: string }
  | { readonly ok: false; readonly error: string; readonly code: string; readonly display: string };

/**
 * GET /api/workspaces/:id/tasks query params (standalone-only route).
 * CSV `status` is parsed server-side.
 *
 * The route is standalone-only by construction — `origin` is hardcoded
 * at the handler layer; callers cannot widen the result set via a
 * query param. Schedule-launched tasks live at `/scheduled-tasks`
 * (see {@link ScheduledTaskListQuery}); workflow-launched tasks will
 * move to their own dedicated route in a future PR.
 */
export interface TaskListQuery {
  readonly agent?: string;
  readonly runtime?: string;
  readonly createdSince?: string;
  /** Comma-separated list of {@link TaskStatus}. */
  readonly status?: string;
}

/**
 * GET /api/workspaces/:id/scheduled-tasks query params (schedule-only route).
 * Same shape as {@link TaskListQuery} plus `scheduleId` for filtering
 * down to a single schedule's runs. CSV `status` is parsed server-side.
 *
 * The route is schedule-only by construction — `origin` is hardcoded
 * at the handler layer; callers cannot widen the result set via a
 * query param.
 */
export interface ScheduledTaskListQuery {
  readonly agent?: string;
  readonly runtime?: string;
  readonly createdSince?: string;
  /** Comma-separated list of {@link TaskStatus}. */
  readonly status?: string;
  /** Exact match on `metadata.scheduleId`. */
  readonly scheduleId?: string;
}

/** GET /api/workspaces/:id/schedules query params. */
export interface ScheduleListQuery {
  /** Filter to schedules whose `target.agent` matches this exact value. */
  readonly agent?: string;
  /** Filter on `enabled` flag. `"true"` / `"false"` (string per query convention). */
  readonly enabled?: "true" | "false";
}

/**
 * POST /api/workspaces/:id/schedules/task body. Kind-discriminated
 * by URL — the body carries no `target.kind` (the server injects
 * `"task"` before forwarding to `ScheduleService.createTask`).
 *
 * `trigger.tz` is required at the wire layer (the schedule service
 * itself does NOT default a timezone — every fire is timezone-anchored,
 * so the user must commit to one explicitly). If callers want UTC,
 * they pass `"UTC"`.
 */
export interface TaskScheduleCreateBody {
  readonly name: string;
  readonly target: {
    readonly agent: string;
    /** Single line, ≤ 200 chars. Mirrors `@emploke/task` `DispatchOpts.brief`. */
    readonly brief: string;
    /** Optional multi-line body. Mirrors `@emploke/task` `DispatchOpts.details`. */
    readonly details?: string;
    readonly runtime?: string;
  };
  readonly trigger: {
    readonly kind: "cron";
    readonly expr: string;
    readonly tz: string;
  };
  readonly enabled?: boolean;
}

/**
 * PATCH /api/workspaces/:id/schedules/task/:sid body — RFC 7396
 * deep-merge for `target`, wholesale-replace for `trigger`,
 * scalar-set for `name` / `enabled`.
 *
 * - `name` / `enabled` — set if present, otherwise keep existing.
 * - `trigger` — wholesale replace if present (small atomic shape; no
 *   partial trigger; `null` rejected).
 * - `target` — RFC 7396 deep-merge per field:
 *     - `agent` / `brief`: set if present; `null` rejected (required
 *       fields — omit to keep existing).
 *     - `details` / `runtime`: string sets, `null` deletes, absent keeps.
 *   `target.kind` MUST NOT be set (URL discriminates).
 */
export interface TaskSchedulePatchBody {
  readonly name?: string;
  readonly target?: {
    readonly agent?: string;
    readonly brief?: string;
    readonly details?: string | null;
    readonly runtime?: string | null;
  };
  readonly trigger?: TaskScheduleCreateBody["trigger"];
  readonly enabled?: boolean;
}

/** Path params for per-schedule routes. */
export interface SchedulePathParams {
  /** Workspace id (UUID). */
  readonly id: string;
  /** Schedule id (UUID v4). */
  readonly sid: string;
}

/**
 * GET /api/workspaces/:id/schedules/:sid response. Mirrors `Schedule`
 * but adds a derived `describe` field (zh_CN human-readable cron
 * text) so the dashboard and `emploke schedule show` can render it
 * without a second round-trip. The field is computed on the response
 * — it is NOT persisted on the entity (the underlying cron
 * expression is the single source of truth; persisting `describe`
 * would require keeping it in sync on every patch + a migration).
 *
 * The `target` field is the FLAT wire shape (`ScheduleWireTarget`),
 * not the internal envelope — the server's `projectScheduleToWire`
 * helper converts on the way out. Dashboard / CLI code keeps
 * reading `schedule.target.agent` etc.
 */
export interface ScheduleGetResponse extends Omit<Schedule, "target"> {
  readonly target: ScheduleWireTarget;
  readonly describe: string;
}

/**
 * GET / list response item. Same flat-target projection as
 * {@link ScheduleGetResponse} but without the derived `describe`
 * field (list endpoints stay terse).
 */
export type ScheduleWire = Omit<Schedule, "target"> & {
  readonly target: ScheduleWireTarget;
};

/**
 * GET /api/workspaces/:id/schedules/:sid/preview query params.
 *
 * `n` is optional and validated as integer in `[1, 100]` at both the
 * route boundary and inside `ScheduleService.preview`. The double
 * check keeps each layer self-defending: the route emits a typed 400
 * envelope before reaching the service; the service still rejects an
 * out-of-range value if invoked directly (tests, future programmatic
 * users).
 */
export interface SchedulePreviewQuery {
  readonly n?: string;
}

/**
 * GET /api/workspaces/:id/schedules/preview-cron query params.
 *
 * Unscoped sibling of {@link SchedulePreviewQuery} for previewing an
 * arbitrary cron expression without a saved entity — used by the
 * dashboard's "New schedule" modal. `expr` and `tz` are
 * required (route returns 400 if missing or blank); `n` is optional,
 * defaults to **5** (modal default; differs from `/:sid/preview`'s
 * default of 3), bounded `[1, 100]` with strict integer parsing.
 */
export interface SchedulePreviewCronQuery {
  readonly expr: string;
  readonly tz: string;
  readonly n?: string;
}

/** POST /api/workspaces/:id/tasks body. */
export interface TaskDispatchBody {
  readonly agent: string;
  /**
   * Short, single-line task title. Required. Must be ≤ 200 chars
   * after trim and may not contain `\n` or `\r` (the displayed
   * label is single-line everywhere). The route layer rejects
   * violations with 400.
   */
  readonly brief: string;
  /**
   * Optional long-form task body. Multi-line allowed; rendered as
   * the markdown body of `<workdir>/TASK.md` under the `# <brief>`
   * header. Omit for a brief-only task.
   */
  readonly details?: string;
  readonly runtime?: string;
}

/** DELETE /api/workspaces/:id/tasks/:tid query params. */
export interface TaskDeleteQuery {
  readonly purge?: "1";
}

/**
 * GET /api/workspaces/:id/tasks/:tid/activity query params.
 * Pagination is server-controlled — the manifest declares the
 * shapes; the server route enforces the default limit (50) and
 * hard maximum (500) and rejects malformed integers with 400.
 *
 * `before` and `after` are mutually exclusive; the route returns
 * 400 if both are supplied. Omitting both returns the LATEST
 * `limit` items overall (tail), which is what GUI consumers want
 * on initial load.
 */
export interface TaskActivityQuery {
  /**
   * Backward pagination: return items with `seq < before`. Returns
   * the `limit` items immediately preceding the cut, ASC-sorted.
   * Used by GUI consumers loading older history when the user
   * scrolls up past the initial tail-window.
   */
  readonly before?: string;
  /**
   * Forward pagination: return items with `seq > after`. Used by
   * SSE polling and by callers walking head-to-tail.
   */
  readonly after?: string;
  /**
   * Maximum items to return. Server clamps to [1, 500]; default 50
   * when omitted. Sized for LLM token budgets when this endpoint
   * is reached via MCP.
   */
  readonly limit?: string;
}

/**
 * POST /api/workspaces/:id/catalog/{kind}/:name/sync body. The
 * `planToken` is minted by the matching `/sync/resolve` (returned
 * inside the `ResolveManifest`) and is single-use + 5-min TTL on
 * the server. See {@link CatalogService.cachePlan} / `takePlan`
 * for the rationale: the apply step replays the exact preview-time
 * plan rather than re-resolving (which would silently apply a
 * fresh, possibly-different closure).
 */
export interface CatalogSyncBody {
  readonly planToken: string;
}

/** GET /api/workspaces/:id/catalog/overview response. */
export interface CatalogOverview {
  readonly counts: {
    readonly skills: number;
    readonly agents: number;
    readonly mcps: number;
    readonly blocked: number;
    readonly orphaned: number;
  };
}

/** PUT body shared by content-update routes (skills / agents / mcps). */
export interface ContentUpdateBody {
  readonly content: string;
}

/** GET /api/workspaces/:id/catalog/skills/:name response (entry + content). */
export type SkillWithContent = SkillEntry & { readonly content: string };

/** GET /api/workspaces/:id/catalog/agents/:name response. */
export type AgentWithContent = AgentEntry & { readonly content: string };

/** GET /api/workspaces/:id/catalog/{agents,skills}/:name/anchor response. */
export interface AnchorResponse {
  readonly content: string;
}

/** GET /api/workspaces/:id/catalog/mcps/:name response. */
export type McpWithContent = Mcp & { readonly content: string };

/** Generic `{ ok: true }` response shape for delete / put-content endpoints. */
export interface OkResponse {
  readonly ok: true;
}

/**
 * DELETE /api/workspaces/:id/schedules/:sid response.
 *
 * Cascade-delete semantics (see `ScheduleService.delete`): the
 * trigger is removed AND every TERMINAL unit-of-work the schedule
 * ever fired is purged via the registered kind handler's
 * `deleteForSchedule` (for the task kind, that's terminal tasks).
 * `deletedDispatchCount` is the number of historical rows the
 * handler removed in the same operation. In-flight dispatches are
 * protected by the pre-flight 409 (`SCHEDULE_HAS_INFLIGHT`) — they
 * are never touched by the cascade.
 *
 * Surfaced in: CLI suffix ("schedule X removed (and N historical
 * dispatches)"), dashboard confirm-modal post-delete toast.
 */
export interface ScheduleDeleteResponse {
  readonly ok: true;
  readonly deletedDispatchCount: number;
}

/**
 * POST /api/workspaces/:id/schedules/:sid/run response. The
 * substrate-side id of the unit-of-work the kind handler dispatched
 * — for the task kind, that's the new task id.
 */
export interface ScheduleRunResponse {
  readonly dispatchId: string;
}

/** Standard error envelope. Returned by handlers via `errorBody(err)`. */
export interface ApiError {
  readonly error: string;
  readonly code?: string;
}

// Common path-param shapes ─────────────────────────────────────────────

/** Workspace-scoped resource path params. */
export interface WorkspacePathParams {
  readonly id: string;
}
/** Session-scoped path params. */
export interface SessionPathParams {
  readonly id: string;
  readonly sid: string;
}
/** Task-scoped path params. */
export interface TaskPathParams {
  readonly id: string;
  readonly tid: string;
}
/** Workflow-scoped path params (header / dag / cancel). */
export interface WorkflowPathParams {
  readonly id: string;
  readonly wfid: string;
}
/** Catalog-resource path params (skills / agents / mcps). `name` may contain slashes. */
export interface CatalogResourcePathParams {
  readonly id: string;
  readonly name: string;
}

// ──────────────────────────────────────────────────────────────────────
// ROUTES — the manifest. Add routes here AND in the matching handler;
// the reflection test enforces the bijection.
// ──────────────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/consistent-type-definitions */

export const ROUTES = {
  // ── unauthenticated / global ───────────────────────────────────────
  "health.get": defineRoute<Record<string, never>, HealthResponse>("GET", "/api/health"),
  "config.get": defineRoute<Record<string, never>, ServerConfig>("GET", "/api/config"),
  /**
   * Returns each registered runtime's kind + capability bag so
   * dashboard / CLI can branch on capability flags
   * (e.g. `capabilities.remoteSession`).
   */
  "runtimes.list": defineRoute<Record<string, never>, readonly RuntimeInfo[]>(
    "GET",
    "/api/runtimes",
  ),

  // ── workspaces (top-level) ─────────────────────────────────────────
  "workspaces.list": defineRoute<Record<string, never>, readonly WorkspaceSummary[]>(
    "GET",
    "/api/workspaces",
  ),
  "workspaces.create": defineRoute<{ body: WorkspaceCreateBody }, WorkspaceSummary>(
    "POST",
    "/api/workspaces",
  ),
  "workspaces.getCurrent": defineRoute<Record<string, never>, WorkspaceCurrentRes>(
    "GET",
    "/api/workspaces/current",
  ),
  "workspaces.setCurrent": defineRoute<{ body: WorkspaceCurrentPutBody }, WorkspaceCurrentRes>(
    "PUT",
    "/api/workspaces/current",
  ),
  "workspaces.get": defineRoute<{ params: WorkspacePathParams }, WorkspaceSummary>(
    "GET",
    "/api/workspaces/:id",
  ),
  "workspaces.update": defineRoute<
    { params: WorkspacePathParams; body: WorkspacePatchBody },
    WorkspaceSummary
  >("PATCH", "/api/workspaces/:id"),
  "workspaces.delete": defineRoute<{ params: WorkspacePathParams; query: { purge?: "1" } }, void>(
    "DELETE",
    "/api/workspaces/:id",
  ),
  "workspaces.reload": defineRoute<{ params: WorkspacePathParams }, void>(
    "POST",
    "/api/workspaces/:id/reload",
  ),

  // ── sessions (workspace-scoped) ────────────────────────────────────
  "sessions.list": defineRoute<
    { params: WorkspacePathParams; query: SessionListQuery },
    readonly Session[]
  >("GET", "/api/workspaces/:id/sessions"),
  "sessions.create": defineRoute<{ params: WorkspacePathParams; body: SessionCreateBody }, Session>(
    "POST",
    "/api/workspaces/:id/sessions",
  ),
  "sessions.get": defineRoute<{ params: SessionPathParams }, Session>(
    "GET",
    "/api/workspaces/:id/sessions/:sid",
  ),
  "sessions.delete": defineRoute<{ params: SessionPathParams; query: SessionDeleteQuery }, void>(
    "DELETE",
    "/api/workspaces/:id/sessions/:sid",
  ),
  "sessions.spawn": defineRoute<
    { params: SessionPathParams; body: SessionSpawnBody },
    SessionSpawnRes
  >("POST", "/api/workspaces/:id/sessions/:sid/spawn"),

  // ── tasks (workspace-scoped) ───────────────────────────────────────
  "tasks.list": defineRoute<{ params: WorkspacePathParams; query: TaskListQuery }, readonly Task[]>(
    "GET",
    "/api/workspaces/:id/tasks",
  ),
  /**
   * Schedule-origin sibling of `tasks.list`. Same response shape
   * (`Task[]`) but the server constrains origin to
   * `'schedule'` server-side; callers cannot widen via the URL. Each
   * origin's caller surface gets a route whose URL IS the contract.
   * Per-task surfaces (get, cancel, activity) stay on
   * `/tasks/:tid` since task ids are globally unique.
   */
  "scheduledTasks.list": defineRoute<
    { params: WorkspacePathParams; query: ScheduledTaskListQuery },
    readonly Task[]
  >("GET", "/api/workspaces/:id/scheduled-tasks"),

  // ── schedules (workspace-scoped) ───────────────────────────────────
  "schedules.list": defineRoute<
    { params: WorkspacePathParams; query: ScheduleListQuery },
    readonly ScheduleWire[]
  >("GET", "/api/workspaces/:id/schedules"),
  /**
   * Create a task-kind schedule. URL-discriminated by `target.kind`
   * so the body can omit `kind` (the URL declares it) — the server
   * narrows the body to `TaskTargetData` then calls
   * `service.create({ name, trigger, target: { kind: "task", data }, enabled })`.
   * When a `workflow` target lands later it gets its own
   * `schedules.workflow.create` route.
   */
  "schedules.task.create": defineRoute<
    { params: WorkspacePathParams; body: TaskScheduleCreateBody },
    ScheduleWire
  >("POST", "/api/workspaces/:id/schedules/task"),
  "schedules.get": defineRoute<{ params: SchedulePathParams }, ScheduleGetResponse>(
    "GET",
    "/api/workspaces/:id/schedules/:sid",
  ),
  /**
   * Patch a task-kind schedule with RFC 7396 deep-merge semantics
   * on `target` (siblings preserved; `null` deletes optional fields),
   * wholesale-replace on `trigger`, and scalar-set on
   * `name` / `enabled`. URL-discriminated by `target.kind`: the
   * server passes `expectedKind: "task"` to `service.patch`; if
   * `:sid` exists but its `target.kind !== "task"` the service
   * throws `ScheduleKindMismatchError` which the route projects to
   * a generic 404 envelope (no kind-information leak).
   */
  "schedules.task.patch": defineRoute<
    { params: SchedulePathParams; body: TaskSchedulePatchBody },
    ScheduleWire
  >("PATCH", "/api/workspaces/:id/schedules/task/:sid"),
  "schedules.delete": defineRoute<{ params: SchedulePathParams }, ScheduleDeleteResponse>(
    "DELETE",
    "/api/workspaces/:id/schedules/:sid",
  ),
  /**
   * Manual fire-now. Server invokes `ScheduleService.run(sid)` which
   * dispatches through the registered kind handler under the same
   * code path as a cron-driven fire. Does NOT advance the schedule's
   * `lastFiredAt` / `nextFireAt` cursor — manual runs are out-of-band
   * and the next cron fire still lands on its expected wall clock.
   *
   * Returns `{ dispatchId }` (the handler's substrate-side id —
   * for the task kind, that's the task id) so the caller can poll /
   * cancel the resulting unit-of-work without a second round-trip.
   */
  "schedules.run": defineRoute<{ params: SchedulePathParams }, ScheduleRunResponse>(
    "POST",
    "/api/workspaces/:id/schedules/:sid/run",
  ),
  /**
   * Read-only — compute the next N fires for this schedule from now,
   * plus a zh_CN human-readable description of the cron expression.
   * Does not touch state. `n` is bounded in `[1, 100]` (see
   * {@link SchedulePreviewQuery}).
   */
  "schedules.preview": defineRoute<
    { params: SchedulePathParams; query: SchedulePreviewQuery },
    PreviewResult
  >("GET", "/api/workspaces/:id/schedules/:sid/preview"),
  /**
   * Unscoped preview for an arbitrary `(expr, tz)` pair.
   * Wraps `ScheduleService.preview(expr, tz, n)` directly without
   * an entity lookup so the dashboard's "New schedule" modal can
   * render `{ describe, nextRuns }` while the user is still typing.
   * `n` defaults to 5 (modal preview count); same `[1, 100]` bound
   * as `/:sid/preview`. MUST be mounted before `/:sid` so the
   * literal path wins over `:sid = "preview-cron"`.
   */
  "schedules.previewCron": defineRoute<
    { params: WorkspacePathParams; query: SchedulePreviewCronQuery },
    PreviewResult
  >("GET", "/api/workspaces/:id/schedules/preview-cron"),

  // ── workflows (workspace-scoped) ───────────────────────────────────
  /**
   * List workflows in this workspace, newest-first by `created_at`.
   * Optional `?status=` narrows to one lifecycle status; an unknown
   * value yields HTTP 400 at the route boundary (the substrate would
   * silently return `[]` otherwise).
   *
   * `iterationCount` on the response items is reported as `0` on
   * list responses to keep the endpoint O(workflows): computing the
   * true value would require N+1 node-count queries. Callers that
   * need an accurate count fetch the workflow header
   * (`workflows.get`) which derives it from a single per-workflow
   * node count.
   */
  "workflows.list": defineRoute<
    { params: WorkspacePathParams; query: WorkflowListQuery },
    readonly WorkflowHeaderWire[]
  >("GET", "/api/workspaces/:id/workflows"),
  /**
   * Seed a new workflow + its initial coordinator node. Body mirrors
   * `WorkflowService.createWorkflow` args.
   */
  "workflows.create": defineRoute<
    { params: WorkspacePathParams; body: CreateWorkflowBody },
    WorkflowHeaderWire
  >("POST", "/api/workspaces/:id/workflows"),
  /**
   * Workflow header lookup. `iterationCount` is computed exactly
   * from a single per-workflow node-list query (counts coord-kind
   * nodes; silent-retry coords count too).
   */
  "workflows.get": defineRoute<{ params: WorkflowPathParams }, WorkflowHeaderWire>(
    "GET",
    "/api/workspaces/:id/workflows/:wfid",
  ),
  /** Full DAG snapshot (header + nodes + edges) in a single fetch. */
  "workflows.dag": defineRoute<{ params: WorkflowPathParams }, WorkflowDagWire>(
    "GET",
    "/api/workspaces/:id/workflows/:wfid/dag",
  ),
  /**
   * External cancel — flips the workflow to `cancelled` and
   * reconciles every non-terminal node. The route takes no request
   * body (the substrate's `CancelWorkflowArgs` has no `reason`
   * field). Returns the updated workflow header so callers see the
   * post-cancel `endedAt` / `status` without a second round-trip.
   */
  "workflows.cancel": defineRoute<{ params: WorkflowPathParams }, WorkflowHeaderWire>(
    "POST",
    "/api/workspaces/:id/workflows/:wfid/cancel",
  ),

  "tasks.dispatch": defineRoute<{ params: WorkspacePathParams; body: TaskDispatchBody }, Task>(
    "POST",
    "/api/workspaces/:id/tasks",
  ),
  "tasks.get": defineRoute<{ params: TaskPathParams }, Task>(
    "GET",
    "/api/workspaces/:id/tasks/:tid",
  ),
  "tasks.delete": defineRoute<{ params: TaskPathParams; query: TaskDeleteQuery }, void>(
    "DELETE",
    "/api/workspaces/:id/tasks/:tid",
  ),
  /**
   * Cancel a running task. POST is the verb because cancellation is
   * a state transition; DELETE is reserved for tasks.delete. The
   * route takes no request body.
   *
   * Status mappings:
   *   - 200 + Task — happy path; the response Task carries a
   *     {@link TaskCancellation}. The `cancellation.kind` enumerates as:
   *       - `'user'`   — the normal path: the manager killed a live
   *         subprocess at the operator's request. `message` is
   *         `'cancelled by user'`.
   *       - `'orphan'` — `cancel(id)` was called on a `running` row
   *         whose live entry has gone (an undetected orphan that
   *         `recoverOrphaned` missed). The row is reconciled to
   *         `cancelled` via the same terminal write so the dashboard
   *         renders symmetrically.
   *   - 404 — TaskNotFoundError (unknown id).
   *   - 409 — InvalidTransition; body is the structured envelope
   *     `{ error, code: 'InvalidTransition', status: <prev>,
   *     transition: 'cancel' }` so the dashboard can branch typed on
   *     `code`.
   *   - 503 — ManagerShuttingDownError (server is restarting). No
   *     `cancellation` is produced — the call refuses outright so the
   *     caller can retry once the manager is up.
   */
  "tasks.cancel": defineRoute<{ params: TaskPathParams }, Task>(
    "POST",
    "/api/workspaces/:id/tasks/:tid/cancel",
  ),
  /**
   * Runtime-neutral activity timeline: the runtime parses its own
   * event log into the {@link ActivityItem} discriminated union
   * declared in `@emploke/runtime` (end-to-end via
   * `Runtime.readActivity` — the route never sees a path or raw
   * bytes). Paginated by `before` / `after` / `limit`; `truncated`
   * marker is non-null when the runtime had to drop bytes/items to
   * stay within its safety cap. 404 NoEventsYet when the runtime
   * hasn't produced events yet (or doesn't implement the activity
   * surface).
   *
   * Clients derive `hasOlder` / `hasNewer` from the page window
   * (`activity[0].seq > 0` / `activity[last].seq < totalItems - 1`)
   * — items themselves are the cursor, no separate cursor field.
   */
  "tasks.activity": defineRoute<
    { params: TaskPathParams; query: TaskActivityQuery },
    {
      activity: readonly ActivityItem[];
      result: string | null;
      totalItems: number;
      truncated?: TruncationInfo;
    }
  >("GET", "/api/workspaces/:id/tasks/:tid/activity"),

  /**
   * SSE live-tail of activity. Subscribes to
   * `Runtime.streamActivity` and frames each
   * {@link ActivityItem} as `event: activity` with the JSON payload.
   * Sends `event: end` when the iterator completes (task terminal,
   * file gone, server shutdown). The client SHOULD use the
   * one-shot `tasks.activity` endpoint to fetch history first,
   * then subscribe here for the live tail with
   * `Last-Event-ID: <seq>` to dedup.
   *
   * Marked human-only — NOT exposed via MCP. LLM consumers should
   * use the paginated `tasks.activity` endpoint instead.
   */
  "tasks.activity.stream": defineRoute<{ params: TaskPathParams }, never>(
    "GET",
    "/api/workspaces/:id/tasks/:tid/activity/stream",
  ),

  /**
   * Serve a single artifact file produced by a terminal task. The
   * `:name` segment must appear (by basename) in the task's
   * `success.artifacts` array; anything else is 404. The route
   * additionally rejects names containing path separators or `..` as
   * a 400 defence-in-depth (the whitelist check is the actual
   * security boundary).
   *
   * Response is the file's bytes with a best-effort `Content-Type`
   * (text/* and well-known image types get the canonical mime;
   * everything else is `application/octet-stream`).
   *
   * Not exposed via MCP — agents already write the files; downloading
   * them back through HTTP would just round-trip bytes the agent
   * already has.
   */
  "tasks.artifact": defineRoute<{ params: TaskPathParams & { name: string } }, never>(
    "GET",
    "/api/workspaces/:id/tasks/:tid/artifact/:name",
  ),

  // ── catalog overview (workspace-scoped) ────────────────────────────
  "catalog.overview": defineRoute<{ params: WorkspacePathParams }, CatalogOverview>(
    "GET",
    "/api/workspaces/:id/catalog/overview",
  ),

  // ── catalog skills ─────────────────────────────────────────────────
  "catalog.skills.list": defineRoute<{ params: WorkspacePathParams }, readonly SkillEntry[]>(
    "GET",
    "/api/workspaces/:id/catalog/skills",
  ),
  "catalog.skills.resolve": defineRoute<
    { params: WorkspacePathParams; body: SkillInstallBody },
    ResolveManifest
  >("POST", "/api/workspaces/:id/catalog/skills/resolve"),
  "catalog.skills.get": defineRoute<{ params: CatalogResourcePathParams }, SkillWithContent>(
    "GET",
    "/api/workspaces/:id/catalog/skills/:name",
  ),
  "catalog.skills.anchor": defineRoute<{ params: CatalogResourcePathParams }, AnchorResponse>(
    "GET",
    "/api/workspaces/:id/catalog/skills/:name/anchor",
  ),
  "catalog.skills.install": defineRoute<
    { params: WorkspacePathParams; body: SkillInstallBody },
    CatalogInstallResult
  >("POST", "/api/workspaces/:id/catalog/skills"),
  "catalog.skills.updateContent": defineRoute<
    { params: CatalogResourcePathParams; body: ContentUpdateBody },
    SkillEntry
  >("PUT", "/api/workspaces/:id/catalog/skills/:name"),
  "catalog.skills.updateMetadata": defineRoute<
    { params: CatalogResourcePathParams; body: SkillMetadataPatch },
    SkillEntry
  >("PATCH", "/api/workspaces/:id/catalog/skills/:name"),
  "catalog.skills.delete": defineRoute<{ params: CatalogResourcePathParams }, OkResponse>(
    "DELETE",
    "/api/workspaces/:id/catalog/skills/:name",
  ),
  "catalog.skills.syncResolve": defineRoute<{ params: CatalogResourcePathParams }, ResolveManifest>(
    "POST",
    "/api/workspaces/:id/catalog/skills/:name/sync/resolve",
  ),
  "catalog.skills.sync": defineRoute<
    { params: CatalogResourcePathParams; body: CatalogSyncBody },
    CatalogSyncResult
  >("POST", "/api/workspaces/:id/catalog/skills/:name/sync"),
  "catalog.skills.acknowledgePrereqs": defineRoute<{ params: CatalogResourcePathParams }, Skill>(
    "POST",
    "/api/workspaces/:id/catalog/skills/:name/acknowledge-prereqs",
  ),

  // ── catalog agents ─────────────────────────────────────────────────
  "catalog.agents.list": defineRoute<{ params: WorkspacePathParams }, readonly AgentEntry[]>(
    "GET",
    "/api/workspaces/:id/catalog/agents",
  ),
  "catalog.agents.resolve": defineRoute<
    { params: WorkspacePathParams; body: AgentInstallBody },
    ResolveManifest
  >("POST", "/api/workspaces/:id/catalog/agents/resolve"),
  "catalog.agents.get": defineRoute<{ params: CatalogResourcePathParams }, AgentWithContent>(
    "GET",
    "/api/workspaces/:id/catalog/agents/:name",
  ),
  "catalog.agents.anchor": defineRoute<{ params: CatalogResourcePathParams }, AnchorResponse>(
    "GET",
    "/api/workspaces/:id/catalog/agents/:name/anchor",
  ),
  "catalog.agents.install": defineRoute<
    { params: WorkspacePathParams; body: AgentInstallBody },
    CatalogInstallResult
  >("POST", "/api/workspaces/:id/catalog/agents"),
  "catalog.agents.updateContent": defineRoute<
    { params: CatalogResourcePathParams; body: ContentUpdateBody },
    AgentEntry
  >("PUT", "/api/workspaces/:id/catalog/agents/:name"),
  "catalog.agents.updateMetadata": defineRoute<
    { params: CatalogResourcePathParams; body: AgentMetadataPatch },
    AgentEntry
  >("PATCH", "/api/workspaces/:id/catalog/agents/:name"),
  "catalog.agents.delete": defineRoute<{ params: CatalogResourcePathParams }, OkResponse>(
    "DELETE",
    "/api/workspaces/:id/catalog/agents/:name",
  ),
  "catalog.agents.syncResolve": defineRoute<{ params: CatalogResourcePathParams }, ResolveManifest>(
    "POST",
    "/api/workspaces/:id/catalog/agents/:name/sync/resolve",
  ),
  "catalog.agents.sync": defineRoute<
    { params: CatalogResourcePathParams; body: CatalogSyncBody },
    CatalogSyncResult
  >("POST", "/api/workspaces/:id/catalog/agents/:name/sync"),
  "catalog.agents.acknowledgePrereqs": defineRoute<{ params: CatalogResourcePathParams }, Agent>(
    "POST",
    "/api/workspaces/:id/catalog/agents/:name/acknowledge-prereqs",
  ),
  "catalog.agents.disable": defineRoute<{ params: CatalogResourcePathParams }, Agent>(
    "POST",
    "/api/workspaces/:id/catalog/agents/:name/disable",
  ),
  "catalog.agents.enable": defineRoute<{ params: CatalogResourcePathParams }, Agent>(
    "POST",
    "/api/workspaces/:id/catalog/agents/:name/enable",
  ),

  // ── catalog mcps (no resolve, no metadata patch) ───────────────────
  "catalog.mcps.list": defineRoute<{ params: WorkspacePathParams }, readonly Mcp[]>(
    "GET",
    "/api/workspaces/:id/catalog/mcps",
  ),
  "catalog.mcps.get": defineRoute<{ params: CatalogResourcePathParams }, McpWithContent>(
    "GET",
    "/api/workspaces/:id/catalog/mcps/:name",
  ),
  "catalog.mcps.install": defineRoute<
    {
      params: WorkspacePathParams;
      body: { readonly origin: string };
    },
    CatalogInstallResult
  >("POST", "/api/workspaces/:id/catalog/mcps"),
  "catalog.mcps.updateContent": defineRoute<
    { params: CatalogResourcePathParams; body: ContentUpdateBody },
    OkResponse
  >("PUT", "/api/workspaces/:id/catalog/mcps/:name"),
  "catalog.mcps.delete": defineRoute<{ params: CatalogResourcePathParams }, OkResponse>(
    "DELETE",
    "/api/workspaces/:id/catalog/mcps/:name",
  ),
  "catalog.mcps.syncResolve": defineRoute<{ params: CatalogResourcePathParams }, ResolveManifest>(
    "POST",
    "/api/workspaces/:id/catalog/mcps/:name/sync/resolve",
  ),
  "catalog.mcps.sync": defineRoute<
    { params: CatalogResourcePathParams; body: CatalogSyncBody },
    CatalogSyncResult
  >("POST", "/api/workspaces/:id/catalog/mcps/:name/sync"),
} as const satisfies Record<string, RouteSpec<RouteRequest, unknown>>;

/** Union of every key in {@link ROUTES}. Use as the generic param of `ApiClient.call`. */
export type RouteKey = keyof typeof ROUTES;

/**
 * Flat enumeration of `{ method, path }` pairs for every entry in
 * {@link ROUTES}. The reflection test in
 * `packages/server/test/route-manifest.test.ts` uses this to compare
 * against `app.routes` (the side-effect registry Hono keeps after
 * `.get` / `.post` / ...) and refuses any mismatch.
 *
 * Exposed as a helper so external tooling (docs generators, OpenAPI
 * exporters, MCP wrappers) can consume the inventory without
 * importing every type.
 */
export function listRoutes(): readonly { readonly method: HttpMethod; readonly path: string }[] {
  return (Object.keys(ROUTES) as RouteKey[]).map((k) => {
    const r = ROUTES[k];
    return { method: r.method, path: r.path };
  });
}
