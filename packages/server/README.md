# @emploke/server

The HTTP API surface  a [Hono](https://hono.dev) app that mounts
workspace-scoped catalog / session / task routes plus the workspace
registry. Bundled into the published `emploke` binary; also runs
standalone for development.

Post de-DDD: the server is a **pure transport adapter** over
[`@emploke/core`](../core). Every route is parse  dispatch to core
or to the per-workspace runtime  format. Business logic lives in
the entity services; orchestration (cache, spawn, register/rename)
lives in core.

## URL scheme

Workspace-scoped resources live under `/api/workspaces/<wsid>/...`
where `<wsid>` is the workspace''s opaque UUID  stable for the
lifetime of the registry entry, so dashboard URLs survive workspace
renames.

```text
/api/workspaces                                 list / create
/api/workspaces/current                         get / set the most-recently-selected
/api/workspaces/:id                             get / patch / delete (?purge=1)
/api/workspaces/:id/reload                      POST: force-rebuild per-workspace cache
/api/workspaces/:id/catalog/{agents,skills,mcps,overview}
                                                per-workspace catalog
/api/workspaces/:id/sessions                    list (filters) / create
/api/workspaces/:id/sessions/:sid               get / delete (?purge=1)
/api/workspaces/:id/sessions/:sid/spawn         hand-off to user terminal
/api/workspaces/:id/tasks                       list (filters) / POST dispatch
/api/workspaces/:id/tasks/:tid                  get / delete (?purge=1)
/api/workspaces/:id/tasks/:tid/activity         runtime-parsed timeline (tail-paginated)
/api/workspaces/:id/tasks/:tid/activity/stream  Server-Sent Events live tail
/api/runtimes                                   list registered runtime kinds
/api/config                                     server-side config snapshot for the dashboard
```

There is no global catalog mount  switching workspace switches the
catalog the dashboard sees.

## Verb conventions

- **`?purge=1`** on every DELETE. Default (no flag) removes only
  emploke metadata; `purge=1` also wipes the entity''s sandbox dir.
  See [`docs/architecture.md`](../../docs/architecture.md).
- **Time filters canonicalise** any `Date.parse`-able input into ISO
  8601 with a `Z` suffix before forwarding to services; the
  service''s lexicographic compare relies on canonical form. Garbage
  input  400 with a descriptive error.

## Per-workspace context cache

The server holds one `WorkspaceService` process-wide (via
`@emploke/core`) and lazily mints per-workspace
`{catalog, sessions, tasks}` bundles behind a `WorkspaceRuntimeCache`.
Implicit invalidation happens on workspace deletion or
rename; an explicit `POST /api/workspaces/:id/reload` is also
available for operator-driven reload (e.g. recovering after the
persisted state on disk has been edited externally). Reload is
refused with HTTP 409 + `code=WorkspaceHasLiveTasksError` when the
workspace still has live task subprocesses, since dropping the
cached `TaskService` would orphan the in-flight subprocesses.

## Subprocess env contract

The server populates two env-shaping inputs that the runtime layer
consumes:

| Helper                          | Semantics                                          | Honoured by              |
| ------------------------------- | -------------------------------------------------- | ------------------------ |
| `buildSubprocessEnvBase(...)`   | Positive: set these in every spawned subprocess   | interactive + headless   |
| `SUBPROCESS_ENV_SCRUB_KEYS`     | Negative: delete these from inherited parent env  | headless only (mergeEnv) |

Both are passed to the `CopilotRuntime` constructor at bootstrap.
The interactive path (`buildInteractiveLaunch`  terminal spawner)
inherits the parent env wholesale and cannot unset, so scrub keys
only take effect on headless launches.

## Loopback binding

`assertBindIsSafe` refuses to start the server bound to anything
other than loopback (`127.0.0.1` / `::1` / IPv4-mapped IPv6
loopback). There is no escape hatch and no auth layer; for remote
access, terminate auth elsewhere and reach the server through a
loopback-equivalent (SSH port-forward, reverse proxy with mTLS /
OIDC, mesh VPN). Wildcard binds (`0.0.0.0` / `::`) are NOT accepted
— set `EMPLOKE_HOST=127.0.0.1` (the default) to silence the error.

For the `EMPLOKE_SERVER` env var handed to subprocesses, the
`0.0.0.0` / `::` wildcards (if a future build allowed them) would
be rewritten to `127.0.0.1` so spawned children dial loopback
(Windows refuses outbound `0.0.0.0`); see `subprocess-env.ts`.

## Graceful shutdown

`SIGTERM` / `SIGINT` triggers:

1. Hono server stops accepting new connections (drains inflight).
2. Tasks: every live subprocess receives `SIGTERM`; manager waits
   for terminal status.
3. `cache.closeAll()` (await  releases every per-workspace SQLite
   handle).
4. `composition.close()` (releases `global.db`).
5. `process.exit(0)`.

A 30s deadline backstops every step in case a downstream hangs.

## Testing

```sh
pnpm --filter @emploke/server test
```

Vitest runs in `forks` pool.

## License

MIT