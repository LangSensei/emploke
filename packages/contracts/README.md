# `@emploke/contracts`

**Tier T2 (sibling of `@emploke/api`).** The strict-isolation entrypoint for
emploke's external surfaces: pure types (wire shapes, route catalog, domain
type re-exports) plus pure-function path helpers. No orchestration code.

## Audience

- **`@emploke/dashboard`** — sole workspace dep (declared under
  `devDependencies` because every import is `import type` and gets
  erased). Browser code needs wire
  shapes for HTTP responses and the route catalog for typed `fetch` calls;
  it must never pull Node-side orchestration into the SPA bundle. This pkg
  is structurally incapable of leaking such code into the dependency graph.
- **`@emploke/cli`** — wire shapes + route catalog. CLI keeps the
  additional `@emploke/server` dep for `runServer` (the in-process
  `emploke serve` subcommand) and for the CLI-lifecycle path helpers
  (`resolveEmplokeHome`, `logsDir`, `runtimeFilePath`, `RuntimeFile`)
  that ship from server because they value-import `node:os` /
  `node:path` and have no place in the SPA-safe surface.
- **`@emploke/server`** — uses these via `@emploke/api`'s re-export. Direct
  dep is allowed but not required.
- **`@emploke/api`** — re-exports everything here from its root barrel so
  server has a single import site.

## Contents

| File | Purpose |
|------|---------|
| `health.ts` | `HealthResponse` for `GET /api/health` |
| `plan-to-manifest.ts` | Manifest tree shapes for catalog plan resolution |
| `routes.ts` | `ROUTES` registry + `RouteSpec<Req, Res>` + every request/response body type the HTTP API exposes |
| `runtimes.ts` | `RuntimeInfo` for `GET /api/runtimes` |
| `schedules.ts` | Wire-shape schedule target DTOs (`TaskTargetData`, `TaskScheduleTargetWire`, `ScheduleWireTarget`) |
| `server-config.ts` | `ServerConfig` for `GET /api/config` (response type referenced by `routes.ts`) |
| `domain.ts` | Re-exports of T0/T1 domain types that cross the wire (`Agent`, `AgentEntry`, `Skill`, `Schedule`, etc.) |

## Why a separate pkg

The previous `@emploke/api/contracts` subpath was a soft convention —
nothing prevented dashboard or CLI from accidentally importing
orchestration symbols from `@emploke/api`'s root barrel. Promoting it to
its own package gives **structural isolation**: dashboard's `pnpm install`
literally cannot resolve `composeApplication`, `WorkspaceContext`,
`CatalogService`, or any other Node-only orchestration class — they are
not in its module graph.

This mirrors the consumer-port discipline applied between bounded
contexts: state-owning packages must be reached through a port, not
imported directly. Here the principle scales up: the composition root
(`@emploke/api`) is itself fenced off from external surfaces by the
narrower wire-only `@emploke/contracts` pkg.

## What lives here vs. `@emploke/api` vs. `@emploke/server`

- Type that crosses the HTTP boundary, or the catalog wire surface →
  **here**.
- Pure leaf function whose only effect is `path.join` / env-var read AND
  is needed by dashboard → **here**. (Today there are none — every
  current path helper is CLI / server only, see next bullet.)
- Function whose only consumers are CLI process-management commands and
  the server (`resolveEmplokeHome`, `logsDir`, `runtimeFilePath`,
  `RuntimeFile`) → **`@emploke/server`**. Keeps `node:os` /
  `node:path` value-imports out of the dashboard-facing barrel; CLI
  reaches them through its existing `@emploke/server` workspace dep.
- Function that allocates a Drizzle handle, spawns a subprocess, mutates
  the workspace registry, or otherwise needs server-side execution
  context → **`@emploke/api`**.

When in doubt: if it would be safe to call from a browser-side bundle
(setting aside `node:path` polyfilling concerns) AND dashboard or CLI
actually uses it, it belongs here.
