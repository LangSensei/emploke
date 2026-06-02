# @emploke/schedule

Cron-triggered substrate. Owns one table — `schedules` — plus the
`ScheduleService` surface (reads + writes + `recover()` +
`shutdown()` + `preview()` + `run()`) AND an OPEN registry of
per-kind handlers.

The pkg has **no built-in knowledge of any concrete kind**. Callers
register handlers at compose time, BullMQ / Sidekiq / Temporal-style:

```ts
const scheduleModule = await composeScheduleModule({ dbFile });
scheduleModule.service.registerKind(
  "task",
  makeTaskKindHandler({ tasks, catalog }),
);
// future: scheduleModule.service.registerKind("workflow", makeWorkflowKindHandler({ workflows }));
await scheduleModule.service.recover(); // freezes the registry; MUST come AFTER all registerKind
```

Adding a new kind requires **zero edits** to `packages/schedule/src/`.
Only:

1. Define a `ScheduleKindHandler` somewhere the kind's deps live
   (typically `packages/api/src/wiring/`).
2. Call `service.registerKind("<kind>", handler)` before
   `service.recover()`.
3. (For server-exposed kinds) add per-kind URL routes + wire DTOs in
   `@emploke/api` + (optionally) a partial JSON index migration
   in this pkg.

## Substrate ⇄ handler split

The schedule pkg owns the substrate concerns:

- the `schedules` table + Drizzle migrations
- envelope storage (`target_kind` column + `target_json` blob)
- the croner-driven timer chain (`armNext` / `fire`)
- `recover()` (catchup-once at boot) and `shutdown()`
- kind-agnostic invariants on `name`, `trigger`, and the JSON-path
  grammar for `dataEquals` list filters

The registered `ScheduleKindHandler` owns the per-kind concerns:

- payload shape validation (`validate(data, { changedKeys? })`)
- RFC 7396 deep-merge (`mergePatch(existing, patch) → { data, changedKeys }`)
- fire dispatch (`dispatch({ scheduleId, firedAt, data })`)
- in-flight check + cascade delete (`hasInFlightForSchedule` /
  `deleteForSchedule`)

The handler interface is intentionally non-generic — `data: unknown`
all the way through. Per-kind type safety lives at the EDGES (route
handlers narrow before calling `service.create`; handlers cast after
their own `validate` produces a value). A `ScheduleKindHandler<TData>`
generic would force every consumer to track the kind→T mapping at
compile time, which is exactly the closed-registry shape this design
supersedes.

## Layout

```
packages/schedule/
├── drizzle.config.ts
├── package.json
├── README.md
├── tsconfig.json
├── tsconfig.test.json       Test-scope typecheck (includes test/**/*, noEmit)
├── vitest.config.ts
├── drizzle/0000_*.sql       Drizzle-kit generated migration (committed)
├── drizzle/0001_*.sql       Hand-written: drops target_agent + adds
│                            functional partial JSON-extract index
└── src/
    ├── _helpers.ts           kind-name / JSON-path / name / trigger validators
    ├── compose.ts            composeScheduleModule({ dbFile | db, logger, now, randomUUID })
    ├── cron.ts               croner + cronstrue wrapper (validate / nextRuns / describe)
    ├── cronstrue-i18n.d.ts   Ambient decl for `cronstrue/i18n.js` (no `exports` field upstream)
    ├── errors.ts             ScheduleError + 11 named subclasses
    ├── index.ts              public barrel
    ├── migrations.ts         AUTO-GENERATED inlined SQL
    ├── schedule-entity.ts    ScheduleEntity (kind-agnostic envelope container)
    ├── schedule-repository.ts Drizzle CRUD + preflight (private)
    ├── schedule-service.ts   ScheduleService + open kind registry
    ├── schema.ts             Drizzle table definition (private)
    ├── testing.ts            openTestScheduleDb() in-memory test helper
    ├── types.ts              Schedule, ScheduleKindHandler, envelope, list opts
    └── validate.ts           SCHEDULE_ID_RE + generateScheduleId
```

## Invariants

1. **Cron dialect** — 5-field POSIX only. 6-field expressions are
   rejected with `InvalidCronExprError` carrying the literal phrase
   `"6-field cron not supported in v1"`.
2. **Concurrency = 1** — if `handler.hasInFlightForSchedule(id)`
   returns `true` at fire time, the tick is skipped (warn-logged) and
   re-armed without writing `last_fired_at`.
3. **Catchup-once** — `recover()` collapses every missed fire into a
   single catchup dispatch with `firedAt` set to the planned (past)
   time, not `now`.
4. **Cascade delete with guards** — `delete()` throws
   `ScheduleEnabledError` if `enabled === true`, and
   `ScheduleHasInFlightError` if the handler reports in-flight work.
   Otherwise it cancels the timer, calls `handler.deleteForSchedule`
   (the handler MUST filter to terminal status only), re-checks
   in-flight, then drops the schedule row. Returns
   `{ deletedDispatchCount }` so callers can surface the cascade
   count.
5. **Manual `run()` bypasses `enabled`** — manual fires are
   user-initiated and ignore the concurrency check. Returns
   `{ dispatchId }`.
6. **Patch never affects in-flight dispatches** — only the trigger /
   arm state is recomputed when `trigger` or `enabled` changed;
   already-dispatched units continue under their handler's
   lifecycle.
