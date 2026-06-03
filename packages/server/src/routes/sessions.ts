import type { SessionCreateBody, WorkspaceContext } from "@emploke/api";
import { Hono } from "hono";
import { sessionsErrorPolicy } from "./_error-policies/sessions.js";
import { respondError } from "./_respond-error.js";
import { logEvent, parseJsonBody } from "./_shared.js";

/**
 * Resolver passed into `sessionsRoutes` so the routes can pull the
 * workspace-scoped `WorkspaceContext` out of Hono's per-request context
 * (set by the workspace middleware on the parent route).
 *
 * The route accesses `.sessions` for CRUD operations and
 * `.sessions.spawnInteractive()` for the "start an interactive
 * session" call site.
 */
export type WorkspaceContextResolver = (c: import("hono").Context) => WorkspaceContext;

type SessionCreateBodyRaw = { [K in keyof SessionCreateBody]?: unknown };

/**
 * Routes for `/api/workspaces/:id/sessions/*`. Pure transport — every
 * endpoint is parse body → dispatch to the workspace context → format
 * response. The cross-BC `spawn` endpoint delegates to
 * `SessionService.spawnInteractive()` which builds the interactive
 * launch via `runtime.buildInteractiveLaunch` and hands the
 * `LaunchCommand` to the injected terminal spawner (in production,
 * `spawnTerminal` from `@emploke/terminal`, wired by
 * `composeApplication`).
 */
