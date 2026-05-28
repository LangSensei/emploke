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
4. **Hard delete with guards** — `delete()` throws
   `ScheduleEnabledError` if `enabled === true`, and
   `ScheduleHasInFlightError` if a dispatched task is still running.
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
