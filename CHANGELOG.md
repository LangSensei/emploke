# Changelog

## Unreleased

### Phase 2 of #135 / ADR-3 (#139) — MikroORM pivot

#### Added

- `@mikro-orm/core` + `@mikro-orm/better-sqlite` deps in `@emploke/workspace`;
  `@mikro-orm/core` + `@mikro-orm/migrations` + `@mikro-orm/better-sqlite` in
  `@emploke/server`; `@mikro-orm/cli` + `@mikro-orm/migrations` +
  `@mikro-orm/core` devDeps at the repo root.
- `AggregateRoot` base class (`packages/workspace/src/domain/aggregate-root.ts`)
  — accumulates `pullDomainEvents()`-style domain events for any aggregate
  in workspace pkg. `instanceof AggregateRoot` is the runtime discriminator
  the `DomainEventSubscriber` uses to walk MikroORM change-sets.
- `DomainEventSubscriber`
  (`packages/workspace/src/infrastructure/domain-event-subscriber.ts`) —
  `EventSubscriber` for MikroORM's `afterFlush` hook; pulls each tracked
  aggregate's buffered events and dispatches them through `mediator.publish`.
  Registered with the global ORM in `buildServerContainer` so every command's
  flush fires it automatically.
- `TransactionBehavior`
  (`packages/server/src/infrastructure/transaction-behavior.ts`) —
  cross-cutting mediatr-ts pipeline behaviour that wraps every
  `mediator.send(...)` call in `em.transactional(async () => next())`.
  Drives `em.flush()` (and therefore `DomainEventSubscriber`) at the end of
  every command handler with rollback semantics on throw.
- `mikro-orm.config.ts` + `migrations/Migration00000000000000_initial.ts`
  in `packages/workspace/` — initial schema-from-entity migration
  (workspaces + global_state tables). `pnpm orm:migration:create` /
  `orm:migration:up` / `orm:schema:fresh` scripts wired.
- `WORKSPACE_ENTITIES` — exported entity list for
  `MikroORM.init({ entities: WORKSPACE_ENTITIES })` so the composition root
  stays agnostic of the package's internal entity layout.
- `MikroWorkspaceRepository` + `MikroWorkspaceQueries` — new infra that
  replaces the deleted SQLite + raw-query repositories.
- `openTestWorkspaceOrm()` helper in `@emploke/workspace/testing` —
  opens an in-memory MikroORM + creates schema + creates the
  `global_state` raw-SQL table. Used by every workspace + server test
  that needs a `global.db`-equivalent fixture.

#### Changed (BREAKING)

- `@emploke/workspace` public API surface
  — `WorkspaceDb` (DI token for the `DatabaseSync` handle) **removed**; the
  canonical persistence handle is now `EntityManager` from
  `@mikro-orm/core`.
- `WorkspaceRepository` abstract class trimmed to `findById`, `delete`,
  `getCurrent`, `setCurrent`. `save`, `create`, `list`, `close` removed —
  `em.flush()` handles persistence; `WorkspaceQueries.list()` covers the
  read side; the per-process ORM owns connection lifecycle.
- `Workspace` aggregate fields are now primitives (`id: string`,
  `name: string`, `workspaceDir: string`, `createdAt: string`) to match
  MikroORM's column mapping. Callers reading `ws.id.value` migrate to
  `ws.id`. Static `register` / `fromStored` factories still take value
  objects at the constructor boundary; validation lives in the VO
  factories as before.
- Command handlers shed `repo.save` + `pullDomainEvents` + per-handler
  publish loops. `RegisterWorkspaceCommandHandler` calls
  `em.persist(ws)` + `em.flush()` (the flush also fires
  `DomainEventSubscriber.afterFlush` automatically); `Rename` /
  `Unregister` mutate tracked entities and let
  `TransactionBehavior`'s `em.transactional` wrapper do the flush.
- `Workspace.{rename,unregister}` short-circuit and `em.flush` is a
  no-op when the change-set is empty, so the "skip BEGIN IMMEDIATE on
  byte-identical rename" optimisation collapses into the unit-of-work
  semantics — no explicit handler-side `if (events.length === 0)`
  guard needed.
- Server `bootstrap.ts` accepts `{ globalOrm: MikroORM }` instead of
  `{ workspaceDb: DatabaseSync }`. `buildServerContainer` binds
  `EntityManager` to `orm.em`, registers `DomainEventSubscriber` with
  the ORM, and the `TransactionBehavior` import side-effect enrolls the
  pipeline behaviour on mediatr-ts's module-level singleton.
