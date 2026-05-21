# @emploke/session

Per-session workdir registry. Each session is a directory with an
agent baked in by the runtime adapter (see
[`@emploke/runtime`](../runtime)). This package **organizes** those
workdirs  it does not spawn any process.

## Why

For interactive use, the [GitHub Copilot CLI](https://github.com/github/copilot-cli)
is the chat UI. emploke''s job is to:

- prepare a workdir with an agent baked in (the runtime adapter''s
  `provision` step pulls bytes from the catalog)
- remember which workdirs exist, what agent each was baked from, and
  the opaque `runtimeSessionId` the runtime returned (this package)
- give callers the exact incantation to launch / resume the runtime
  in a workdir
- surface runtime-side display metadata (title / lastActiveAt) in
  `list()` by calling the runtime''s optional `readMetadata` hook

You launch the CLI yourself (or `WorkspaceRuntime.spawnSession`
in `@emploke/core` hands the command to `@emploke/terminal`).

## Layout

```
packages/session/src/
  schema.ts                Drizzle table def (private; only types exported)
  errors.ts                Domain error classes (exported)
  types.ts                 Public DTOs (Session, LaunchCommand, opts shapes)
  validate.ts              id regex + assertValidSessionId + generators
  session-repository.ts    Drizzle CRUD (exported as type for advanced reads)
  session-service.ts       SessionService  create/get/list/delete/buildInteractiveLaunch
  paths.ts                 Pure path builders for per-session workdirs
  compose.ts               composeSessionModule({ dbFile|db, catalog, runtimeRegistry,  })
  testing.ts               openTestSessionDb helper (via /testing subpath)
  index.ts                 public barrel
drizzle/                   generated SQL migrations (committed)
drizzle.config.ts          drizzle-kit config
```

## On-disk

Each session has two stores: queryable metadata in a SQLite row, and
an on-disk workdir for the agent''s actual product.

```
<workspace>/
 workspace.db              # SQLite  `sessions` table: one row per session
 sessions/
     <id>/                 # workdir for session <id>
         AGENTS.md         # baked by the runtime provisioner
         .github/skills/   # and whatever else the provisioner wrote
                          # plus anything the agent itself produces
```

`<id>` is a short date-prefixed identifier:

```
YYYYMMDD-xxxxxxxx
e.g. 20260508-9dfbdf05
```

The 8-hex suffix gives ~4 billion values per day, more than enough
for ad-hoc creation. The workdir contains **no metadata sidecar
file**  the agent name is parsed from `AGENTS.md` frontmatter at
read time, and `runtime` / `createdAt` / `runtimeSessionId` /
`lastLaunchMode` come from the row in the workspace''s `sessions`
table. The directory name is the **only source of truth for the
session id**.

> Why SQLite for session metadata (and FS for the workdir)? See
> [docs/architecture.md  Backend selection](../../docs/architecture.md#backend-selection-when-sqlite)
> for the project-wide decision rule. Session metadata uses the
> hybrid pattern: queryable fields in SQLite, agent product on FS.

## Public API

```ts
import { composeSessionModule } from "@emploke/session";

const { service, close } = await composeSessionModule({
  dbFile: "/abs/path/to/workspace.db",     // OR db: <existing Drizzle handle>
  catalog,                                  // CatalogService
  runtimeRegistry,                          // RuntimeRegistry from @emploke/runtime
  workspaceDir: "/abs/workspace-dir",
  workspaceId: "<uuid>",
});

const session = await service.create({ agent: "demo-agent" });
console.log(session.workdir);

const cmd = await service.buildInteractiveLaunch(session.id);
console.log(cmd.display);
//  cd "/.../sessions/20260508-9dfbdf05" && copilot --session-id=<id> --yolo

await service.list();                       // Session[]
await service.get(session.id);              // Session | null
await service.delete(session.id, { purge: false });

await close();
```

Resume is the same call as launch  once a `runtimeSessionId`
exists, `buildInteractiveLaunch` emits `--session-id=<id>`; for a
fresh session it emits `--yolo` with no id. (This package targets
Copilot CLI  1.0.45 which renamed `--resume` to `--session-id`.)

`buildInteractiveLaunch(id, { remote: true })` produces a
remote-friendly variant when the runtime supports it (otherwise
throws `RuntimeDoesNotSupportRemoteError`).

## Env layering

`SessionService` does NOT own the cross-cutting subprocess env
(`EMPLOKE_SERVER`, `EMPLOKE_SHARED_DIR`, ). The runtime adapter
owns it via `CopilotRuntimeConfig.subprocessEnvBase`; the session
service layers per-session work-context env (`EMPLOKE_WORKSPACE`,
`EMPLOKE_WORK_KIND=session`, `EMPLOKE_WORK_ID=<id>`,
`EMPLOKE_WORK_DIR=<workdir>`) on top of whatever the runtime
returned.

## What this package does NOT do

- Spawn `copilot`. `buildInteractiveLaunch` returns the invocation;
  the terminal pkg or `WorkspaceRuntime.spawnSession` (in
  `@emploke/core`) hands it to a terminal.
- Track headless task execution. That''s [`@emploke/task`](../task).
- Stream events from Copilot. The Copilot CLI handles the chat UI
  itself.

## Caveats

- **One Copilot session per emploke workdir**. Provision pre-allocates
  a `runtimeSessionId` and threads it through `--session-id=<id>` on
  every launch  first launch creates the Copilot session, subsequent
  launches resume the same one.
- **Path matching**: case-insensitive on Windows, case-sensitive
  elsewhere (no special handling for case-insensitive macOS volumes 
  pull requests welcome).
- **`delete(id, { purge: true })`** may fail with `EBUSY` on Windows
  if Copilot currently has the session open. The error is surfaced;
  the metadata row is left intact.

## Testing

```sh
pnpm --filter @emploke/session test
```

Vitest runs in `forks` pool (better-sqlite3''s native binding
segfaults on worker-thread teardown on Windows).

## License

MIT