export function sessionsRoutes(resolve: WorkspaceContextResolver): Hono {
  const app = new Hono();

  // List sessions, optionally filtered by agent / createdSince / activeSince.
  app.get("/", async (c) => {
    const agent = c.req.query("agent");
    const createdSince = c.req.query("createdSince");
    const activeSince = c.req.query("activeSince");
    // SessionService.list compares ISO timestamps with a plain string
    // `<` (which is correct for `Z`-suffixed ISO 8601 because those sort
    // lexicographically as dates). If we accepted arbitrary
    // Date.parse-able input ("Jan 1 2024") and forwarded it raw, the
    // compare would be wrong. So: parse leniently, forward canonical ISO.
    const canonicalise = (raw: string, label: string): string | { error: string } => {
      const t = Date.parse(raw);
      if (Number.isNaN(t)) return { error: `${label} must be an ISO 8601 timestamp` };
      return new Date(t).toISOString();
    };
    let createdSinceIso: string | undefined;
    if (createdSince !== undefined) {
      const r = canonicalise(createdSince, "createdSince");
      if (typeof r !== "string") return c.json(r, 400);
      createdSinceIso = r;
    }
    let activeSinceIso: string | undefined;
    if (activeSince !== undefined) {
      const r = canonicalise(activeSince, "activeSince");
      if (typeof r !== "string") return c.json(r, 400);
      activeSinceIso = r;
    }
    const opts: { agent?: string; createdSince?: string; activeSince?: string } = {};
    if (agent !== undefined) opts.agent = agent;
    if (createdSinceIso !== undefined) opts.createdSince = createdSinceIso;
    if (activeSinceIso !== undefined) opts.activeSince = activeSinceIso;
    try {
      return c.json(await resolve(c).sessions.list(opts));
    } catch (err) {
      // Pre-refactor this route silently downgraded every error to
      // 400 with no log line. The post-refactor respondError call
      // closes the unmapped-fault observability gap (sessions.ts now
      // matches sibling routes' five-line treatment).
      return respondError(c, err, {
        route: "sessions.list",
        policy: sessionsErrorPolicy,
      });
    }
  });

  app.post("/", async (c) => {
    const parsed = await parseJsonBody<SessionCreateBodyRaw>(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const body = parsed.body;
    if (typeof body.agent !== "string" || body.agent.trim() === "") {
      return c.json({ error: "agent is required (string)" }, 400);
    }
    if (body.runtime !== undefined && typeof body.runtime !== "string") {
      return c.json({ error: "runtime, when present, must be a string" }, 400);
    }
    try {
      const rec = await resolve(c).sessions.create({
        agent: body.agent,
        ...(typeof body.runtime === "string" ? { runtime: body.runtime } : {}),
      });
      logEvent(c, "session created", {
        sessionId: rec.id,
        agent: rec.agent,
        runtime: rec.runtime,
      });
      return c.json(rec, 201);
    } catch (err) {
      // Route label "sessions" (not "sessions.create") preserves the
      // pre-refactor log message that the existing test suite asserts
      // on. New behavior: unmapped errors now log via respondError's
      // isUnmapped path — the gap PR #241 left open for this file.
      return respondError(c, err, {
        route: "sessions",
        policy: sessionsErrorPolicy,
      });
    }
  });

  // Get a single session by id.
  //
  // The path param is `:sid`, not `:id`, to avoid colliding with the
  // outer mount's `/:id/sessions/*` workspace param. When two layers
  // share the same param name, Hono's `c.req.param` returns the outer
  // match; tasks/catalog already use distinct names (`:tid`, `:name`).
  app.get("/:sid", async (c) => {
    const id = c.req.param("sid");
    try {
      const rec = await resolve(c).sessions.get(id);
      if (!rec) return c.json({ error: "not found", code: "SessionNotFoundError" }, 404);
      return c.json(rec);
    } catch (err) {
      return respondError(c, err, {
        route: "sessions",
        policy: sessionsErrorPolicy,
        meta: { sessionId: id },
      });
    }
  });

  // Default ("archive"): only the metadata row is removed; workdir +
  // runtime per-session state preserved. `?purge=1` ("hard delete"):
  // row + workdir + runtime state all gone.
  app.delete("/:sid", async (c) => {
    const id = c.req.param("sid");
    const purge = c.req.query("purge") === "1";
    try {
      await resolve(c).sessions.delete(id, { purge });
      logEvent(c, "session deleted", { sessionId: id, purge });
      return c.body(null, 204);
    } catch (err) {
      return respondError(c, err, {
        route: "sessions",
        policy: sessionsErrorPolicy,
        meta: { sessionId: id, purge },
      });
    }
  });

  // One-click launch: build the interactive launch command and hand it
  // to the terminal spawner. Body `{ remote?: boolean }` selects the
  // spawn variant. On any spawn failure the route returns 200 with
  // `{ ok: false, display, ... }` so the dashboard can fall back to a
  // copy-paste command without a second round-trip.
  app.post("/:sid/spawn", async (c) => {
    const id = c.req.param("sid");

    let remote = false;
    if (c.req.header("content-length") !== "0" && c.req.header("content-type")?.includes("json")) {
      const parsed = await parseJsonBody<{ remote?: unknown }>(c);
      if (!parsed.ok) return c.json({ error: parsed.error }, 400);
      if (parsed.body.remote === true) remote = true;
      else if (parsed.body.remote !== undefined && parsed.body.remote !== false) {
        return c.json({ error: "`remote`, when present, must be a boolean" }, 400);
      }
    }

    let result: Awaited<ReturnType<WorkspaceContext["sessions"]["spawnInteractive"]>>;
    try {
      result = await resolve(c).sessions.spawnInteractive(id, { remote });
    } catch (err) {
      return respondError(c, err, {
        route: "sessions",
        policy: sessionsErrorPolicy,
        meta: { sessionId: id, remote },
      });
    }

    if (result.ok) {
      logEvent(c, "session spawned", {
        sessionId: id,
        remote,
        launcher: result.launcher,
      });
      return c.json({ ok: true as const, launcher: result.launcher, display: result.display });
    }
    logEvent(c, "session spawn failed", {
      sessionId: id,
      remote,
      code: result.code,
      reason: result.error,
    });
    return c.json({
      ok: false as const,
      error: result.error,
      code: result.code,
      display: result.display,
    });
  });

  return app;
}
