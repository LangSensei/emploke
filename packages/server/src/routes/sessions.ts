import type { LaunchCommand } from "@emploke/runtime";
import {
  AgentNotFoundError,
  InvalidSessionIdError,
  RuntimeDoesNotSupportRemoteError,
  RuntimeProvisionFailed,
  RuntimeStateDeletionFailed,
  SessionIdAllocationFailedError,
  type SessionManager,
  SessionNotFoundError,
  TrustRegistrationFailed,
  UnknownRuntimeError,
} from "@emploke/session";
import {
  NoTerminalFoundError,
  type SpawnTerminalResult,
  spawnTerminal,
  TerminalSpawnFailedError,
  UnsupportedPlatformError,
} from "@emploke/terminal";
import { Hono } from "hono";
import { errorBody, logFault, parseJsonBody } from "./_shared.js";
import type { SessionCreateBody } from "./manifest.js";

/** Override hook used by tests to bypass real terminal spawning. */
export type SpawnFn = (cmd: LaunchCommand) => Promise<SpawnTerminalResult>;

/**
 * Defensive parse alias: the manifest type is the strict wire contract;
 * locally we still re-type the JSON we got as `unknown` per field so the
 * runtime `typeof` guards stay both defensive and TS-meaningful (the
 * contract type would narrow them to dead code).
 */
type SessionCreateBodyRaw = { [K in keyof SessionCreateBody]?: unknown };

/**
 * Resolver passed into `sessionsRoutes` so the routes can pull the
 * workspace-scoped `SessionManager` out of Hono's per-request context.
 *
 * In production (`mountWorkspaceSessions` in index.ts) this reads
 * `c.var.sessionManager` set by the workspace middleware. Tests can pass a
 * trivial `() => stubManager` for direct route invocation without going
 * through the middleware chain.
 */
export type SessionManagerResolver = (c: import("hono").Context) => SessionManager;

/**
 * Map sessions errors to HTTP status codes. Returns null for unknown errors
 * so the caller can use a default (400 with the message).
 */
function statusForError(err: unknown): number | null {
  if (err instanceof InvalidSessionIdError) return 400;
  if (err instanceof SessionNotFoundError) return 404;
  if (err instanceof AgentNotFoundError) return 400;
  if (err instanceof UnknownRuntimeError) return 400;
  if (err instanceof RuntimeDoesNotSupportRemoteError) return 400;
  if (err instanceof RuntimeStateDeletionFailed) return 409;
  if (err instanceof SessionIdAllocationFailedError) return 500;
  // Provisioning failures (mkdir, MCP/skill copy, agent file resolution)
  // are server-side faults — the client's request was well-formed; the host
  // environment broke. 500 lets clients distinguish from 4xx user errors.
  if (err instanceof RuntimeProvisionFailed) return 500;
  // Trust-file write failures from buildInteractiveLaunch's per-launch preflight are
  // also host-side faults (mkdir/write/lock-timeout on ~/.copilot/config.json),
  // and identical in shape to provisioning failures from a client's point of
  // view: the user can't fix it by retrying with a different payload.
  if (err instanceof TrustRegistrationFailed) return 500;
  return null;
}

/**
 * Routes for `/api/workspaces/:name/sessions/*`. The Hono mount point in
 * `index.ts` strips the prefix, so paths here are relative ("/", "/:id", …).
 *
 * The route doesn't take a `SessionManager` directly: it takes a resolver
 * that pulls the workspace-scoped manager off the Hono context (set by the
 * workspace middleware on the parent route). This keeps the route generic
 * across whatever workspace happens to be in play for a given request.
 *
 * `spawnFn` is injected so tests can stub the terminal launch without
 * touching the host. Production passes the default `spawnTerminal`.
 */