7. **Registry freezes on first `recover()`** — `registerKind` after
   freeze throws `ScheduleKindRegistryFrozenError`. `recover()`
   itself preflights every row (enabled AND disabled) and throws
   `ScheduleKindNotRegisteredError` for any row whose `target_kind`
   has no handler.
8. **Persisted data is trusted on read** — `repo.read` / `repo.list`
   produce envelopes with `data: unknown` from
   `JSON.parse(target_json)`. The pkg does NOT invoke
   `handler.validate` on every read (it would require a catalog
   round-trip per row in the list endpoint, and the row was already
   validated at create / patch time). Handlers that want
   belt-and-braces re-checks on dispatch can do so inside
   `handler.dispatch`.

## Data model

`schedules` stores the envelope across two columns:

- `target_kind TEXT NOT NULL` — the registered kind name.
- `target_json TEXT NOT NULL` — `JSON.stringify(envelope.data)`. The
  `kind` is **not** redundantly nested inside `target_json` (that
  would let the column disagree with the JSON, and would force every
  read to pay for a redundant parse).

Legacy rows that pre-date the `kind`-in-column convention may have a
redundant `kind` field inside `target_json`. The substrate reads them
transparently; handlers whose `mergePatch` reconstructs the typed
shape (the production task handler does) implicitly drop the field on
the first patch. Handlers that follow a shallow-merge pattern must
explicitly delete the key.

**Indexes.** `schedules_target_agent_idx` is a **functional partial
index** on `json_extract(target_json, '$.agent')` filtered
`WHERE target_kind = 'task'`. It's task-kind-specific (the task
handler stores `agent` in `data.agent`) and stays in the schema for
the list-by-agent query. Future kinds add their own partial-index
migrations when they need them. The repository's generic
`list({ kind, dataEquals })` engages this index automatically when
called with `{ kind: "task", dataEquals: { path: "$.agent", value }}`;
without BOTH predicates SQLite's planner can't prove the partial
predicate and falls back to a scan.

## Composition

```ts
const scheduleModule = await composeScheduleModule({
  dbFile: path.join(workspaceDir, "workspace.db"),
  logger,
});
scheduleModule.service.registerKind(
  "task",
  makeTaskKindHandler({ tasks: taskModule.service, catalog: catalogModule.service }),
);
await taskModule.service.recoverOrphaned();
await scheduleModule.service.recover();
```

Order matters: every kind must be registered BEFORE `recover()` runs,
otherwise the preflight throws. Tests can call `recover()` with no
rows in the DB — preflight returns immediately and freezes the
registry.

## HTTP mutation contract

Mutations stay URL-discriminated by `target.kind` so each route has an
honest, kind-specific contract. Reads / delete / run / preview are
polymorphic (one resource view across kinds).

| Operation                  | Route                                                   | Body                       |
| -------------------------- | ------------------------------------------------------- | -------------------------- |
| Create task schedule       | `POST   /api/workspaces/:id/schedules/task`             | `TaskScheduleCreateBody`   |
| Patch task schedule        | `PATCH  /api/workspaces/:id/schedules/task/:sid`        | `TaskSchedulePatchBody`    |
| List / get / delete / run / preview | `GET / DELETE / POST /api/workspaces/:id/schedules[/:sid][/run|/preview]` | polymorphic |

The wire shape for `target` on responses is **flat** for the task
kind (`{ kind: "task", agent, brief, details?, runtime? }`) — the
server route's `projectScheduleToWire` helper converts the internal
envelope `{ kind: "task", data: { agent, ... } }` to flat wire on
the way out. Dashboard / CLI consumers continue to read
`schedule.target.agent` etc.

### `POST /schedules/task` body

```ts
interface TaskScheduleCreateBody {
  name: string;
  enabled?: boolean; // default true
  trigger: { kind: "cron"; expr: string; tz: string };
  target: {
    // no `kind` — URL implies it
    agent: string;
    brief: string;
    details?: string;
    runtime?: string;
  };
}
```

The route validates the wire shape via `validateTaskTargetData`,
then calls `service.create({ name, trigger, target: { kind: "task", data: validated }, enabled })`.
The task handler's `validate` re-runs the shape check + the async
catalog existence lookup.

### `PATCH /schedules/task/:sid` body

```ts
interface TaskSchedulePatchBody {
  name?: string;
  enabled?: boolean;
  trigger?: { kind: "cron"; expr: string; tz: string }; // wholesale replace
  target?: {
    agent?: string;
    brief?: string;
    details?: string | null; // null deletes
    runtime?: string | null; // null deletes
  };
}
```

The route validates the wire patch shape, then calls
`service.patch(sid, { ..., expectedKind: "task", target: { patch: validated }})`.
The service:

1. Loads the entity, throws `ScheduleKindMismatchError` if its
   `target.kind` differs from `expectedKind` (route projects to 404).
2. Calls `handler.mergePatch(existing.data, patch)` → `{ data, changedKeys }`.
3. Calls `handler.validate(data, { changedKeys })` — the handler may
   skip catalog lookup when `agent` wasn't in `changedKeys`.

### Cascade-delete response

```ts
interface ScheduleDeleteResponse {
  ok: true;
  deletedDispatchCount: number;
}
```

`deletedDispatchCount` is the number of historical units-of-work
(typically tasks) removed by the handler's cascade.

### Manual run response

```ts
interface ScheduleRunResponse {
  dispatchId: string;
}
```

`dispatchId` is the handler's substrate-side id (task id, workflow
run id, …).
