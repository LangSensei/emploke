# @emploke/schedule

Cron-triggered task dispatch as a substrate-side referee. Owns one
table — `schedules` — plus the entity invariants (5-field cron only,
UUID v4 ids, target/trigger discriminated unions) and the
`ScheduleService` surface (reads + writes + `recover()` +
`shutdown()` + `preview()` + `run()`).

v1 locks `target.kind` to `"task"` and `trigger.kind` to `"cron"`;
both unions are designed for additive extension (`"workflow"` target,
`"interval"` trigger) without a schema bump.

`ScheduleTarget.task` mirrors `@emploke/task` `DispatchOpts` — single
`brief` (≤ 200 chars, no newlines) plus optional `details` (RFC #61
v2). The substrate adapter in `@emploke/core` is a pass-through; no
brief synthesis. HTTP / CLI / dashboard surface lands via
`@emploke/server` routes, `emploke schedule` CLI subcommands, and the
dashboard's "New schedule" modal (issue #222).

## Layout

Standard `packages/_template` shape plus one net-new file `cron.ts`:

```
packages/schedule/
├── drizzle.config.ts
├── package.json
├── README.md
├── tsconfig.json
├── vitest.config.ts
├── drizzle/0000_*.sql       Drizzle-kit generated migration (committed)
├── drizzle/0001_*.sql       Hand-written: drops target_agent + adds
│                            functional partial JSON-extract index
└── src/
    ├── compose.ts            composeScheduleModule({ dbFile, taskDispatcher, agentValidator })
    ├── cron.ts               croner + cronstrue wrapper (validate / nextRuns / describe)
    ├── errors.ts             8 named error classes
    ├── index.ts              public barrel
    ├── migrations.ts         AUTO-GENERATED inlined SQL
    ├── schedule-entity.ts    ScheduleEntity factory + invariants + DTO projection
    ├── schedule-repository.ts Drizzle CRUD (private)
    ├── schedule-service.ts   ScheduleService reads + writes + timer chain
    ├── schema.ts             Drizzle table definition (private)
    ├── testing.ts            openTestScheduleDb() in-memory test helper
    ├── types.ts              wire DTOs, ScheduleTrigger/ScheduleTarget (brief+details?), TaskDispatcher
    └── validate.ts           SCHEDULE_ID_RE + generateScheduleId
```

## Invariants

1. **Cron dialect** — 5-field POSIX only. 6-field expressions are
   rejected with `InvalidCronExprError` carrying the literal phrase
   `"6-field cron not supported in v1"`.
2. **Concurrency = 1** — if `taskDispatcher.hasInFlightForSchedule(id)`
   returns `true` at fire time, the tick is skipped (warn-logged) and
   re-armed without writing `last_fired_at`.
3. **Catchup-once** — `recover()` collapses every missed fire into a
   single catchup dispatch with `metadata.firedAt` set to the planned
   (past) time, not `now`.
4. **Cascade delete with guards** — `delete()` throws
   `ScheduleEnabledError` if `enabled === true`, and
   `ScheduleHasInFlightError` if a dispatched task is still running.
   Otherwise it cancels the timer, removes every TERMINAL task the
   schedule has ever fired (those rows would be unreachable once the
   trigger is gone — there is no UI path to a task whose schedule no
   longer exists), then drops the schedule row. In-flight tasks are
   protected by the pre-flight 409 *and* by the terminal-only filter
   inside the cascade — they are never touched. A second
   `hasInFlightForSchedule` check runs after the cascade so a racing
   manual `run()` between the original check and the cascade cannot
   leave us with an orphan running task pointing to a dead schedule
   (the call refuses with `ScheduleHasInFlightError`; the user can
   retry once the racing task completes). Returns `{ deletedTaskCount
   }` so callers can surface the cascade count (CLI suffix, audit
   log).
5. **Manual `run()` bypasses `enabled`** — manual fires are
   user-initiated and ignore the concurrency check.
6. **Patch never affects in-flight tasks** — only the trigger / arm
   state is recomputed; dispatched tasks continue under
   `@emploke/task`'s lifecycle.

## Data model

