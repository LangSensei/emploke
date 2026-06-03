# @emploke/server

The HTTP API surface -- a [Hono](https://hono.dev) app that mounts
workspace-scoped catalog / session / task routes plus the workspace
registry. Bundled into the published `emploke` binary; also runs
standalone for development.

Post de-DDD: the server is a **pure transport adapter** over
[`@emploke/api`](../api). Every route is parse -- dispatch to api
or to the per-workspace runtime -- format. Business logic lives in
the entity services; orchestration (cache, spawn, register/rename)
lives in api.

## URL scheme

Workspace-scoped resources live under `/api/workspaces/<wsid>/...`
where `<wsid>` is the workspace's opaque UUID -- stable for the
lifetime of the registry entry, so dashboard URLs survive workspace
renames.

The canonical list lives in `@emploke/contracts`'s `ROUTES` manifest;
`test/route-manifest.test.ts` pins the registered handlers against it.
If this block drifts from the manifest, the test stays green -- prefer
the manifest.

```text
/api/health                                              GET   liveness + version (no auth)
/api/config                                              GET   resolved server config
/api/runtimes                                            GET   registered runtime kinds + capabilities

/api/workspaces                                          GET POST                list / create
/api/workspaces/current                                  GET PUT                  get / set the most-recently-selected
/api/workspaces/:id                                      GET PATCH DELETE         get / rename / delete (?purge=1)
/api/workspaces/:id/reload                               POST                     force-rebuild per-workspace cache

/api/workspaces/:id/sessions                             GET POST                list / create
/api/workspaces/:id/sessions/:sid                        GET DELETE               get / delete (?purge=1)
/api/workspaces/:id/sessions/:sid/spawn                  POST                     hand-off to terminal spawner

/api/workspaces/:id/tasks                                GET POST                 list / dispatch (standalone-only)
/api/workspaces/:id/tasks/:tid                           GET DELETE               get / delete (?purge=1; ADR-001 sec.3.5 terminal-only)
/api/workspaces/:id/tasks/:tid/cancel                    POST                     user-initiated cancel (ADR-001 sec.3.6)
/api/workspaces/:id/tasks/:tid/activity                  GET                      runtime-parsed timeline (tail-paginated)
/api/workspaces/:id/tasks/:tid/activity/stream           GET                      Server-Sent Events live tail
/api/workspaces/:id/tasks/:tid/artifact/:name            GET                      task success.artifacts whitelist download (#181)

/api/workspaces/:id/scheduled-tasks                      GET                      list schedule-launched tasks (W3 split)

/api/workspaces/:id/schedules                            GET POST/task            list / create task-kind schedule
/api/workspaces/:id/schedules/preview-cron               GET                      preview an arbitrary (expr, tz) (#222)
/api/workspaces/:id/schedules/:sid                       GET DELETE               get / delete
/api/workspaces/:id/schedules/task/:sid                  PATCH                    patch task-kind schedule (RFC 7396 deep-merge on target)
/api/workspaces/:id/schedules/:sid/run                   POST                     manual fire-now
/api/workspaces/:id/schedules/:sid/preview               GET                      next-N fires for this schedule

/api/workspaces/:id/catalog/overview                     GET                      per-workspace counts (skills / agents / mcps, blocked, orphaned)
/api/workspaces/:id/catalog/{skills,agents,mcps}         GET                      list entries for the kind
/api/workspaces/:id/catalog/{kind}                       POST                     install from origin
/api/workspaces/:id/catalog/{kind}/resolve               POST                     two-phase install preview (returns CatalogPlan)
/api/workspaces/:id/catalog/{kind}/:name                 GET PATCH PUT DELETE     get / update metadata / update content / remove
/api/workspaces/:id/catalog/{kind}/:name/anchor          GET                      raw anchor content (split from entry GET per #122)
/api/workspaces/:id/catalog/{kind}/:name/sync/resolve    POST                     plan a sync from the origin (token)
/api/workspaces/:id/catalog/{kind}/:name/sync            POST                     apply a previously-cached sync plan
/api/workspaces/:id/catalog/{agents,skills}/:name/acknowledge-prereqs  POST       mark missing-dep gate cleared
/api/workspaces/:id/catalog/agents/:name/{enable,disable}              POST       toggle agent enabled state
```

There is no global catalog mount -- switching workspace switches the
catalog the dashboard sees.

## Verb conventions

- **`?purge=1`** on workspace / session / task DELETE. Default (no
  flag) removes only emploke metadata; `purge=1` also wipes the
  entity's sandbox dir. Schedule and catalog DELETEs do NOT honour
  the flag -- schedules return a `deletedDispatchCount` summary
  instead, and catalog DELETEs always remove both the row and the
  content file. See [`docs/architecture.md`](../../docs/architecture.md).
- **Time filters canonicalise** any `Date.parse`-able input into ISO
  8601 with a `Z` suffix before forwarding to services; the
  service's lexicographic compare relies on canonical form. Garbage
  input -- 400 with a descriptive error.

## Per-workspace context

The server holds one `WorkspaceService` process-wide (via
`@emploke/api`) and lazily mints per-workspace
`{catalog, sessions, tasks}` bundles. Each bundle is a
`WorkspaceContext`, resolved through `application.getContext(id)` and
held by an internal `WorkspaceContextRegistry` private to
`@emploke/api`. Implicit invalidation happens on workspace deletion
or rename; an explicit `POST /api/workspaces/:id/reload` is also
available for operator-driven reload (e.g. recovering after the
persisted state on disk has been edited externally). Reload is
refused with HTTP 409 + `code=WorkspaceHasLiveTasksError` when the
workspace still has live task subprocesses, since dropping the
cached `TaskService` would orphan the in-flight subprocesses.

## Subprocess env contract

The server populates two env-shaping inputs that the runtime layer
consumes, plus a third per-task layer added downstream:

| Helper                          | Semantics                                          | Honoured by              | Owner            |
| ------------------------------- | -------------------------------------------------- | ------------------------ | ---------------- |
| `buildSubprocessEnvBase(...)`   | Positive: set these in every spawned subprocess    | interactive + headless   | @emploke/server  |
| `SUBPROCESS_ENV_SCRUB_KEYS`     | Negative: delete these from inherited parent env   | headless only (mergeEnv) | @emploke/server  |
| `EMPLOKE_WORKSPACE*` + `EMPLOKE_WORK_*` | Positive: per-task work-context env, layered on top of the base via `{...base, ...perTask}` | interactive + headless | @emploke/task + @emploke/session at dispatch / launch time |

The first two are passed to the `CopilotRuntime` constructor at bootstrap.
The interactive path (`buildInteractiveLaunch` -- terminal spawner)
inherits the parent env wholesale and cannot unset, so scrub keys
only take effect on headless launches. The per-task layer is added
inside `TaskService.dispatch` / `SessionService.assembleLaunchEnv` --
see those modules for the exact field list.

## Loopback binding

`assertBindIsSafe` refuses to start the server bound to anything
other than loopback (`127.0.0.1` / `::1` / IPv4-mapped IPv6
loopback). There is no escape hatch and no auth layer; for remote
access, terminate auth elsewhere and reach the server through a
loopback-equivalent (SSH port-forward, reverse proxy with mTLS /
OIDC, mesh VPN). Wildcard binds (`0.0.0.0` / `::`) are NOT accepted
-- set `EMPLOKE_HOST=127.0.0.1` (the default) to silence the error.

For the `EMPLOKE_SERVER` env var handed to subprocesses, the
`0.0.0.0` / `::` wildcards (if a future build allowed them) would
be rewritten to `127.0.0.1` so spawned children dial loopback
(Windows refuses outbound `0.0.0.0`); see `subprocess-env.ts`.

## Public API

```ts
runServer(opts?: RunServerOpts): Promise<void>;   // start the HTTP server
RunServerOpts;                                    // typed options bag

// CLI lifecycle helpers (re-exported from `./emploke-home.js`)
DEFAULT_EMPLOKE_HOME;                             // `~/.emploke` fallback
resolveEmplokeHome(env: NodeJS.ProcessEnv): string;
RUNTIME_FILE_NAME;                                // `"runtime.json"`
RuntimeFile;                                      // typed shape of <home>/runtime.json
runtimeFilePath(home: string): string;
LOGS_SUBDIR;                                      // `"logs"`
logsDir(home: string): string;
```

`@emploke/cli` consumes every member of the "CLI lifecycle helpers"
group for `emploke start` / `status` / `stop` / `connect` / `logs`;
they cannot live in `@emploke/contracts` because they value-import
`node:os` / `node:path`, and contracts is the SPA-safe surface.

## Graceful shutdown

`SIGTERM` / `SIGINT` triggers:

1. Hono server stops accepting new connections (drains inflight).
2. Tasks: every live subprocess receives `SIGTERM`; manager waits
   for terminal status.
3. `application.close()` (await -- closes every per-workspace
   context's SQLite handles, then releases `global.db`).
4. `process.exit(0)`.

A 30s deadline backstops every step in case a downstream hangs.

## Testing

```sh
pnpm --filter @emploke/server test
```

Vitest runs in `forks` pool.

## License

MIT