export function sessionsRoutes(
  resolveManager: SessionManagerResolver | SessionManager,
  spawnFn: SpawnFn = spawnTerminal,
): Hono {
  const app = new Hono();

  // Backward-compat overload: tests still pass a SessionManager directly.
  const getManager: SessionManagerResolver =
    typeof resolveManager === "function"
      ? (resolveManager as SessionManagerResolver)
      : () => resolveManager;

  // List sessions, optionally filtered by agent / createdSince / activeSince.
  app.get("/", async (c) => {
    const agent = c.req.query("agent");
    const createdSince = c.req.query("createdSince");
    const activeSince = c.req.query("activeSince");
    // The manager compares timestamps with a plain string `<` (which is
    // correct for ISO 8601 with a `Z` suffix because those strings sort
    // lexicographically as dates). If we accepted any Date.parse-able form
    // like "Jan 1 2024" and forwarded it raw, the lexicographic compare
    // would be wrong (e.g. '2' < 'J' makes a 2026 session sort below a
    // "Jan 1 2024" cutoff). So: parse leniently, then forward the
    // canonical ISO 8601 form. Same canonicalisation for both filters.
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
      const list = await getManager(c).list(opts);
      return c.json(list);
    } catch (err) {
      return c.json(errorBody(err), 400);
    }
  });

  // Create a new session for the given agent.
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
      const rec = await getManager(c).create({
        agent: body.agent,
        ...(typeof body.runtime === "string" ? { runtime: body.runtime } : {}),
      });
      return c.json(rec, 201);
    } catch (err) {
      const status = statusForError(err) ?? 400;
      if (status >= 500) logFault(c, err, "sessions: 5xx fault");
      // biome-ignore lint/suspicious/noExplicitAny: Hono's c.json status type is a finite union.
      return c.json(errorBody(err), status as any);
    }
  });

  // Get a single session by id.
  //
  // The path param is `:sid`, not `:id`, to avoid colliding with the
  // outer mount's `/:id/sessions/*` workspace param. When two layers
  // share the same param name, Hono's `c.req.param` lookup returns the
  // outer match — so a request to `/api/workspaces/<wsId>/sessions/<sid>`
  // would deliver the workspace UUID into this handler instead of the
  // session id, and `assertValidSessionId` would reject it. tasks/catalog
  // already use distinct names (`:tid`, `:name`); sessions follows suit.
  app.get("/:sid", async (c) => {
    const id = c.req.param("sid");
    try {
      const rec = await getManager(c).get(id);
      if (!rec) return c.json({ error: "not found", code: "SessionNotFoundError" }, 404);
      return c.json(rec);
    } catch (err) {
      const status = statusForError(err) ?? 400;
      if (status >= 500) logFault(c, err, "sessions: 5xx fault");
      // biome-ignore lint/suspicious/noExplicitAny: see above.
      return c.json(errorBody(err), status as any);
    }
  });

  // Delete a session.
  //
  // Default ("archive"): only the metadata row is removed; the workdir
  // (AGENTS.md, agent-produced files) AND the runtime adapter's
  // per-session state (e.g. ~/.copilot/session-state/<id>/) are
  // preserved for inspection / recovery.
  //
  // `?purge=1` ("hard delete"): row + workdir + runtime state, all
  // gone. Mirrors what `WorkspaceManager.delete` and
  // `TaskManager.delete` mean by `purge` — single verb across the
  // entity managers.
  app.delete("/:sid", async (c) => {
    const id = c.req.param("sid");
    const purge = c.req.query("purge") === "1";
    try {
      await getManager(c).delete(id, { purge });
      return c.body(null, 204);
    } catch (err) {
      const status = statusForError(err) ?? 400;
      if (status >= 500) logFault(c, err, "sessions: 5xx fault");
      // biome-ignore lint/suspicious/noExplicitAny: see above.
      return c.json(errorBody(err), status as any);
    }
  });

  // One-click launch: build the launch command via the runtime adapter and
  // hand it to the terminal spawner. Body `{ remote?: boolean }` selects
  // the spawn variant (the dashboard renders this as separate "Spawn local"
  // / "Spawn remote" buttons; both POST to the same route with different
  // body). On any spawn failure we return 200 with `{ ok: false, display,
  // ... }` so the dashboard can fall back to showing the copy-paste command
  // without needing a second round-trip.
  app.post("/:sid/spawn", async (c) => {
    const id = c.req.param("sid");

    // Body is optional — pre-remote callers pass nothing and get the
    // local launch. We only care about the `remote` boolean and tolerate
    // an empty / missing body so the existing `spawnSession(id)` JS
    // signature keeps working without a body.
    let remote = false;
    if (c.req.header("content-length") !== "0" && c.req.header("content-type")?.includes("json")) {
      const parsed = await parseJsonBody<{ remote?: unknown }>(c);
      if (!parsed.ok) return c.json({ error: parsed.error }, 400);
      if (parsed.body.remote === true) remote = true;
      else if (parsed.body.remote !== undefined && parsed.body.remote !== false) {
        return c.json({ error: "`remote`, when present, must be a boolean" }, 400);
      }
    }

    let cmd: LaunchCommand;
    try {
      cmd = await getManager(c).buildInteractiveLaunch(id, { remote });
    } catch (err) {
      const status = statusForError(err) ?? 400;
      if (status >= 500) logFault(c, err, "sessions: 5xx fault");
      // biome-ignore lint/suspicious/noExplicitAny: see above.
      return c.json(errorBody(err), status as any);
    }

    try {
      const result = await spawnFn(cmd);
      return c.json({ ok: true as const, launcher: result.launcher, display: cmd.display });
    } catch (err) {
      const code = spawnErrorCode(err);
      const message = err instanceof Error ? err.message : String(err);
      return c.json({
        ok: false as const,
        error: message,
        code,
        display: cmd.display,
      });
    }
  });

  return app;
}

function spawnErrorCode(err: unknown): string {
  if (err instanceof NoTerminalFoundError) return "NoTerminalFoundError";
  if (err instanceof TerminalSpawnFailedError) return "TerminalSpawnFailedError";
  if (err instanceof UnsupportedPlatformError) return "UnsupportedPlatformError";
  if (err instanceof Error && err.name) return err.name;
  return "SpawnError";
}
