import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { RuntimeHeadlessLaunchFailed } from "@emploke/runtime";
import {
  AgentNotFoundError,
  CorruptedTaskError,
  EntryNotReadyError,
  InvalidTaskIdError,
  InvalidTransition,
  type ListTaskOpts,
  ManagerShuttingDownError,
  RuntimeDoesNotSupportTasksError,
  TaskIdAllocationFailedError,
  TaskNotFoundError,
  type TaskOrigin,
  type TaskService,
  type TaskStatus,
} from "@emploke/task";
import { Hono } from "hono";
import { errorBody, logEvent, logFault, parseJsonBody } from "./_shared.js";
import type { TaskDispatchBody } from "./manifest.js";

/**
 * Defensive parse alias for the dispatch body. See `sessions.ts` for
 * the rationale — the manifest type is the wire contract for callers,
 * the *Raw alias keeps runtime guards TS-meaningful.
 */
type TaskDispatchBodyRaw = { [K in keyof TaskDispatchBody]?: unknown };

/**
 * Resolver passed in by the mount point so route handlers pull the
 * workspace-scoped TaskService out of Hono's per-request context. Mirrors
 * the SessionService pattern exactly.
 */
export type TaskServiceResolver = (c: import("hono").Context) => TaskService;

function statusForError(err: unknown): number | null {
  // Client-side / input errors → 4xx.
  if (err instanceof InvalidTaskIdError) return 400;
  if (err instanceof TaskNotFoundError) return 404;
  if (err instanceof AgentNotFoundError) return 400;
  if (err instanceof RuntimeDoesNotSupportTasksError) return 400;
  // The agent (or one of its transitive deps) is currently `blocked`
  // — caller-fixable state conflict (acknowledge prereqs, enable the
  // agent, install the missing dep, etc.). 409 mirrors how
  // `HasDependentsError` is mapped on the catalog side.
  if (err instanceof EntryNotReadyError) return 409;
  // ADR-001: cancel on a terminal task, or delete on a non-terminal
  // task, throws InvalidTransition. Same mapping pattern as
  // EntryNotReadyError above — the dashboard branches on `code` +
  // `transition` from the structured 409 body.
  if (err instanceof InvalidTransition) return 409;
  // ADR-001: dispatch + cancel refuse during shutdown so the caller
  // can show a one-shot "server restarting" toast and retry.
  if (err instanceof ManagerShuttingDownError) return 503;
  // Server-side / host faults → 5xx. These match the analogous
  // mappings in sessions.ts (SessionIdAllocationFailedError → 500,
  // RuntimeProvisionFailed → 500). Falling through to the default 400
  // would lie to the dashboard about whose fault it is.
  if (err instanceof TaskIdAllocationFailedError) return 500;
  if (err instanceof RuntimeHeadlessLaunchFailed) return 500;
  // Corrupted metadata column (JSON parse failure, non-object root,
  // invalid status enum, etc.) is a host-side / on-disk fault —
  // operators need to see a 5xx, not a misleading 404 that the
  // dashboard would render as "task gone". The instance carries
  // `taskId` + `reason` for triage; the route's `logFault` companion
  // captures both via pino's `err` serializer.
  if (err instanceof CorruptedTaskError) return 500;
  return null;
}

/**
 * Resolve an unknown error to a response status while preserving the
 * "this fell through unmapped" signal so the route can decide to log
 * it (instead of silently swallowing it as a 400 the way
 * `statusForError(err) ?? 400` does on its own).
 *
 * The "silent 4xx" policy is correct for *intentional* client-side
 * errors (validation, not-found, etc.) that {@link statusForError}
 * recognises. But when `statusForError` returns `null` — i.e. the
 * thrown error class is NOT on the mapping table — the previous
 * `?? 400` fallthrough served the caller a generic
 * `{ error: "internal error" }` body AND wrote nothing to the server
 * log. That hid real bugs: packaging-misconfig errors, missing
 * runtime deps, new typed errors we forgot to map, etc.
 *
 * Returns `{ status, isUnmapped }`. `isUnmapped` is true exactly when
 * `statusForError` returned `null` — distinct from a mapped 400 (which
 * the caller deliberately wants silent because the validation path
 * already returned a clean message). The route then opts into a
 * "unmapped fell through to 400" log entry for the `isUnmapped` case,
 * preserving the existing "no log for mapped 4xx" behaviour and the
 * existing "log for 5xx faults" behaviour.
 *
 * The wire body is unchanged: `errorBody(err)` still collapses unknown
 * error classes to `"internal error"` per the `SAFE_ERROR_NAMES`
 * allow-list. Only the OPERATOR-facing log becomes informative.
 */
