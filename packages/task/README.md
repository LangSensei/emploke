# @emploke/task

Pure value type + state machine for emploke tasks. Zero I/O.

## Install

```sh
pnpm add @emploke/task
```

## Quick start

```ts
import { create, apply } from "@emploke/task";

const t0 = create({ agent: "writer", instructions: "Draft the post" });
// t0.status === "not_started"

const t1 = apply(t0, { type: "start", metadata: { pid: 12345 } });
// t1.status === "running", t1.startedAt set, t1.metadata.pid === 12345

const t2 = apply(t1, { type: "complete", output: "draft.md written" });
// t2.status === "success", t2.result?.output === "draft.md written"
```

## Design

`Task` is a pure value:

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
files, work directories, model identifiers — all of that lives in `metadata`.
Each runtime owns its own keys and (by convention) publishes a typed
reader from its package.

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

## Why no `pause` / `resume`?

emploke runtimes spawn detached agent CLIs. There is no portable way to
truly pause one (Windows has no `SIGSTOP`; agent CLIs may not handle
signals). A "soft pause" UX (user clicks Pause, server stops feeding
input) belongs in `metadata`, not in the kernel state machine.

## License

MIT
