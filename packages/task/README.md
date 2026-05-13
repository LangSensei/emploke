# @emploke/task

Task value type + state machine + `TaskManager` for autonomous agent runs.

## What is a task?

A *task* is a one-shot autonomous agent invocation. You give it an agent
name and instructions; the runtime spawns the agent, the agent works
unattended, and you read the result when it finishes. Contrast with
sessions, which are interactive workdirs you `copilot` into yourself.

This package ships two layers:

- **`Task` entity** — DDD class (`Task.create()`, `Task.fromStored()`,
  state-transition methods `start` / `complete` / `fail` / `cancel`,
  metadata-replace `withMetadata`). Zero I/O. Useful in tests, custom
  orchestrators, or anywhere you want to drive the entity directly.
- **`TaskManager`** — owns a `<workspace>/tasks/` directory, persists each
  task's metadata to the `tasks` table inside the per-workspace shared
  `workspace.db` (one SQLite row per task), dispatches via
  `Runtime.launchHeadless`, watches the subprocess to fold the terminal
  exit into the task value, and forwards activity reads to
  `Runtime.readActivity` / `Runtime.streamActivity` (the runtime owns
  its own event log end-to-end — emploke does NOT mirror it back into
  the workdir).

## Quick start (entity)

```ts
import { Task } from "@emploke/task";

const t0 = Task.create({ agent: "writer", instructions: "Draft the post" });
const t1 = t0.start({ metadata: { pid: 12345 } });
const t2 = t1.complete("draft.md written");
// t2.status === "success"
```

## Quick start (manager)

```ts
import { DatabaseSync } from "node:sqlite";
import { SqliteTaskRepository, TaskManager } from "@emploke/task";

// In production the per-workspace `workspace.db` connection comes from
// `WorkspaceContext`; here we open one ourselves for illustration.
const db = new DatabaseSync("/abs/path/to/workspace/workspace.db");
const mgr = new TaskManager({
  catalog,           // @emploke/catalog instance
  runtimeRegistry,   // @emploke/runtime registry
  tasksDir: "/abs/path/to/workspace/tasks",
  workspaceDir: "/abs/path/to/workspace",
  repository: new SqliteTaskRepository({ db }),
});

await mgr.recoverOrphaned();           // sweep crashed-before tasks once at boot
const t = await mgr.dispatch({ agent: "writer", instructions: "..." });
// t.status === "running" — the subprocess has been spawned; poll mgr.get(t.id)
// for status changes, fetch the runtime-parsed activity timeline via
// mgr.getTaskActivity(t.id, { cursor, limit }) for paginated reads, or
// subscribe to mgr.getTaskActivityStream(t.id, { signal }) for a live
// AsyncIterable<ActivityItem> while the task is still running.

await mgr.shutdown();                   // kills live tasks, persists "server shutdown"
```

## Task entity

Field shape (POJO projection via `task.toJSON()` — wire-identical to
the pre-DDD interface so existing HTTP clients see no change):

```ts
{
  id: string;
  agent: string;
  instructions: string;
  status: "not_started" | "running" | "success" | "failure" | "cancelled";
  metadata: Record<string, unknown>;
  createdAt: string;   // ISO 8601 UTC, e.g. "2025-06-01T12:00:00.000Z"
  startedAt?: string;
  endedAt?: string;
  result?: { output: string };
  failure?: { error: string };
}
```

The entity knows nothing about how the task is *executed*. PIDs, session
files, work directories, model identifiers — all of that lives in
`metadata`. Use `readTaskRuntimeMetadata(task)` for a typed view of the
runtime fields the manager folds in (`workdir`, `runtime`,
`runtimeSessionId`, `pid`, `exitCode`, `exitSignal`).

## State machine

```
not_started ──start──► running ──complete──► success
            │                  ──fail─────► failure
            │                  ──cancel───► cancelled
            └──cancel─────────────────────► cancelled
```

`success` / `failure` / `cancelled` are terminal — no further transitions apply.

Each transition is an instance method on `Task`; calling one against an
illegal source status throws `InvalidTransition`:

```ts
task.start({ metadata?, now? })           // not_started → running
task.complete(output, { metadata?, now? })  // running → success
task.fail(error, { metadata?, now? })       // running → failure
task.cancel({ metadata?, now? })             // not_started | running → cancelled
```

`metadata` is shallow-merged (last-wins) into the task's existing
metadata. `now` defaults to `new Date().toISOString()` and is
overridable for deterministic tests. `Task.withMetadata(metadata)`
exists separately for the manager-side enrichment path that replaces
the bag wholesale without changing status.

## On-disk layout

Each task has two stores: queryable metadata in a shared SQLite row
(in the per-workspace `workspace.db`), and an on-disk workdir for
agent artifacts.

```
<workspace>/
├── workspace.db          # SQLite — `tasks` table holds one row per task: status, runtime, agent, timings, …
└── tasks/
    └── <task-id>/        # workdir for task <task-id>
        ├── stderr.log    # bug-out only — runtime CLI errors before session exists
        └── …             # whatever the agent writes
```

The runtime adapter owns its own per-task event log end-to-end —
emploke does NOT mirror it inside the workdir. The runtime exposes
the parsed timeline through `Runtime.readActivity?(opts)` (paginated
by `cursor` + `limit`, with a `truncated` marker for source-side
caps) and an optional `Runtime.streamActivity?(opts)` (AsyncIterable
of `ActivityItem`s for live tail). For Copilot this reads
`<copilotStateDir>/<id>/events.jsonl` with a 4 MB cap; future
runtimes that store their log as a single file, a SQLite row, or
anything else fit the same contract — consumers (dashboard, CLI,
future MCP) only see structured `ActivityItem`s, never the source
format or path.

The workdir contains **no metadata sidecar file** — the directory name
is the only source of truth for the task ID, and every queryable field
lives in the workspace's `tasks` table. The runtime metadata bag the
kernel never reads
(PID, runtime session id, etc.) is stored as JSON in a `metadata`
column; the indexed `runtime` field is promoted to a first-class
column for filtering.

> Why SQLite for task metadata (and FS for the workdir)?
> See [docs/architecture.md → Backend selection](../../docs/architecture.md#backend-selection-when-fs-when-sqlite)
> for the project-wide decision rule. Task metadata uses the hybrid
> pattern: queryable fields in SQLite, agent product on FS.

## Manager lifecycle

- `dispatch(opts)` — reserves a task dir, persists `not_started`, calls
  `Runtime.launchHeadless`, applies `start` with the runtime metadata, and
  schedules the subprocess watcher. Returns the running `Task`.
- `list()` / `get(id)` — read-only.
- `delete(id)` — kills if live, awaits exit, then `rm -rf` the workdir.
- `recoverOrphaned()` — call once at boot. Scans the directory; any
  persisted `running` task gets a `fail` with reason `"orphaned (...)"`.
- `shutdown()` — kills every live subprocess, awaits the terminal
  persistence, then resolves. Idempotent. Uses `error: "server shutdown"`
  for the failure reason so the dashboard can render the cause.

## Why no `pause` / `resume`?

emploke runtimes spawn detached agent CLIs. There is no portable way to
truly pause one (Windows has no `SIGSTOP`; agent CLIs may not handle
signals). A "soft pause" UX (user clicks Pause, server stops feeding
input) belongs in `metadata`, not in the kernel state machine.

## License

MIT