function resolveErrorStatus(err: unknown): { status: number; isUnmapped: boolean } {
  const mapped = statusForError(err);
  return { status: mapped ?? 400, isUnmapped: mapped === null };
}

/**
 * Shared meta builder for the "unmapped fell through to 400" log
 * entry. Pulls the unknown error's `name` and `message` onto the
 * structured log line (in addition to the full `err` serialiser pino
 * already attaches via `logFault`) so the operator can `jq` for
 * unmapped error classes without parsing every nested `err.type`.
 */
function unmappedFaultMeta(err: unknown, extra?: Record<string, unknown>): Record<string, unknown> {
  const e = err instanceof Error ? err : undefined;
  return {
    name: e?.name,
    message: e?.message,
    ...(extra ?? {}),
  };
}

/**
 * Build the structured 409 body that pairs with an InvalidTransition
 * thrown out of cancel() / delete() / similar verbs.
 *
 * Shape (R-6 pinned):
 *   {
 *     error:      "<human message>",
 *     code:       "InvalidTransition",
 *     status:     "<current TaskStatus>",
 *     transition: "<verb>",
 *   }
 *
 * The dashboard's 409 handler branches `switch (body.code)`; with
 * this body shape it can render typed CTAs (e.g. "cancel first" hint
 * on a non-terminal delete) without parsing prose.
 */
function invalidTransitionBody(
  err: InvalidTransition,
  transition: string,
): { error: string; code: string; status: string; transition: string } {
  return {
    error: err.message,
    code: "InvalidTransition",
    status: err.from,
    transition,
  };
}

/**
 * Routes for `/api/workspaces/:wsId/tasks/*`.
 *
 * Mounted at the parent in `index.ts`; paths here are relative to that
 * mount.
 */
