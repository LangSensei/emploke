# ADR-002 — Runtime metadata enrichment scope

Status: Accepted
Date: 2026-05-23
Related: issue #180, issue #181

## Context

`TaskService.enrichWithRuntimeMetadata(task)` fans out a
`runtime.readMetadata(runtimeSessionId)` call to fold the runtime's
`lastActiveAt` timestamp into `task.metadata.lastActiveAtRuntime` so
the dashboard can render "last active a few seconds ago" on each row.

Before this ADR the enrichment ran on every `TaskService.list()` call,
fanning out `O(N)` runtime calls per dashboard poll. Each call is one
small fs operation on the runtime's own state dir, which costs a libuv
worker thread for the duration of the read. The default libuv pool is
**4 threads**. At workspace scale (dozens of tasks, dashboard polling
every few seconds) this saturated the pool and starved everything else
that touches fs (purge `fs.rm`, config reads, log writes), with two
visible symptoms:

1. The dashboard's task list lagged by 200–800 ms when paired with an
   in-progress `delete({ purge: true })` whose background `fs.rm` was
   pinning libuv threads.
2. Multiple back-to-back `delete({ purge: true })` calls (operator
   clicking the bulk-delete control) all fired `setImmediate`-deferred
   `fs.rm` in parallel; each held a libuv worker for the duration,
   making the dashboard's polled `list()` calls block on the pool.

## Decision

Three coordinated changes:

### 1. Drop enrichment from `TaskService.list()`

`list()` returns the rows the repository hands back, unenriched. The
field `lastActiveAtRuntime` is genuinely useful only for **running**
tasks: it answers "is this still making progress, or is it stuck?".
For terminal tasks the field has no consumer and the runtime state
directory may already be gone (purge runs in the background after the
DB row is removed). Callers that need the per-task recency for a list
row must call `get(id)` on the tasks they want enriched (today: the
CEO watchdog's stuck-task probe).

### 2. Narrow enrichment on `TaskService.get()` to running tasks

```ts
async get(id: string): Promise<TaskEntity | null> {
  ...
  if (task.status !== "running") return task;
  return this.enrichWithRuntimeMetadata(task);
}
```

The original draft of this ADR said "keep enrichment on `get()`".
Narrowing to `status === "running"` is strictly safer: it never reads
a runtime state dir that purge may have removed and it never wastes a
libuv thread on a field nobody will read.

### 3. Serialise background purges + bump libuv pool

The purge path replaced its `Set<Promise> + setImmediate` fan-out with
a single chained promise:

```ts
private purgeQueue: Promise<void> = Promise.resolve();

scheduleBackgroundPurge(...) {
  this.purgeQueue = this.purgeQueue.then(
    () => this.runBackgroundPurge(...),
    () => this.runBackgroundPurge(...),  // continue chain after a failure
  );
}
```

So N concurrent `delete({ purge: true })` calls pin at most ONE libuv
worker on `fs.rm` regardless of N. The test seam
`_drainPendingPurgesForTest` awaits the chain head.

In addition the server bumps the libuv pool from the default 4 → 16
at startup:

```ts
process.env.UV_THREADPOOL_SIZE ??= "16";
```

`??=` lets operators override via env. The assignment runs BEFORE any
import that uses fs / zlib / crypto worker threads (better-sqlite3,
pino-roll, hono/node-server).

## Consequences

- The dashboard's task list never spends per-row time on runtime
  introspection — `list()` is now a pure repository read. Callers that
  want recency on a specific row call `get(id)`.
- `lastActiveAtRuntime` only ever appears on running rows. Dashboards
  that previously rendered it on terminal tasks (we have none) would
  silently start seeing the field disappear.
- Background purges run serially. A burst of N deletes takes Nx the
  wall-clock time of one delete instead of fighting for libuv threads
  — but during that time the rest of the server is unaffected.
- Bumped libuv pool gives the remaining fs traffic headroom even
  during a long-running purge.

## Out of scope

- A general fs-thread budget / queue (no other call site needs it).
- Mirroring `lastActiveAt` into the persisted row (it changes every
  few seconds; persisting would dominate write volume).
