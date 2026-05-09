# @emploke/server

The HTTP API surface — a [Hono](https://hono.dev) app that mounts
workspace-scoped catalog / session / task routes plus the workspace
registry. Bundled into the published `emploke` binary; also runs
standalone for development.

## URL scheme

Workspace-scoped resources live under `/api/workspaces/<wsid>/...`
where `<wsid>` is the workspace's opaque UUID — stable for the
lifetime of the registry entry, so dashboard URLs survive workspace
renames.

```text
/api/workspaces                                 list / create
/api/workspaces/current                         get / set the most-recently-selected
/api/workspaces/:id                             get / patch / delete (?purge=1)
/api/workspaces/:id/catalog/{agents,skills,mcps,overview}
                                                per-workspace catalog
/api/workspaces/:id/sessions                    list (filters: agent / activeSince) / create
/api/workspaces/:id/sessions/:sid               get / delete (?purge=1, ?deleteRuntimeState=1)
/api/workspaces/:id/sessions/:sid/spawn         hand-off to user terminal
/api/workspaces/:id/tasks                       list (filters: agent / runtime / status / createdSince)
/api/workspaces/:id/tasks                       POST: dispatch
/api/workspaces/:id/tasks/:tid                  get / delete (?purge=1)
/api/workspaces/:id/tasks/:tid/events           streaming event log
/api/runtimes                                   list registered runtime kinds
/api/config                                     server-side config snapshot for the dashboard
```

There is no global catalog mount — switching workspace switches the
catalog the dashboard sees.

## Verb conventions

- **`?purge=1`** on every DELETE. Default (no flag) removes only
  emploke metadata; `purge=1` also wipes the entity's sandbox dir.
  See [`docs/architecture.md`](../../docs/architecture.md#unified-verb-conventions).
- **Time filters canonicalise** any `Date.parse`-able input into ISO 8601
  with a `Z` suffix before forwarding to managers; the manager's
  lexicographic compare relies on canonical form. Garbage input
  → 400 with a descriptive error.

## Per-workspace context cache

The server holds one `WorkspaceManager` process-wide and lazily mints
per-workspace `CatalogManager` / `SessionManager` / `TaskManager`
instances behind a `WorkspaceContextCache`. Cache invalidation
happens on workspace deletion or metadata update.

```text
                          ┌─── catalog ───┐
GET /workspaces/<id>/...  │                │
                          ├─── sessions ──┤  (one of these
WorkspaceContextCache ────┼─── tasks  ────┤   per workspace,
                          │                │   constructed lazily)
                          └─── catalog ───┘
```

This means the cost of "switch workspace" in the dashboard is one
cache lookup; the manager instances are stateless beyond their
backing repositories so the cache can be flushed on demand without
losing in-flight work.

## Boot

Production bundle (`pnpm bundle` produces `bundle/emploke.js`) is the
default. For development:

```ts
import { createServer } from "@emploke/server";
import { CopilotRuntime } from "@emploke/runtime";

const server = await createServer({
  emplokeHome: "/Users/me/.emploke",     // EMPLOKE_HOME
  port: 8787,
  host: "127.0.0.1",
  runtimes: [new CopilotRuntime()],
  serveStatic: false,                    // dev: Vite serves dashboard separately
});
await server.listen();
```

Or use the bundled binary:

```sh
PORT=8787 EMPLOKE_HOME=~/.emploke node bundle/emploke.js
```

See the [root README](../../README.md#configuration) for the full env
var table.

## Security defaults

- **Loopback-only by default.** `EMPLOKE_HOST` defaults to `127.0.0.1`.
- **Non-loopback requires `EMPLOKE_API_KEY`.** Setting `EMPLOKE_HOST` to
  e.g. `0.0.0.0` without `EMPLOKE_API_KEY` causes `createServer` to
  refuse to start. A misconfigured production deploy fails fast at
  boot, not silently exposes the catalog to the LAN.
- **Bearer-token check on every `/api/*` request** when
  `EMPLOKE_API_KEY` is set. Failure is 401 without leaking
  whether the token format was bad vs the comparison failed.

## Error mapping

Every entity package defines its own typed error hierarchy
(`WorkspaceError`, `CatalogError`, `RuntimeError`, …). The server
maps them to HTTP status codes via `instanceof` checks; the
`packages/server/src/routes/_shared.ts` `errorBody()` helper
serialises them with a `code` (the error class name) and a sanitised
`error` (the message; never includes stack or fs paths).

```ts
WorkspaceIdInvalidError       → 400
WorkspaceNotRegisteredError   → 404
WorkspaceIdConflictError      → 409
WorkspacePathConflictError    → 409
WorkspaceCorruptedError       → 500
RegistryError                 → 500
WorkspaceError (catch-all)    → 500
```

Error codes are stable; the dashboard branches on them for
user-friendly messaging (e.g. `WorkspaceIdConflictError` →
"This workspace id is already in use" rather than the raw error).

## Shutdown handling

The server installs SIGTERM / SIGINT handlers at boot. On shutdown:

1. `httpServer.close()` — refuse new connections, drain in-flight.
2. `taskManager.shutdown()` for every workspace — kills every live
   subprocess, awaits the "server shutdown" terminal persistence,
   then resolves. The `error: "server shutdown"` reason lets the
   dashboard render the cause correctly when the user reconnects.
3. `process.exit(0)`.

Step 2 is the slowest in practice (a hung Copilot subprocess can
take a couple of seconds to die on Windows). The handler is
idempotent — repeated SIGINT gets the same result.

## Testing

```sh
pnpm --filter @emploke/server test
```

132 tests cover route shape, error mapping, query-param
canonicalisation, the `?purge=1` semantics, the workspace context
cache, and end-to-end shutdown behavior.

## License

MIT
