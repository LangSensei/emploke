# Changelog

All notable changes to emploke land here. The project is pre-1.0;
breaking changes ship without semver-major bumps.

## Unreleased

### Breaking

#### schedule: open registerKind handler registry (substrate ⇄ kind separation)

Replaces the previous task-specific `ScheduleService` surface with an
open, register-at-compose-time handler registry — `@emploke/schedule`
now knows nothing about any concrete kind. Adding a new kind
(`workflow`, `webhook`, …) requires zero edits to
`packages/schedule/src/`; the caller defines a `ScheduleKindHandler`
in their wiring layer and calls `service.registerKind(kind, handler)`
before `service.recover()`.

- `ScheduleService.registerKind(kind, handler): void` — new. Throws
  `ScheduleKindAlreadyRegisteredError` on duplicate registration;
  throws `ScheduleKindRegistryFrozenError` if called after
  `recover()`. Must run BEFORE `recover()` for every kind whose rows
  exist in the DB (preflight catches missing handlers).
- `ScheduleService.create(args)` — replaces `createTask`. Takes
  `{ name, trigger, target: { kind, data: unknown }, enabled? }`.
- `ScheduleService.patch(id, args)` — replaces `patchTask`. New
  `args.expectedKind` field for kind-discriminated routes (throws
  `ScheduleKindMismatchError` on disagreement — server projects to
  404).
- `ScheduleService.delete(id)` now returns
  `{ readonly deletedDispatchCount: number }` (was `deletedTaskCount`).
- `ScheduleService.run(id)` now returns
  `{ readonly dispatchId: string }` (was `{ taskId: string }`).
- `ScheduleService.list({ kind?, dataEquals?, enabled? })` — generic
  filter shape. `dataEquals.path` is validated against
  `^\$(\.[a-zA-Z_][a-zA-Z0-9_]*)+$` to prevent SQL injection in the
  JSON-extract fragment. Replaces the kind-specific `agent?` filter.
- `composeScheduleModule(opts)` — removed `taskDispatcher` and
  `agentValidator` options; takes only `{ db | dbFile, logger?,
  now?, randomUUID? }`. Wiring moves to caller-side
  `service.registerKind`.
- Wire response keys renamed accordingly:
  - `ScheduleDeleteResponse.deletedTaskCount` →
    `deletedDispatchCount`.
  - `POST /schedules/:sid/run` body `{ taskId }` → `{ dispatchId }`.
- Wire request/response shape for `target` on task schedules stays
  **flat** (`{ kind: "task", agent, brief, details?, runtime? }`) —
  dashboard / CLI consumers do not change target reads. The server's
  new `projectScheduleToWire` helper converts the internal envelope
  to the flat wire on the way out.
- `TaskTargetData` / `TaskTargetPatch` moved from
  `@emploke/schedule` to `@emploke/api-types` (the schedule pkg no
  longer owns task-specific wire types).
- `AgentNotFoundError` / `AgentResolutionFailedError` removed from
  `@emploke/schedule`'s public surface — the task handler in
  `core/src/wiring/schedule-task-handler.ts` throws task-pkg's
  classes directly. The server's `schedulesErrorPolicy` collapses
  the duplicate policy rows.
- New error classes on `@emploke/schedule`:
  `ScheduleKindAlreadyRegisteredError`,
  `ScheduleKindNotRegisteredError`,
  `ScheduleKindRegistryFrozenError`, `InvalidJsonPathError`.
- Kept: `ScheduleKindMismatchError` (now thrown by `patch` via
  `expectedKind`).

No DB migration is required — `schedules.target_json` already stored
the kind-specific payload; `target_kind` already carried the
discriminator. The on-disk shape change is that `target_json` no
longer redundantly nests `kind` inside the JSON (it lives in its own
column).
