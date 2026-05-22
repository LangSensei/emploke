## Unreleased

## 0.5.2  2026-05-22

### Changed (BREAKING  schema)

- `__drizzle_migrations` bookkeeping table now uses drizzle's
  **official schema** (`id SERIAL, hash TEXT, created_at NUMERIC`)
  instead of the previous home-rolled `id INTEGER, name TEXT, applied_at TEXT`.
  Migration application now goes through drizzle's official
  `SQLiteSyncDialect.migrate` applier (hash-keyed, statement-breakpoint
  splitting, monotonic `folderMillis` ordering). Customer-facing
  upgrade guide at [#150](https://github.com/LangSensei/emploke/issues/150) 
  TL;DR: `emploke stop`; wipe `global.db` + every `workspace.db`;
  `emploke start`; re-register workspaces.

### Added

- `apply<Entity>Migrations(db)` helper per entity pkg 
  thin typed shim over drizzle's `@internal` `dialect.migrate`,
  encapsulates the cast in one place.
- `migrations-inventory` test in every entity pkg + `_template`,
  fails immediately when `drizzle/*.sql` and `src/migrations.ts`
  drift apart.
- CI **Schema/migration drift** step  runs `pnpm db:generate` against
  `schema.ts` and fails the build if the working tree becomes dirty
  (catches forgotten regeneration).

### Removed

- `scripts/inline-migrations.mjs` (codegen step)  replaced by
  hand-written `src/migrations.ts` per pkg using Vite's `?raw`
  imports + a small esbuild plugin (`rawSuffixPlugin`) that mirrors
  Vite's behaviour at bundle time.
- Per-pkg `runPendingMigrations` hand-rolled migrator (~100 lines
  total). All four pkgs now delegate to drizzle's official applier.

### Internal

- `esbuild.config.js` gains a tiny `rawSuffixPlugin` (~15 lines)
  that resolves `import x from "./foo.sql?raw"` to inlined file
  contents. Standard Vite `?raw` syntax, so the same source works
  unchanged in vitest (which uses Vite natively).
# Changelog

## Unreleased

## 0.5.1 — 2026-05-22

### Fixed

- **`emploke start` failed on 0.5.0 with `Could not locate the bindings file`** for `better-sqlite3`. The single-file CLI bundle inlined the JS shim of the native module, breaking its filesystem-walk for the `.node` binding. `better-sqlite3` + its `bindings` resolver are now marked `external` in `esbuild.config.js` and declared as runtime `dependencies` of `@langsensei/emploke` so `npm install -g` materialises the prebuilt binary into the user's `node_modules` tree where the loader can find it. No code change — repackaging only. ([#152](https://github.com/LangSensei/emploke/issues/152))

## 0.5.0 — 2026-05-22

### Phase 3 (#148) — de-DDD pivot + `@emploke/core` extraction + Drizzle migration

The Phase 2 MikroORM pivot was rolled back. Every entity pkg is now a
plain `<Entity>Service` class over a per-pkg Drizzle repository; the
DDD/CQRS ceremony (aggregate factories, value objects, Inversify
container, mediatr-ts pipeline behaviours, custom MigrationCoordinator,
domain-event dispatcher) is gone. The accumulated indirection was
costing real velocity and the Codex Rust CLI's "core crate composes
focused leaf crates" shape turned out to be a closer analogue to
ours than the eShop reference we'd been imitating.

#### Added

- **`@emploke/core`** — composition root that wires the global
  workspace registry to per-workspace `{catalog, sessions, tasks}`
  bundles behind a `WorkspaceRuntimeCache`. Exposes the canonical
  cross-BC orchestration methods (`registerWorkspace`,
  `renameWorkspace`, `unregisterWorkspace`, `reloadWorkspace`) plus
  `WorkspaceRuntime.spawnSession` so transport layers become thin
  adapters. Server bootstrap collapses to a 1-line wrapper.
- **Drizzle migration toolchain** in every entity pkg
  (`@emploke/workspace`, `@emploke/catalog`, `@emploke/session`,
  `@emploke/task`): drizzle-kit codegen against `schema.ts`, plus a
  small in-pkg migrator at compose time that records applied files in
  `__drizzle_migrations`.
- **Stripe-style hybrid param style** for every service write:
  primary key positional, options in a bag
  (`service.delete(id, { purge })`, `service.rename(id, { newName })`,
  etc.). Single create-bag where there is no canonical positional key
  (`service.register({ id, workspaceDir, name })`). See
  `docs/architecture.md` and `docs/pkg-template.md`.
- **Subprocess env split** (`@emploke/server/subprocess-env.ts`):
  `buildSubprocessEnvBase` returns string-only positive declarations;
  `SUBPROCESS_ENV_SCRUB_KEYS` is the separate negative list of
  "delete from inherited env" keys, honoured only by the headless
  launch path (interactive shells can't unset, so mixing the two
  semantics in one bag was a latent crash  see Fixed below).
- **`packages/_template/`** — scaffold for new entity pkgs codifying
  the post-refactor conventions (bare-noun DTOs in `types.ts`,
  single `<Entity>Service` per BC, `<entity>-<role>.ts` naming for
  class-bearing files, vitest `forks` pool, drizzle-kit wiring).

#### Changed (BREAKING)

- Persistence: every entity pkg moved from MikroORM to Drizzle.
  Schemas live in `schema.ts`; repos call drizzle directly; the
  `__drizzle_migrations` table is the new applied-files journal.
  Existing `workspace.db` files are incompatible with the new layout
   production deployments must delete `<workspaceDir>/workspace.db`
  and let the server recreate it on first request (no in-place
  migration path; we are pre-1.0).
- `Manager`  `Service` rename across every entity pkg:
  `WorkspaceManager`  `WorkspaceService`,
  `CatalogManager`  `CatalogService`,
  `SessionManager`  `SessionService`,
  `TaskManager`  `TaskService`. Constructors take a Drizzle handle
  + minimal dependencies; the old DDD `compose<Entity>Module` shape
  remains as the public composition seam but its options bag shrank
  from 9  6 params (env layering moved into `CopilotRuntime` config).
- DTO naming: bare nouns (`Workspace`, `Agent`, `Session`, `Task`,
  `Skill`, `Mcp`) for the public projection; `*Row` for the Drizzle
  internal type (never exported beyond the repo); `*Entry` for list
  items with computed status; `*Entity` (when present) for the
  package-private state-machine class.
- Copilot CLI: `--resume=<id>` replaced by `--session-id=<id>` 
  upstream broke `--resume` to no longer create the session at the
  given id. `buildCopilotLaunchCommand` emits the new flag; pkg
  targets Copilot CLI  1.0.45.
- Runtime pkg layout: `registry.ts`  `runtime-registry.ts`;
  `copilot/copilot.ts`  `copilot-runtime.ts`; `copilot/launch.ts` 
  `copilot/interactive-launch.ts` (paired with `launch-headless.ts`);
  `copilot/module.ts` deleted (dead).
- Test files mirror src layout: `manager.test.ts` 
  `<entity>-service.test.ts`, `cancel-*.test.ts` 
  `<entity>-service.cancel-*.test.ts`, etc.
- Workspace pkg removed `MIGRATIONS.md` and the legacy
  `MigrationCoordinator` infra (custom topo-sort + per-pkg
  `MIGRATIONS` arrays + `SchemaMeta*` errors). drizzle-kit owns the
  migration story now.

#### Fixed

- Windows terminal spawn crash "Cannot read properties of undefined
  (reading 'replace')" when the runtime emitted
  `LaunchCommand.env.EMPLOKE_HOME = undefined`. Root cause was the
  base-bag/scrub-list semantic mix above; fix split them at the
  source. `terminal/_shared.ts` `shExportPrefix` / `pwshEnvPrefix`
  also gained defence-in-depth filters that skip non-string values.
- `EmplokeCore.close()` was relying on callers to `cache.closeAll()`
  first; now it does so internally, top-down disposal style.
- `WorkspaceRuntimeCache.reload()` now drains in-flight `get()`
  loads before closing the cached entry, eliminating a race where a
  concurrent load could re-populate the cache with a stale entry
  past the close.
- Server graceful shutdown was calling `cache.closeAll()` without
  `await`, racing the subsequent `composition.close()` for the
  `global.db` handle.
- Workspace `register` now translates SQLite `SQLITE_CONSTRAINT*`
  errors back into typed `WorkspaceIdConflictError` /
  `WorkspacePathConflictError` instead of leaking the raw driver
  error past the racy pre-flight checks.

#### Removed

- `inversify`, `mediatr-ts`, `reflect-metadata` from every pkg.
- `@mikro-orm/*` from every pkg (workspace, session, task, catalog,
  server, repo root).
- `@emploke/workspace`'s legacy migration framework
  (`MigrationCoordinator` + `runPkgMigrations` + `SchemaMeta*`
  errors + per-pkg `MIGRATIONS` arrays + the 12-test legacy suite).
- Per-entity `Sqlite{Agent,Skill,Mcp,Session,Task}Repository`
  classes  replaced by Drizzle-backed equivalents kept
  package-private.
- The DDD aggregate root / value object / Inversify container
  scaffolding in `@emploke/workspace`. `Workspace` is now a flat DTO
  derived from `schema.$inferSelect`.
- `@emploke/paths`, `@emploke/fs`, `@emploke/logger`,
  `@emploke/catalog-fetcher`  merged into the pkgs that consumed
  them. The atomic-IO seam consumers now reach for `write-file-atomic`
  directly; pure path helpers live next to the schemas that use them.

## Older history (pre-Phase 3)
### Changed (BREAKING)

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

