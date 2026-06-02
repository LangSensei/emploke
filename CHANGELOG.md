# Changelog

All notable changes to emploke land here. The project is pre-1.0;
breaking changes ship without semver-major bumps.

## Unreleased

### Breaking

#### task + session: structural decoupling from @emploke/catalog via AgentResolverPort

`@emploke/task` and `@emploke/session` no longer import from
`@emploke/catalog`. Both services now accept structural ports
(`AgentResolverPort`, `AgentContentSource`) at compose time;
`@emploke/catalog`'s `CatalogService` satisfies them via structural
typing, so the composition root in `@emploke/core` continues to pass
the catalog instance through as-is — no adapter layer.

- `@emploke/task`:
  - `composeTaskModule` option `catalog: CatalogService` REMOVED;
    replaced by `agentResolver: AgentResolverPort` AND
    `contentSource: AgentContentSource`. `TaskServiceConfig` /
    `TaskServiceCtx` change in the same shape.
  - `BlockedReason`, `MissingDep`, `BlockedDep`, `AgentEntry`,
    `AgentResolverPort` are now defined in
    `packages/task/src/ports.ts` and re-exported from the public
    surface. The runtime value flowing through
    `EntryNotReadyError.reason` is byte-identical; consumers can
    import `BlockedReason` from either `@emploke/task` or
    `@emploke/catalog` (the two are structurally compatible).
  - `@emploke/catalog` removed from `dependencies`.
- `@emploke/session`:
  - `composeSessionModule` option `catalog: CatalogService` REMOVED;
    same `agentResolver` + `contentSource` shape as task.
    `SessionServiceConfig` follows.
  - `create()` discriminates "agent not found" via `null` return
    from `agentResolver.getAgentEntry(...)` (Option II). The old
    `instanceof CatalogAgentNotFoundError` branch is gone. Any
    failure of `resolveAgent(...)` is classified as
    `AgentResolutionFailedError` (500). TOCTOU note: an agent that
    disappears between the two calls surfaces as 500 rather than
    400 — accepted as vanishingly rare in practice.
  - `@emploke/catalog` removed from `dependencies`.
- `@emploke/runtime`: now re-exports the structural type aliases
  `AgentContentSource` and `ResolvedAgent` from its public surface
  so downstream packages (task, session) can name them without a
  catalog import. Runtime behaviour unchanged.
- Cross-pkg audit (`packages/task/test/inter-service-imports.test.ts`)
  gained a stricter assertion: every TS/TSX file under
  `packages/task/src/**` and `packages/session/src/**` must
  reference `@emploke/catalog` ZERO times — including type-only
  imports, re-exports, and `import("@emploke/catalog")` type nodes.
  Regression-prevention for accidental re-introductions.

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