- CLI bootstrap binds a sentinel `EntityManager` that throws on first
  resolve (CLI commands talk HTTP to the server; workspace handlers
  are never resolved CLI-side).
- Server tsconfig opts into `experimentalDecorators: true` +
  `emitDecoratorMetadata: true` so `TransactionBehavior` can use
  inversify's `@inject(EntityManager)` parameter decorator.
- Schema simplification: dropped the `registered_at` and `last_opened_at`
  audit columns from the `workspaces` table. They lived outside the
  aggregate's invariant boundary and weren't consumed by any wire surface;
  removing them keeps the Phase-2 entity minimal. The recency UX (if
  ever shipped) lands in Phase 3+ as a proper `@Property`.

#### Removed

- `SqliteWorkspaceRepository`, `SqliteWorkspaceQueries`,
  `workspace-db.ts` (DI token), `infrastructure/internal/row-mappers.ts`,
  `publishWorkspaceEvent` helper — superseded by the MikroORM path
  (`MikroWorkspaceRepository`, `MikroWorkspaceQueries`,
  `EntityManager` DI token, `DomainEventSubscriber`).
- `packages/workspace/src/infrastructure/migrations/` (the v0→v1 /
  v1→v2 per-pkg migration files) — replaced by MikroORM-managed
  migrations under `packages/workspace/migrations/`.
- `WORKSPACE_MIGRATIONS` constant — no longer exported. Workspace
  schema is now generated from the `Workspace` entity by MikroORM.
- `bootstrapWorkspaceRegistryDb` test helper — replaced by
  `openTestWorkspaceOrm()`.

#### Kept (out of scope — Phase 3+ work)

- The cross-package `MigrationCoordinator` / `runPkgMigrations` /
  `Migration` type / `topoSort` framework still ships from
  `@emploke/workspace` because `@emploke/session`, `@emploke/task`,
  `@emploke/catalog`, and the per-workspace `workspace.db` bootstrap
  in `PerWorkspaceContainerCache` all consume it. Phase 3+ migrates
  those pkgs onto MikroORM, at which point the framework deletes.
- Per-workspace `workspace.db` initialisation in `PerWorkspaceContainerCache`
  still uses `runPkgMigrations(...)` with the session/task/catalog
  migration chains — unchanged.
- Session/task/catalog/runtime entities and routes — untouched.

#### Migration note for operators

Existing `<EMPLOKE_HOME>/global.db` files written by the pre-Phase-2
server **must be deleted** before booting the server on the new
build. The pre-ADR schema carried two columns (`registered_at`,
`last_opened_at`) the Phase-2 entity dropped; emploke is pre-1.0 and
does not support auto-migration across the cut. Per-workspace
`workspace.db` files are unchanged (session/task/catalog still on the
custom framework).

### Phase 1 of #135 — workspace pilot DDD + CQRS refactor


- `reflect-metadata` polyfill imported at each entry point
  (`@emploke/server`, `@emploke/cli`) so future `@injectable()` /
  `@inject()` decorators have the metadata API available.
- `tsconfig.base.json` now sets `experimentalDecorators: true` +
  `emitDecoratorMetadata: true`. No existing source file uses
  decorators yet; this is foundation only.
- Per-package `composeXxxModule(container)` stubs added across
  `@emploke/workspace`, `@emploke/session`, `@emploke/task`,
  `@emploke/catalog`, and `@emploke/runtime`. Bodies are intentionally
  empty in Phase 0 — populated by Phase 1+ as bindings (repositories,
  command handlers, notification handlers, …) start moving into the
  composition root.
- `@emploke/server` ships `buildServerContainer()` (root composition
  root for the server process) plus an `InversifyResolver` bridge
  that wires inversify into mediatr-ts's `Resolver` contract.
- `@emploke/cli` ships `buildCliContainer()` with the same shape; the
  CLI's container is short-lived (one container per `emploke` command
  invocation) but the binding surface mirrors the server's so the two
  composition roots stay in lock-step until a divergence is
  motivated.
- Smoke tests in both `packages/server/test/inversify-bootstrap.test.ts`
  and `packages/cli/test/inversify-bootstrap.test.ts` assert the
  container is constructable and that the mediator is reachable via
  `container.get(Mediator)`.

### Changed

- `runServer()` (in `@emploke/server`) and `run()` (in `@emploke/cli`)
  now invoke their respective `build…Container()` at startup. The
  container is built and held but no production code path resolves
  through it yet — existing managers are still constructed by hand.
  Phase 1 of #135 will start migrating individual bindings.