export function tasksRoutes(resolveTaskService: TaskServiceResolver): Hono {
  const app = new Hono();
  const getManager = resolveTaskService;

  // List tasks in this workspace, newest-first per the manager.
  // Optional server-side filters (mirroring the sessions route):
  //   ?agent=<name>             — exact match on Task.agent
  //   ?runtime=<kind>           — exact match on metadata.runtime
  //   ?createdSince=<iso8601>   — drop tasks older than the cutoff
  //   ?status=running,succeeded — include only listed statuses (CSV)
  //   ?origin=standalone        — include only listed origins (CSV)
  app.get("/", async (c) => {
    const agent = c.req.query("agent");
    const runtime = c.req.query("runtime");
    const createdSince = c.req.query("createdSince");
    const status = c.req.query("status");
    const origin = c.req.query("origin");

    let createdSinceIso: string | undefined;
    if (createdSince !== undefined) {
      const t = Date.parse(createdSince);
      if (Number.isNaN(t)) {
        return c.json({ error: "createdSince must be an ISO 8601 timestamp" }, 400);
      }
      createdSinceIso = new Date(t).toISOString();
    }

    let statuses: TaskStatus[] | undefined;
    if (status !== undefined) {
      const valid = new Set<TaskStatus>(["running", "succeeded", "failed", "cancelled"]);
      const parts = status
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const bad = parts.find((s) => !valid.has(s as TaskStatus));
      if (bad !== undefined) {
        return c.json(
          {
            error: `unknown status: ${JSON.stringify(bad)} (expected running, succeeded, failed, cancelled)`,
          },
          400,
        );
      }
      statuses = parts as TaskStatus[];
    }

    let origins: TaskOrigin[] | undefined;
    if (origin !== undefined) {
      const validOrigins = new Set<TaskOrigin>(["standalone", "workflow"]);
      const parts = origin
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const bad = parts.find((s) => !validOrigins.has(s as TaskOrigin));
      if (bad !== undefined) {
        return c.json(
          {
            error: `unknown origin: ${JSON.stringify(bad)} (expected standalone, workflow)`,
          },
          400,
        );
      }
      origins = parts as TaskOrigin[];
    }

    const opts: { -readonly [K in keyof ListTaskOpts]: ListTaskOpts[K] } = {};
    if (agent !== undefined) opts.agent = agent;
    if (runtime !== undefined) opts.runtime = runtime;
    if (createdSinceIso !== undefined) opts.createdSince = createdSinceIso;
    if (statuses !== undefined) opts.statuses = statuses;
    if (origins !== undefined) opts.origin = origins;

    try {
      const list = await getManager(c).list(opts);
      return c.json(list);
    } catch (err) {
      const { status, isUnmapped } = resolveErrorStatus(err);
      if (status >= 500) {
        logFault(c, err, "tasks.list: 5xx fault");
      } else if (isUnmapped) {
        logFault(c, err, "tasks.list: unmapped error fell through to 400", unmappedFaultMeta(err));
      }
      // biome-ignore lint/suspicious/noExplicitAny: see other handlers in this file.
      return c.json(errorBody(err), status as any);
    }
  });

  // Dispatch a fresh task. Returns 201 + the running Task. The agent
  // continues to run in the background; clients poll `/:tid` (or watch
  // `/:tid/events`) for completion.
  app.post("/", async (c) => {
    const parsed = await parseJsonBody<TaskDispatchBodyRaw>(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const body = parsed.body;
    if (typeof body.agent !== "string" || body.agent.trim() === "") {
      return c.json({ error: "agent is required (string)" }, 400);
    }
    if (typeof body.brief !== "string") {
      return c.json({ error: "brief is required (string)" }, 400);
    }
    const briefTrimmed = body.brief.trim();
    if (briefTrimmed.length === 0) {
      return c.json({ error: "brief must be non-empty after trim" }, 400);
    }
    if (briefTrimmed.includes("\n") || briefTrimmed.includes("\r")) {
      // Brief is the displayed label everywhere — task list rows,
      // detail panel header, CLI table. Multi-line input would
      // break the layout and tooltips. Keep the single-line
      // contract enforced at the wire boundary so downstream
      // consumers (dashboard, CLI, future MCP) never have to defend.
      return c.json({ error: "brief must be a single line (no newline characters)" }, 400);
    }
    if (briefTrimmed.length > BRIEF_MAX_LENGTH) {
      return c.json({ error: `brief must be ${BRIEF_MAX_LENGTH} characters or fewer` }, 400);
    }
    if (body.details !== undefined && typeof body.details !== "string") {
      return c.json({ error: "details, when present, must be a string" }, 400);
    }
    if (body.runtime !== undefined && typeof body.runtime !== "string") {
      return c.json({ error: "runtime, when present, must be a string" }, 400);
    }
    try {
      const task = await getManager(c).dispatch({
        agent: body.agent,
        brief: briefTrimmed,
        ...(typeof body.details === "string" ? { details: body.details } : {}),
        ...(typeof body.runtime === "string" ? { runtime: body.runtime } : {}),
      });
      logEvent(c, "task dispatched", {
        taskId: task.id,
        agent: task.agent,
        runtime: task.metadata?.runtime,
      });
      return c.json(task, 201);
    } catch (err) {
      const { status, isUnmapped } = resolveErrorStatus(err);
      if (status >= 500) {
        logFault(c, err, "tasks: 5xx fault");
      } else if (isUnmapped) {
        // Unmapped error class fell through to the default 400. The
        // wire body is still `errorBody(err)` (collapsed to
        // "internal error" for non-SAFE_ERROR_NAMES) — but we MUST
        // log it so the operator can see what blew up. This is the
        // observability half of the @github/copilot-sdk packaging
        // fix; see resolveErrorStatus jsdoc.
        logFault(c, err, "tasks: unmapped error fell through to 400", unmappedFaultMeta(err));
      }
      // EntryNotReadyError carries a structured `BlockedReason` on
      // the instance; surface it on the wire so the dashboard can
      // render typed UI (the catalog list already uses the same
      // `blockedReason` shape — see CatalogService.getAgentEntry).
      // Without this branch the body collapses to `{error, code}`
      // and the dashboard would be stuck parsing a human string to
      // figure out which CTA (Acknowledge prereqs / Enable agent /
      // Install missing dep) applies.
      if (err instanceof EntryNotReadyError) {
        return c.json(
          {
            error: err.message,
            code: err.name,
            agent: err.agent,
            ...(err.reason !== undefined ? { reason: err.reason } : {}),
          },
          // biome-ignore lint/suspicious/noExplicitAny: Hono's c.json status type is a finite union.
          status as any,
        );
      }
      // biome-ignore lint/suspicious/noExplicitAny: Hono's c.json status type is a finite union.
      return c.json(errorBody(err), status as any);
    }
  });

  // Get a single task by id.
  app.get("/:tid", async (c) => {
    const id = c.req.param("tid");
    try {
      const task = await getManager(c).get(id);
      if (!task) return c.json({ error: "not found", code: "TaskNotFoundError" }, 404);
      return c.json(task);
    } catch (err) {
      const { status, isUnmapped } = resolveErrorStatus(err);
      if (status >= 500) {
        logFault(c, err, "tasks.get: 5xx fault", { taskId: id });
      } else if (isUnmapped) {
        logFault(
          c,
          err,
          "tasks.get: unmapped error fell through to 400",
          unmappedFaultMeta(err, { taskId: id }),
        );
      }
      // biome-ignore lint/suspicious/noExplicitAny: see above.
      return c.json(errorBody(err), status as any);
    }
  });

  // Delete a task. **ADR-001 §3.5: terminal-only.** Calling DELETE
  // on a `running` / `not_started` task now returns 409 with a
  // structured body so the dashboard can render typed CTA → use
  // `tasks.cancel` first. Default ("archive") removes only the
  // task's metadata row; the workdir contents (stderr.log,
  // agent-produced files) and the runtime's per-task event log stay
  // on disk so the user can inspect the run after the fact. Pass
  // `?purge=1` for the hard-delete path: row + workdir + runtime
  // state, in that order (runtime first so a runtime-side failure
  // aborts before any local removal — mirrors session-delete
  // semantics).
  //
  // The pre-ADR-001 "corrupted row" + "stray workdir" escape hatches
  // are gone (sqlite3 CLI is the recovery channel per §3.5).
  app.delete("/:tid", async (c) => {
    const id = c.req.param("tid");
    const purge = c.req.query("purge") === "1";
    try {
      await getManager(c).delete(id, { purge });
      logEvent(c, "task deleted", { taskId: id, purge });
      return c.body(null, 204);
    } catch (err) {
      const { status, isUnmapped } = resolveErrorStatus(err);
      if (status >= 500) {
        logFault(c, err, "tasks.delete: 5xx fault", { taskId: id, purge });
      } else if (isUnmapped) {
        logFault(
          c,
          err,
          "tasks.delete: unmapped error fell through to 400",
          unmappedFaultMeta(err, { taskId: id, purge }),
        );
      }
      if (err instanceof InvalidTransition) {
        // biome-ignore lint/suspicious/noExplicitAny: Hono's c.json status type is a finite union.
        return c.json(invalidTransitionBody(err, "delete"), status as any);
      }
      // biome-ignore lint/suspicious/noExplicitAny: see above.
      return c.json(errorBody(err), status as any);
    }
  });

  // POST /:tid/cancel — ADR-001 §3.6. User-initiated cancellation of
  // a running task. POSTs the cancellation as a state transition
  // (DELETE belongs to tasks.delete, which only ever removes records
  // post-ADR-001). No request body in v1; the server kills the
  // subprocess (SIGTERM), waits for the exit watcher to persist
  // `cancelled`, and returns the updated Task.
  //
  // The returned Task's `cancellation.kind` is normally `'user'`
  // (live subprocess killed at the operator's request), but the
  // manager will produce `'orphan'` when the row was `running` yet
  // had no live entry — the same terminal write applies, so the
  // dashboard renders symmetrically. See the full enumeration on
  // the `tasks.cancel` entry in `manifest.ts`.
  //
  // Errors:
  //   - 404 (TaskNotFoundError): unknown id
  //   - 409 (InvalidTransition): task already terminal → body carries
  //     `{ code, status, transition: 'cancel' }` so dashboard branches
  //     typed (R-6 pinned shape)
  //   - 503 (ManagerShuttingDownError): server is shutting down
  app.post("/:tid/cancel", async (c) => {
    const id = c.req.param("tid");
    try {
      const task = await getManager(c).cancel(id);
      logEvent(c, "task cancelled", { taskId: id });
      return c.json(task);
    } catch (err) {
      const { status, isUnmapped } = resolveErrorStatus(err);
      if (status >= 500) {
        logFault(c, err, "tasks.cancel: 5xx fault", { taskId: id });
      } else if (isUnmapped) {
        logFault(
          c,
          err,
          "tasks.cancel: unmapped error fell through to 400",
          unmappedFaultMeta(err, { taskId: id }),
        );
      }
      if (err instanceof InvalidTransition) {
        // biome-ignore lint/suspicious/noExplicitAny: Hono's c.json status type is a finite union.
        return c.json(invalidTransitionBody(err, "cancel"), status as any);
      }
      // biome-ignore lint/suspicious/noExplicitAny: see above.
      return c.json(errorBody(err), status as any);
    }
  });

  // GET /:tid/artifact/:name (issue #181)
  //
  // Serve a single artifact file for a terminal task. The artifact
  // must be on the task's `success.artifacts` whitelist — there is
  // no general filesystem-serving fallback. This is the read endpoint
  // that pairs with `applyTerminal`'s artifact capture.
  //
  // Defence in depth:
  //   - `name` is rejected outright if it contains a path separator
  //     or `..` (no directory traversal). The whitelist check below
  //     is the actual security boundary; this is the belt-and-braces.
  //   - The manager normalises with `path.basename` before comparing
  //     against the whitelist, so a sneaky encoded separator slipping
  //     past the route check still can't walk out.
  //
  // Errors:
  //   - 404 — task missing, task still running, or `name` not on
  //     the success.artifacts whitelist
  //   - 400 — `name` contains an obviously-malicious separator
  app.get("/:tid/artifact/:name", async (c) => {
    const id = c.req.param("tid");
    const rawName = c.req.param("name");
    if (
      rawName.includes("/") ||
      rawName.includes("\\") ||
      rawName === "." ||
      rawName === ".." ||
      rawName.split("/").includes("..") ||
      rawName.split("\\").includes("..")
    ) {
      return c.json({ error: "artifact name must be a bare filename", code: "BadRequest" }, 400);
    }
    let absPath: string | null;
    try {
      absPath = await getManager(c).resolveArtifactPath(id, rawName);
    } catch (err) {
      const { status, isUnmapped } = resolveErrorStatus(err);
      if (status >= 500) {
        logFault(c, err, "tasks.artifact: 5xx fault", { taskId: id, artifact: rawName });
      } else if (isUnmapped) {
        logFault(
          c,
          err,
          "tasks.artifact: unmapped error fell through to 400",
          unmappedFaultMeta(err, { taskId: id, artifact: rawName }),
        );
      }
      // biome-ignore lint/suspicious/noExplicitAny: see other handlers in this file.
      return c.json(errorBody(err), status as any);
    }
    if (absPath === null) {
      return c.json({ error: "artifact not found", code: "NotFound" }, 404);
    }
    // Final fs check — the file may have been removed by an out-of-band
    // operator action between terminal time and this request.
    try {
      const st = await stat(absPath);
      if (!st.isFile()) {
        return c.json({ error: "artifact not found", code: "NotFound" }, 404);
      }
    } catch {
      return c.json({ error: "artifact not found", code: "NotFound" }, 404);
    }

    const basename = path.basename(absPath);
    const contentType = contentTypeFor(basename);
    // Hono's ReadableStream body adapter accepts any web ReadableStream;
    // wrap the Node stream so we get back-pressure on slow clients.
    const node = createReadStream(absPath);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        node.on("data", (chunk) => {
          const buf =
            typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
          controller.enqueue(buf);
        });
        node.on("end", () => controller.close());
        node.on("error", (err) => controller.error(err));
      },
      cancel() {
        node.destroy();
      },
    });
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `inline; filename="${encodeURIComponent(basename)}"`,
        "Cache-Control": "private, max-age=60",
      },
    });
  });

  // Runtime-neutral activity timeline for a task. The runtime
  // end-to-end owns reading + parsing its own event log into the
  // {ActivityItem, TaskActivityResult} vocabulary; this route just
  // forwards that result as JSON.
  //
  // Pagination via mutually-exclusive `?before=<seq>` / `?after=<seq>`,
  // both optional, plus `?limit=<n>`. Three modes:
  //   - default (neither): tail — returns the latest `limit` items.
  //     What GUI clients want on first load.
  //   - `?after=<seq>`: forward — items with `seq > after`. Used by
  //     SSE polling and by callers walking head-to-tail.
  //   - `?before=<seq>`: backward — the latest `limit` items below
  //     the cut. Used by GUI clients loading older history when the
  //     user scrolls up past the initial tail-window.
  //
  // The route enforces limit in [1, 500], default 50 — sized for LLM
  // token budgets so this surface stays MCP-safe by construction.
  // Supplying both `before` and `after` is rejected as 400 (otherwise
  // the runtime layer would catch it, but failing earlier is friendlier).
  //
  // Response shape: `{ activity, result, totalItems, truncated? }`.
  // Clients derive `hasOlder` / `hasNewer` from the page window
  // (`activity[0].seq > 0` / `activity[last].seq < totalItems - 1`)
  // — no dedicated cursor fields, items themselves are the cursor.
  //
  // Returns:
  //   - 400 on malformed before / after / limit, or both pagination
  //     params present
  //   - 404 if the task doesn't exist
  //   - 404 with code=NoEventsYet if the runtime doesn't implement
  //     `Runtime.readActivity`, or has no log for this task yet
  //   - 200 application/json
  app.get("/:tid/activity", async (c) => {
    const id = c.req.param("tid");
    const beforeRaw = c.req.query("before");
    const afterRaw = c.req.query("after");
    const limitRaw = c.req.query("limit");

    if (beforeRaw !== undefined && afterRaw !== undefined) {
      return c.json({ error: "before and after are mutually exclusive", code: "BadRequest" }, 400);
    }

    let before: number | undefined;
    if (beforeRaw !== undefined) {
      const parsed = Number.parseInt(beforeRaw, 10);
      if (!Number.isFinite(parsed) || parsed < 0 || `${parsed}` !== beforeRaw) {
        return c.json({ error: "before must be a non-negative integer", code: "BadRequest" }, 400);
      }
      before = parsed;
    }

    let after: number | undefined;
    if (afterRaw !== undefined) {
      const parsed = Number.parseInt(afterRaw, 10);
      if (!Number.isFinite(parsed) || parsed < 0 || `${parsed}` !== afterRaw) {
        return c.json({ error: "after must be a non-negative integer", code: "BadRequest" }, 400);
      }
      after = parsed;
    }

    let limit: number = TASK_ACTIVITY_DEFAULT_LIMIT;
    if (limitRaw !== undefined) {
      const parsed = Number.parseInt(limitRaw, 10);
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > TASK_ACTIVITY_MAX_LIMIT) {
        return c.json(
          {
            error: `limit must be an integer in [1, ${TASK_ACTIVITY_MAX_LIMIT}]`,
            code: "BadRequest",
          },
          400,
        );
      }
      limit = parsed;
    }

    let payload: Awaited<ReturnType<TaskService["getTaskActivity"]>>;
    try {
      payload = await getManager(c).getTaskActivity(id, {
        ...(before !== undefined ? { before } : {}),
        ...(after !== undefined ? { after } : {}),
        limit,
      });
    } catch (err) {
      const { status, isUnmapped } = resolveErrorStatus(err);
      if (status >= 500) {
        logFault(c, err, "tasks.activity: 5xx fault", { taskId: id });
      } else if (isUnmapped) {
        logFault(
          c,
          err,
          "tasks.activity: unmapped error fell through to 400",
          unmappedFaultMeta(err, { taskId: id }),
        );
      }
      // biome-ignore lint/suspicious/noExplicitAny: see above.
      return c.json(errorBody(err), status as any);
    }
    if (payload === null) {
      return c.json({ error: "no activity is available for this task", code: "NoEventsYet" }, 404);
    }
    return c.json(payload);
  });

  // SSE live tail. Subscribes to runtime.streamActivity and
  // pushes each ActivityItem as `event: activity` with the JSON
  // payload. Sends `event: end` on iterator completion, `event: error`
  // on faults. Standard SSE wire format — any HTTP client can
  // consume (curl -N, EventSource, eventsource-parser).
  //
  // The SSE iterator is cancelled when the HTTP client disconnects
  // (request `signal` propagates to the runtime via TaskService).
  // This route is HUMAN-only: not exposed via MCP because LLM tool
  // surfaces require bounded responses, not streams.
  //
  // Returns:
  //   - 404 if the task doesn't exist
  //   - 404 with code=NoEventsYet if the runtime doesn't implement
  //     streaming
  //   - 200 text/event-stream otherwise (long-lived response)
  app.get("/:tid/activity/stream", async (c) => {
    const id = c.req.param("tid");
    let stream: AsyncIterable<import("@emploke/runtime").ActivityItem> | null;
    try {
      const lastEventId = c.req.header("Last-Event-ID");
      const after =
        lastEventId !== undefined && /^\d+$/.test(lastEventId)
          ? Number.parseInt(lastEventId, 10)
          : undefined;
      stream = await getManager(c).getTaskActivityStream(id, {
        ...(after !== undefined ? { after } : {}),
        signal: c.req.raw.signal,
      });
    } catch (err) {
      const { status, isUnmapped } = resolveErrorStatus(err);
      if (status >= 500) {
        logFault(c, err, "tasks.activity.stream: 5xx fault", { taskId: id });
      } else if (isUnmapped) {
        logFault(
          c,
          err,
          "tasks.activity.stream: unmapped error fell through to 400",
          unmappedFaultMeta(err, { taskId: id }),
        );
      }
      // biome-ignore lint/suspicious/noExplicitAny: see above.
      return c.json(errorBody(err), status as any);
    }
    if (stream === null) {
      return c.json(
        { error: "no streaming activity available for this task", code: "NoEventsYet" },
        404,
      );
    }

    // Hono SSE: hand back a Response with a ReadableStream framed
    // per the EventSource spec.
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const enqueue = (frame: string) => {
          try {
            controller.enqueue(encoder.encode(frame));
          } catch {
            // Controller closed (client gone).
          }
        };
        try {
          for await (const item of stream as AsyncIterable<
            import("@emploke/runtime").ActivityItem
          >) {
            if (c.req.raw.signal.aborted) break;
            enqueue(`event: activity\nid: ${item.seq}\ndata: ${JSON.stringify(item)}\n\n`);
          }
          enqueue("event: end\ndata: {}\n\n");
        } catch (err) {
          enqueue(
            `event: error\ndata: ${JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            })}\n\n`,
          );
        } finally {
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
      },
    });

    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        // Disable Nginx buffering that would defeat the live-tail UX.
        "X-Accel-Buffering": "no",
      },
    });
  });

  return app;
}

