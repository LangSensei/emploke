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
  task-entity.ts           TaskEntity state machine (private)
  task-service.ts          TaskService facade - dispatch/get/list/cancel/delete/getTaskActivity
  task-service/            Internal concern modules composed by the facade:
                           agent-resolver.ts (catalog/runtime resolution),
                           dispatch.ts (per-dispatch spawn + exit-watcher wiring),
                           mutations.ts (cancel/delete/recover write-side),
                           queries.ts (read-side), activity-stream.ts (runtime
                           activity surface), shutdown.ts (lifecycle hooks),
                           _helpers.ts (shared private utilities: LiveTask,
                           applyTerminal, decideTerminal, safeRm).
  task-meta.ts             readTaskRuntimeMetadata (runtime hook)
  framing.ts               TASK_FRAMING_PROMPT_COPILOT + formatTaskMd helpers +
                           TASK_FILENAME / TASK_TEMP_SUBDIR / TASK_ARTIFACT_SUBDIR
                           on-disk contract constants + assertFramingPromptIsSafe
  paths.ts                 safeJoinUnderRoot path-traversal guard
  ports.ts                 AgentResolverPort + AgentEntry / BlockedReason /
                           BlockedDep / MissingDep (structural catalog contract)
  workdir.ts               listWorkdirFiles workdir-artifact enumerator
  migrations.ts            applyTaskMigrations (drizzle migration applier)
  compose.ts               composeTaskModule({ dbFile, catalog, runtimeRegistry, … })
  testing.ts               openTestTaskDb helper (via /testing subpath)
  index.ts                 public barrel
drizzle/                   generated SQL migrations (committed)
drizzle.config.ts          drizzle-kit config
```

`task-service/` is the **SPLIT sub-layout** - present here because `task-service.ts` outgrew the split threshold (>= 600 LOC AND >= 3 cohesive concerns). Most packages should stay flat (no sibling subdir); see [`docs/pkg-template.md § Splitting big files via facade + sibling subdir`](../../docs/pkg-template.md#splitting-big-files-via-facade--sibling-subdir) for the full hard-rule list and the on-disk reference example at [`packages/_template/_examples/split-layout/`](../_template/_examples/split-layout/).

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

await service.list();                                       // Task[]
await service.list({ statuses: ["running"], agent: "writer" });
await service.get(task.id);                                 // Task | null
await service.liveCount();                                  // number — in-flight + live
await service.hasInFlightForSchedule(scheduleId);           // boolean
await service.deleteForSchedule(scheduleId);                // { deletedCount }
await service.cancel(task.id);                              // best-effort SIGTERM
await service.delete(task.id, { purge: false });
const abs = await service.resolveArtifactPath(task.id, "report.html");

// Activity streaming
const items = await service.getTaskActivity(task.id, { limit: 50 });
const stream = await service.getTaskActivityStream(task.id, { signal });
if (stream !== null) {
  for await (const item of stream) {
    // SSE-style tail
  }
}

await service.shutdown();                  // kill + drain live subprocesses
service.close();                           // release manager-owned resources (no-op today)
await close();                             // composeTaskModule cleanup: closes DB
```

### Helpers (framing / paths / metadata / port contract)

These are all top-level exports from `@emploke/task` for callers that need
to interact with the on-disk task contract or implement the
`AgentResolverPort`:

```ts
import {
  // file-based task brief + artifact contract
  TASK_FILENAME,            // "TASK.md"
  TASK_TEMP_SUBDIR,         // "temp"
  TASK_ARTIFACT_SUBDIR,     // "artifact"
  TASK_FRAMING_PROMPT_COPILOT,
  assertFramingPromptIsSafe,
  formatTaskMd,             // render `# <brief>\n\n<details>\n`
  // workdir + path helpers
  listWorkdirFiles,         // enumerate `<workdir>/<subdir>` recursively
  safeJoinUnderRoot,        // path-traversal-safe join
  // runtime metadata projection
  readTaskRuntimeMetadata,
  type TaskRuntimeMetadata,
  // structural catalog port (implement to plug a different catalog)
  type AgentResolverPort,
  type AgentEntry,
  type BlockedReason,
  type BlockedDep,
  type MissingDep,
  // id helpers
  assertValidTaskId,
  generateTaskId,
  TASK_ID_RE,
} from "@emploke/task";
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

- `TaskError`  base class for the errors below; consumers narrow with `instanceof`
- `TaskNotFoundError`  unknown id
- `InvalidTaskIdError`  id regex failed
- `CorruptedTaskError`  row failed validation on read
- `AgentNotFoundError`  agent FQN not in catalog
- `AgentResolutionFailedError`  catalog itself misbehaved while resolving the agent (vs `AgentNotFoundError`, which is a clean miss)
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