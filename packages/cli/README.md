# @emploke/cli

Command-line interface for emploke (lifecycle commands + HTTP API
client).

## Scope

What the CLI provides:

- Lifecycle commands that manage a local server process: `serve` (run
  in the foreground), `start` (spawn detached), `stop`, `restart`,
  `status`, `logs` (tail the rolled server log).
- Top-level singletons that hit unscoped endpoints: `health`, `config`.
- A `runtime` subtree (`runtime list`) for inspecting the runtime
  registry.
- A `workspace` subtree wired inline in `src/index.ts` (`list`, `add`,
  `current`, `use`, `show`, `update`, `rm`, `reload`).
- Four bulk-registered subtrees, one per workspace-scoped resource:
  `session`, `schedule`, `task`, `catalog` -- each registered from a
  dedicated file under `src/registrars/`.

Every API-mapping command goes through `ApiClient` (see
`api-client.ts`), which is keyed by the `ROUTES` manifest exported
from `@emploke/contracts`. A typo or stale request shape fails to
compile rather than 404-ing at runtime.

## Layout

```
packages/cli/src/
  bin.ts            Bundled binary entry: calls `run(process.argv)` and exits.
  index.ts          Exports `run(argv)`; builds the commander tree.
  commands/         Handler functions invoked by the commander tree
                    (one file per top-level command or command group).
  registrars/       Commander subtree builders for the four bulk
                    subtrees (`catalog`, `schedule`, `session`, `task`)
                    plus `_shared.ts` (flag-parsing + connect-flag helpers).
  api-client.ts     Typed HTTP client over the `ROUTES` manifest.
  connect.ts        Resolve `baseUrl` + `workspaceId` from flags, env,
                    and `<EMPLOKE_HOME>/runtime.json`.
  health-probe.ts   Poll `/api/health` (used by `start` and `status`).
  server-bundle.ts  Locate the bundled CLI/server entry that `start`
                    spawns as a detached child.
  runtime-file.ts   Atomic read / write / delete of
                    `<EMPLOKE_HOME>/runtime.json` (the lifecycle breadcrumb).
  log-paths.ts      Resolve the latest rolled `pino-roll` server log.
  output.ts         Table / record / JSON formatters and error mapping.
  result.ts         `CommandResult` shape returned by every command.
```

## Public API

```ts
import { run } from "@emploke/cli";

const code = await run(["node", "emploke", "status", "--json"]);
process.exit(code);
```

`run(argv: string[]): Promise<number>` is the only exported entry. It
returns the intended exit code instead of calling `process.exit` so
tests can assert on exit codes without aborting the runner. The bin
(`src/bin.ts`) is a two-line wrapper that calls `run(process.argv)`
and exits.

There is no `bin` field in `package.json`. The per-package CLI is not
the install pattern; users install the bundled `@langsensei/emploke`
package, whose root `bin.emploke` points at `bundle/emploke.js` (the
file produced by `esbuild.config.js` with both CLI and server
inlined).

## Why commander

The CLI ships ~30 grouped commands (`workspace list`,
`catalog skill install`, ...). `cac` matches commands by single argv
tokens, so `cli.command("workspace list", ...)` would register a
literal `"workspace list"` name that nothing can invoke. Commander
handles nested `program.command("workspace").command("list")`
natively, so the whole tree is composable per resource. Full
rationale: the JSDoc at the top of `src/index.ts`.

## Server connection

The CLI talks to a server it does NOT host. `src/connect.ts` resolves
the base URL and workspace id with the following precedence (top
wins):

1. Explicit CLI flags: `--server <url>`, `-w, --workspace <id>`.
2. Environment: `EMPLOKE_SERVER`, `EMPLOKE_WORKSPACE`.
3. `<EMPLOKE_HOME>/runtime.json` (host + port written by a recent
   `emploke start`) -- applies to the URL only; the workspace id has
   no on-disk fallback by design.
4. Hard default: `http://127.0.0.1:8787`.

The shared connect-flag bundle (`--server`, `--output`, `--json`) is
appended to every API command by `withConnectFlags`; workspace-scoped
commands additionally take `-w, --workspace <id>` via
`withWorkspaceFlags`. See [`src/registrars/_shared.ts`](src/registrars/_shared.ts).

Lifecycle commands that bind a local server (`serve`, `start`,
`restart`) take their own `--host` and `--port` flags (defaults
`127.0.0.1` and `8787`); those are bind flags on the server process,
not connect flags on the client.

## Testing

```sh
pnpm --filter @emploke/cli test
```

Unit + integration suites mock HTTP at the `fetch` boundary. Cross-
package end-to-end smoke tests that spawn a real CLI process live in
[`packages/e2e/test/cli/integration-smoke.test.ts`](../e2e/test/cli/integration-smoke.test.ts)
and [`packages/e2e/test/cli/spawn-smoke.test.ts`](../e2e/test/cli/spawn-smoke.test.ts).

Known flake: `runtime-file > write is atomic` occasionally fails with
`EPERM` on Windows under contention (Windows refuses `unlink` while
another handle holds the target); it does not reproduce on Linux/macOS.

## Tier

Top-level surface tier alongside `@emploke/dashboard`. Depends on
`@emploke/contracts` (DTOs + the `ROUTES` manifest) and
`@emploke/server` (for the bundled embed path and the shared
`runtime.json` shape). It does NOT import any other package; the
tier-invisibility fence is enforced by
`packages/e2e/test/architecture/tier-invisibility.test.ts`.

See [`docs/architecture.md` -- Tier model](../../docs/architecture.md#tier-model).