`target.kind === "task"` carries `agent`, `brief` (single line, ≤ 200
chars, validated entity-side and route-side), optional `details`
(any string, including `""` — mirrors `@emploke/task`'s lax shape),
and optional `runtime`. There is no longer a denormalised
`target_agent` column on the `schedules` table.

**Indexes.** `schedules_target_agent_idx` is a **functional partial
index** on `json_extract(target_json, '$.agent')` filtered
`WHERE target_kind = 'task'`. SQLite has supported JSON-extract in
index expressions for years and `@emploke/task` already uses the
same pattern (`tasks_schedule_id_idx`). Drizzle-kit cannot declare
expression indexes in the TypeScript schema, so this index lives in
a hand-written `drizzle/0001_drop_target_agent_add_json_index.sql`.
Queries that engage it must use the raw `` sql`json_extract(...)` ``
template — the Drizzle typed query builder does not generate the
index-engaging form. The `list({ agent })` repository method pushes
both `eq(targetKind, "task")` and the json_extract equality so the
partial index lights up; without the `target_kind` predicate SQLite
falls back to a full scan.

## Wiring

`composeScheduleModule({ dbFile, taskDispatcher, agentValidator })` is
the only production composition path:

- `taskDispatcher` — any object satisfying the `TaskDispatcher`
  interface. `@emploke/core` adapts `@emploke/task`'s
  `TaskService.dispatch(opts)` + `TaskService.hasInFlightForSchedule(id)`
  structurally; this package never imports `@emploke/task` directly.
- `agentValidator(fqn)` — async predicate; resolves on success,
  rejects on missing agent. Bound to `CatalogService` in production.
- Optional `now` / `randomUUID` are deterministic-test seams.

## HTTP mutation contract

Mutations are **URL-discriminated by `target.kind`** so each route has an
honest, kind-specific contract. Reads / delete / run / preview stay
polymorphic (one resource view across kinds).

| Operation                 | Route                                                | Body                          |
|---------------------------|------------------------------------------------------|-------------------------------|
| Create task schedule      | `POST   /api/workspaces/:id/schedules/task`          | `TaskScheduleCreateBody`      |
| Patch task schedule       | `PATCH  /api/workspaces/:id/schedules/task/:sid`     | `TaskSchedulePatchBody`       |
| List / get / delete / run / preview | `GET / DELETE / POST /api/workspaces/:id/schedules[/:sid][/run\|/preview]` | polymorphic |

When `target.kind = "workflow"` lands, it adds `POST /schedules/workflow`
+ `PATCH /schedules/workflow/:sid` + matching service methods. Polymorphic
reads do not need re-plumbing.

### `POST /schedules/task` body

```ts
interface TaskScheduleCreateBody {
  name: string;
  enabled?: boolean;                              // default true
  trigger: { kind: "cron"; expr: string; tz: string };
  target: {                                       // no `kind` — URL implies it
    agent: string;
    brief: string;
    details?: string;
    runtime?: string;
  };
}
```

The route rejects `target.kind` (URL is authoritative), unknown nested
keys, and empty/null `agent`/`brief`. The service injects
`kind: "task"` before persistence.

### `PATCH /schedules/task/:sid` body — RFC 7396 deep-merge for `target`

```ts
interface TaskSchedulePatchBody {
  name?: string;                                  // shallow set
  enabled?: boolean;                              // shallow set
  trigger?: { kind: "cron"; expr: string; tz: string }; // wholesale replace
  target?: {
    agent?: string;                               // set; null rejected (required field)
    brief?: string;                               // set; null rejected (required field)
    details?: string | null;                      // string sets; null deletes
    runtime?: string | null;                      // string sets; null deletes
  };
}
```

Semantics:

- **`name` / `enabled`** — shallow set; absent means keep.
- **`trigger`** — atomic shape (3 fields). If present, replace wholesale
  and re-validate; absent means keep. Partial trigger is rejected (400).
- **`target`** — RFC 7396 (JSON Merge Patch) deep merge. Each present key
  is merged into the existing target:
  - `agent` / `brief` — set; `null` is **rejected** (these are required
    entity invariants).
  - `details` / `runtime` — `string` sets, **`null` deletes the key**,
    `undefined` (absent) keeps the existing value.
- **404 envelope** — if `:sid` exists but its current `target.kind !==
  "task"`, the route returns `ScheduleNotFoundError` (no
  kind-information leak; from the task-route's perspective the resource
  is absent).
- **Single `updatedAt` stamp** — the three composed entity steps share
  one `now` so a multi-field patch does not skew timestamps.

The "wholesale-trigger" carve-out is intentional: `trigger` is small and
its fields are interdependent (a cron expr only makes sense paired with
its tz), so partial merges hide validation bugs.

### CLI surface (`emploke schedule patch`)

`schedule patch` issues a **single PATCH** for everything except partial
trigger updates — when only `--cron` or only `--tz` is given the CLI
first GETs the existing trigger to fill the missing field, because
trigger is wholesale-replace.

- `--name`, `--enabled` / `--no-enabled` — scalar set.
- `--agent`, `--brief`, `--details`, `--runtime` — sparse `target` patch
  in a single PATCH (server deep-merges).
- `--clear-details`, `--clear-runtime` — ship `null` on the wire (delete
  the optional field).
- `--details ""` is treated as omitted (CLI norm; matches `pickString`
  in `@emploke/task`). Empty-string set is only reachable through the
  direct HTTP API.
