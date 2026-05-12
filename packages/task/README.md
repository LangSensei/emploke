# @emploke/task

Task value type + state machine + `TaskManager` for autonomous agent runs.

## What is a task?

A *task* is a one-shot autonomous agent invocation. You give it an agent
name and instructions; the runtime spawns the agent, the agent works
unattended, and you read the result when it finishes. Contrast with
sessions, which are interactive workdirs you `copilot` into yourself.

This package ships two layers:

- **Pure kernel** — `Task` value, `apply()` reducer, event types. Zero I/O.
  Useful in tests, custom orchestrators, or anywhere you want to drive the
  FSM directly.
- **`TaskManager`** — owns a `<workspace>/tasks/` directory, persists each
  task as `task.json`, dispatches via `Runtime.dispatchTask`, junctions
  the runtime's per-task state directory under `<task>/session/`, and
  watches the subprocess to fold the terminal exit into the task value.

## Quick start (kernel)

```ts
import { create, apply } from "@emploke/task";

const t0 = create({ agent: "writer", instructions: "Draft the post" });
const t1 = apply(t0, { type: "start", metadata: { pid: 12345 } });
const t2 = apply(t1, { type: "complete", output: "draft.md written" });
// t2.status === "success"
```

## Quick start (manager)

```ts
import { TaskManager } from "@emploke/task";

const mgr = new TaskManager({
  catalog,           // @emploke/catalog instance
  runtimeRegistry,   // @emploke/runtime registry
  tasksDir: "/abs/path/to/workspace/tasks",
});

await mgr.recoverOrphaned();           // sweep crashed-before tasks once at boot
const t = await mgr.dispatch({ agent: "writer", instructions: "..." });
// t.status === "running" — the subprocess has been spawned; poll mgr.get(t.id)
// for status changes, or fetch the runtime-parsed activity timeline via
// mgr.getTaskActivity(t.id) for streaming progress.

await mgr.shutdown();                   // kills live tasks, persists "server shutdown"
```

## Task value

```ts
interface Task {
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

The kernel knows nothing about how the task is *executed*. PIDs, session
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

`success` / `failure` / `cancelled` are terminal — no further events apply.

`apply()` throws `InvalidTransition` for illegal events.

## Events

```ts
type TaskEvent =
  | { type: "start"; metadata?: Record<string, unknown> }
  | { type: "complete"; output: string; metadata?: Record<string, unknown> }
  | { type: "fail"; error: string; metadata?: Record<string, unknown> }
  | { type: "cancel"; metadata?: Record<string, unknown> };
```

Every event accepts an optional `metadata` patch. Patches are
**shallow-merged, last-wins** into the task's metadata. There is no
delete operation — Task is a history accumulator.

## On-disk layout

Each task has two stores: queryable metadata in a SQLite row, and an
on-disk workdir for agent artifacts.

```
<workspace>/tasks/
├── tasks.db              # SQLite — one row per task: status, runtime, agent, timings, …
└── <task-id>/            # workdir for task <task-id>
    ├── stderr.log        # bug-out only — runtime CLI errors before session exists
    └── …                 # whatever the agent writes
```

The runtime adapter owns its own per-task event log end-to-end —
emploke does NOT mirror it via a junction inside the workdir. The
runtime exposes the parsed timeline through `Runtime.taskActivity?(opts)`,
which reads its native log (Copilot: `<copilotStateDir>/<id>/events.jsonl`),
filters + lifts each event into the runtime-neutral `ActivityItem`
vocabulary, and returns the bundle. A future runtime that stores its
log as a single file, a SQLite row, or anything else fits the same
contract — consumers (dashboard, CLI) never see the source format.

The workdir contains **no metadata sidecar file** — the directory name
is the only source of truth for the task ID, and every queryable field
lives in `tasks.db`. The runtime metadata bag the kernel never reads
(PID, runtime session id, etc.) is stored as JSON in a `metadata`
column; the indexed `runtime` field is promoted to a first-class
column for filtering.

> Why SQLite for task metadata (and FS for the workdir)?
> See [docs/architecture.md → Backend selection](../../docs/architecture.md#backend-selection-when-fs-when-sqlite)
> for the project-wide decision rule. Task metadata uses the hybrid
> pattern: queryable fields in SQLite, agent product on FS.

## Manager lifecycle

- `dispatch(opts)` — reserves a task dir, persists `not_started`, calls
  `Runtime.dispatchTask`, applies `start` with the runtime metadata, and
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