/** Default `limit` for `GET /tasks/:tid/activity` when caller omits it. Sized for LLM token budgets. */
const TASK_ACTIVITY_DEFAULT_LIMIT = 50;
/** Hard maximum `limit` accepted from callers. Defends the dashboard / MCP from blowing memory. */
const TASK_ACTIVITY_MAX_LIMIT = 500;

/**
 * Maximum length of `brief` accepted from clients. Surfaced from the
 * dispatch route as a 400 when exceeded. Sized to fit a single line in
 * the dashboard list (~2 lines wrapped on a 360px column at the
 * default font size); also bounds the SQLite column width and the
 * displayed task title across CLI / dashboard / future MCP tools.
 */
const BRIEF_MAX_LENGTH = 200;

/**
 * Best-effort Content-Type for an artifact filename. Whitelisted text
 * formats get their canonical mime type (so the browser renders them
 * inline); everything else falls back to `application/octet-stream`,
 * which the browser will treat as a download. Charset is included on
 * the text variants because the agent's output is always UTF-8 (it's
 * what node writes by default and what `framing.ts` expects).
 */
function contentTypeFor(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "txt":
    case "log":
      return "text/plain; charset=utf-8";
    case "md":
      return "text/markdown; charset=utf-8";
    case "html":
    case "htm":
      return "text/html; charset=utf-8";
    case "json":
      return "application/json; charset=utf-8";
    case "csv":
      return "text/csv; charset=utf-8";
    case "svg":
      return "image/svg+xml";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}
