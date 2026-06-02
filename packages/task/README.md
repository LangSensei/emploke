# @emploke/task

`TaskService` for autonomous (headless) agent runs. A *task* is a
one-shot autonomous agent invocation: you give it an agent name, a
short single-line `brief`, and an optional multi-line `details` body;
the runtime spawns the agent, the agent works unattended, and you
read the result when it finishes. Contrast with sessions, which are
interactive workdirs the user `copilot`s into themselves.

The `TaskEntity` class with state-machine methods is internal to this
package; external consumers see the `Task` DTO returned by
`TaskService` reads/writes.

## Layout

```
packages/task/src/
  schema.ts                Drizzle table def (private; only types exported)
  errors.ts                Domain error classes (exported)
  types.ts                 Public DTOs (Task, status, opts shapes)
  validate.ts              id regex + assertValidTaskId + generators
  task-repository.ts       Drizzle CRUD (private; never exported)
  task-entity.ts           TaskEntity  state machine (private)
  task-service.ts          TaskService facade — dispatch/get/list/cancel/delete/getTaskActivity
  task-service/            Internal concern modules (queries, mutations, agent-resolver,
                           activity-stream, shutdown) composed by the facade; see
                           docs/pkg-template.md § Splitting big files via facade + sibling subdir
  task-meta.ts             readTaskRuntimeMetadata (runtime hook)
  framing.ts               TASK_FRAMING_PROMPT_COPILOT + formatTaskMd helpers
  paths.ts                 safeJoinUnderRoot path-traversal guard
  migrations.ts            applyTaskMigrations (drizzle migration applier)
  compose.ts               composeTaskModule({ dbFile, catalog, runtimeRegistry, … })
  testing.ts               openTestTaskDb helper (via /testing subpath)
  index.ts                 public barrel
drizzle/                   generated SQL migrations (committed)
drizzle.config.ts          drizzle-kit config
```

`task-service/` is the **SPLIT sub-layout** — present here because `task-service.ts` outgrew the 600 LOC / 3-concern thresholds. Most packages should stay flat (no sibling subdir); see [`docs/pkg-template.md § Splitting big files via facade + sibling subdir`](../../docs/pkg-template.md#splitting-big-files-via-facade--sibling-subdir) for the trigger criteria, the hard rules that apply once a split is taken, and the on-disk reference example at [`packages/_template/_examples/split-layout/`](../_template/_examples/split-layout/) (which the spec doc now documents inline under "On-disk reference example").

## On-disk

```
<workspace>/
 workspace.db           # SQLite  `tasks` table: one row per task
 tasks/
     <id>/              # workdir for task <id>
         TASK.md        # `brief` + `details` written by TaskService for the agent to read
         AGENTS.md      # baked by the runtime provisioner
                       # plus whatever the agent produced
```

`<id>` is a short date-prefixed identifier `YYYYMMDD-xxxxxxxx`. The
workdir contains no metadata sidecar  `runtime` / `agent` /
`status` / `brief` etc. all come from the row in `tasks`.

## Public API

```ts
import { composeTaskModule } from "@emploke/task";

const { service, close } = await composeTaskModule({
  dbFile: "/abs/workspace.db",
  catalog,                                 // CatalogService
  runtimeRegistry,                         // RuntimeRegistry
  workspaceDir: "/abs/workspace-dir",
  workspaceId: "<uuid>",
});

await service.recoverOrphaned();          // sweep crashed-before tasks once at boot
const task = await service.dispatch({
  agent: "writer",
  brief: "Draft the post",
  details: "Tone: warm. Length: ~600 words.",
});

await service.list();                     // Task[]
await service.get(task.id);               // Task | null
await service.cancel(task.id);            // best-effort SIGTERM
await service.delete(task.id, { purge: false });

// Activity streaming
const items = await service.getTaskActivity(task.id, { limit: 50 });
const stream = await service.getTaskActivityStream(task.id, { signal });
if (stream !== null) {
  for await (const item of stream) {
    // SSE-style tail
  }
}

await close();                            // sweeps live subprocesses + closes DB
```

## State machine

Statuses are persisted on the row:

```
running → succeeded | failed | cancelled
```

`dispatch` creates the task directly in `running` and immediately starts
the runtime subprocess; the eventual exit folds into a terminal status
(`succeeded`, `failed`, or `cancelled` — the latter only via
`TaskService.cancel(id)`). The service supervises every live subprocess
in-memory and reconciles to disk on shutdown via `recoverOrphaned`.

## Env layering

`TaskService` does NOT own the cross-cutting subprocess env
(`EMPLOKE_SERVER`, `EMPLOKE_SHARED_DIR`). The runtime adapter owns
it via `CopilotRuntimeConfig.subprocessEnvBase`; the task service
layers per-task work-context env (`EMPLOKE_WORKSPACE`,
`EMPLOKE_WORK_KIND=task`, `EMPLOKE_WORK_ID=<id>`,
`EMPLOKE_WORK_DIR=<workdir>`) on top of whatever the runtime
returned. Scrub-style overrides (`EMPLOKE_HOME` deleted from
inheritance) live in `CopilotRuntimeConfig.subprocessEnvScrub` and
are honoured on the headless launch path by `mergeEnv`.

## Errors

- `TaskNotFoundError`  unknown id
- `InvalidTaskIdError`  id regex failed
- `CorruptedTaskError`  row failed validation on read
- `AgentNotFoundError`  agent FQN not in catalog
- `InvalidTransition`  illegal state-machine transition
- `EntryNotReadyError`  runtime returned before agent was ready
- `ManagerShuttingDownError`  dispatch refused during shutdown
- `RuntimeDoesNotSupportTasksError`  runtime is interactive-only
- `TaskIdAllocationFailedError`  id generator exhausted retries

## Testing

```sh
pnpm --filter @emploke/task test
```

Vitest runs in `forks` pool (better-sqlite3''s native binding
segfaults on worker-thread teardown on Windows).

## License

MIT