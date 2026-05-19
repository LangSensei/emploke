# Schema migrations

> Forward-only DB-level coordinator with per-pkg migration files.
> Lives in `@emploke/workspace` (issue #123, Phase 0).

This doc is for contributors adding or maintaining schema migrations
across the emploke entity packages (`task`, `session`,
`catalog_agent`, `catalog_skill`, `catalog_mcp`, `workspace`, future
`workflow`). End-user docs live in the root `README.md`.

## Mental model

emploke uses a single per-workspace SQLite database
(`<workspace>/workspace.db`) plus a global registry database
(`<EMPLOKE_HOME>/global.db`). Each entity pkg owns one slice of one
of those DBs and tracks its own schema version in a shared
`schema_meta` table:

```text
schema_meta
┌──────────────────┬─────────┐
│ pkg              │ version │
├──────────────────┼─────────┤
│ workspace        │ 2       │   (global.db)
│ task             │ 3       │   (workspace.db)
│ session          │ 1       │   (workspace.db)
│ catalog_agent    │ 1       │   (workspace.db)
│ catalog_skill    │ 1       │   (workspace.db)
│ catalog_mcp      │ 1       │   (workspace.db)
└──────────────────┴─────────┘
```

The framework is **forward-only** — there is no `down()` step.
Downgrade is out of scope; if you need to go back, restore from
backup and rerun.

## Lifecycle at server startup

```text
server.start()
  │
  ▼
open global.db
  │
  ▼
MigrationCoordinator.run(globalDb, [workspace])
  │
  ▼
construct SqliteWorkspaceRepository
  ↳ ensureSchema() asserts schema_meta(workspace) is at HEAD
  │
  ▼
on first workspace request:
  │
  ▼
open workspace.db
  │
  ▼
MigrationCoordinator.run(workspaceDb, [task, session, catalog_*])
  │
  ▼
construct CatalogManager / SessionManager / TaskManager
  ↳ each repo's ensureSchema() asserts its schema_meta row
  │
  ▼
ready
```

Two key invariants:

1. **The coordinator runs BEFORE any repository is constructed.** A
   repository whose pkg has no `schema_meta` row throws
   `RegistryNotBootstrappedError` (or its pkg equivalent) so a
   missing coordinator wire-up is loud at startup, never silent
   corruption.
2. **Every pkg's migrations across one DB run in a single
   transaction.** `BEGIN IMMEDIATE` wraps the whole batch with
   `PRAGMA foreign_keys = OFF` so the cross-pkg FK graph can be
   established without intermediate violations; an explicit
   `PRAGMA foreign_key_check` runs after each migration to catch
   any actually-dangling reference. A failure rolls back the entire
   batch — partial migration is impossible.

## File layout

```text
packages/workspace/src/migration/
├── types.ts              ← Migration interface + MigrationRunResult
├── coordinator.ts        ← MigrationCoordinator class
├── topo-sort.ts          ← Kahn's algorithm + cycle detection
├── errors.ts             ← typed error classes
├── run-pkg-migrations.ts ← convenience async runner
└── index.ts              ← public exports

packages/<pkg>/src/migrations/
├── v0-to-v1.ts           ← initial schema (CREATE TABLE …)
├── v1-to-v2.ts           ← (optional) next step
├── …
└── index.ts              ← export const <PKG>_MIGRATIONS = [v0v1, v1v2, …]
```

## Adding a new migration

### Step 1: write the migration file

Create `packages/<pkg>/src/migrations/v<N>-to-v<N+1>.ts`. Bump by
exactly one step (the coordinator validates this at registration
time).

```ts
import type { Migration } from "@emploke/workspace";

export const v3To4: Migration = {
  pkg: "task",
  fromVersion: 3,
  toVersion: 4,

  // Cross-pkg dependency. Only set when this migration's SQL
  // references a table created by another pkg's migration. The
  // string format is "<pkg>:<toVersion>".
  dependsOn: ["workflow:1"],

  // DDL only. Multiple statements separated by `;` are fine
  // (DatabaseSync.exec handles them). NEVER include BEGIN/COMMIT —
  // the coordinator owns the surrounding transaction.
  schemaSQL: `
    ALTER TABLE tasks ADD COLUMN workflow_id TEXT REFERENCES workflow(id);
  `,

  // Optional. Runs after schemaSQL, before the FK check. Use for
  // application-level transforms pure SQL cannot express (e.g.
  // reading the filesystem, resolving cross-pkg lookups).
  // Synchronous and async forms are both supported.
  // backfill: async (db) => { … },

  // Optional. Runs after backfill, after the FK check, before the
  // schema_meta UPDATE. Throw to abort. Use for invariant assertions
  // beyond what `foreign_key_check` catches — row counts,
  // "no row has value X", etc.
  // verify: async (db) => { … },
};
```

### Step 2: append to the pkg's MIGRATIONS array

```ts
// packages/task/src/migrations/index.ts
import { v0To1 } from "./v0-to-v1.js";
import { v1To2 } from "./v1-to-v2.js";
import { v2To3 } from "./v2-to-v3.js";
import { v3To4 } from "./v3-to-v4.js"; // NEW

export const TASK_MIGRATIONS: readonly Migration[] = [v0To1, v1To2, v2To3, v3To4];
```

### Step 3: bump the pkg's HEAD-version constant

Each repository asserts in its `ensureSchema()` that the on-disk
`schema_meta` row matches the build's expected HEAD:

```ts
// packages/task/src/repositories/sqlite-task-repository.ts
const TASK_PKG_SCHEMA_VERSION = 4; // was 3
```

### Step 4: write a regression test

Land a test in `packages/<pkg>/test/migration/` that seeds a v(N) DB
shape, runs `await runPkgMigrations(db, [{ pkg, migrations: <PKG>_MIGRATIONS }])`,
and asserts the post-migration state. See
`packages/task/test/migration/task-v2-to-v3-via-coordinator.test.ts`
for the template.

### Step 5: ship

`pnpm build && pnpm typecheck && pnpm test && pnpm lint` must all
pass. Open the PR — the coordinator's wiring in
`packages/server/src/index.ts` and `packages/server/src/workspace-context.ts`
already includes every pkg's MIGRATIONS array, so no server change
is needed unless you're adding an entirely new pkg.

## Adding a new pkg

When you create a brand-new entity package with its own SQLite
tables:

1. Add `src/migrations/v0-to-v1.ts` with the initial schema.
   `CREATE TABLE IF NOT EXISTS` is recommended so the migration is
   idempotent under unusual re-run scenarios (e.g. data-recovery
   tooling).
2. Add `src/migrations/index.ts` exporting `<PKG>_MIGRATIONS`.
3. Add `@emploke/workspace` to the pkg's `dependencies` so it can
   `import type { Migration }`.
4. Refactor the repository's `ensureSchema()` to be a version-check
   assertion — never bootstrap tables.
5. Wire the new MIGRATIONS array into the server's coordinator
   call in `packages/server/src/workspace-context.ts` (for
   workspace.db-resident pkgs) or `packages/server/src/index.ts`
   (for global.db-resident pkgs).
6. Update test fixtures to `await runPkgMigrations(db, [{ pkg, migrations: <PKG>_MIGRATIONS }])`
   before constructing the repository.

## Conventions

- **Pkg name strings are stable identifiers** — `task`, `session`,
  `catalog_agent`, `catalog_skill`, `catalog_mcp`, `workspace`,
  future `workflow`. Never change a pkg name; doing so orphans
  every existing DB's `schema_meta` row for that pkg.
- **Migrations bump by exactly one version step** — `vN → vN+1`.
  The coordinator validates this at registration time.
- **First migration starts at `fromVersion = 0`** — this is the
  "fresh DB" bootstrap. The coordinator validates this at
  registration time.
- **`schemaSQL` is DDL + one-shot inserts only**; complex data
  transforms go in `backfill`.
- **`schemaSQL` must NOT include `BEGIN` / `COMMIT`**; the
  coordinator owns the surrounding transaction.
- **`dependsOn` is for cross-pkg edges only**. Within-pkg ordering
  (`vN+1` after `vN`) is enforced automatically by the topo sort.
- **Forward-only**. No `down()` step. Backup-before-migrate is
  deferred — for now, transaction ROLLBACK covers mid-flight
  failure and operators rely on file-system backups for catastrophic
  cases.

## Locked design decisions

These were locked in the migration architecture review (CEO design
archive, `.ceo/decisions.log`); don't relitigate without a new ADR.

1. **Forward-only**: no `down()`. Downgrade is out of scope.
2. **No backup phase v1**: transaction ROLLBACK covers mid-flight
   failure; full backup-before-migrate is deferred to a later phase.
3. **Hybrid Option 3**: DB-level coordinator + pkg-owned migration
   files. NOT central `migrations/` dir, NOT pure per-pkg.
4. **Single transaction**: ALL pending migrations across all pkgs in
   one DB run in one `BEGIN IMMEDIATE` … `COMMIT`.
5. **PRAGMA foreign_keys management**: OFF wraps the transaction;
   explicit `PRAGMA foreign_key_check` before COMMIT validates FK
   integrity.
6. **Initial schema as v0→v1**: bootstrap is just another
   migration. Uniform mental model regardless of fresh-DB vs
   upgrade.
7. **`schema_meta` per-pkg unchanged**: same table layout, same
   one-row-per-pkg pattern as pre-#123.

## Error reference

| Error                                | When raised                                                                                                |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `MigrationRegisterError`             | `register()` got a malformed chain (wrong pkg name, version gap, non-unit bump, etc.).                     |
| `MigrationVersionAheadError`         | DB is at a higher version than the code's chain produces (downgrade not supported).                        |
| `MigrationFailedError`               | `schemaSQL` / `backfill` / `PRAGMA foreign_key_check` / `verify` threw. Transaction has been rolled back.  |
| `MigrationCycleError`                | `dependsOn` declarations form a cycle.                                                                     |
| `MigrationDependencyMissingError`    | `dependsOn` references a node not in the pending set (referenced migration either unregistered or already applied). |

## Test helpers

- `runPkgMigrations(db, [{pkg, migrations}, …])` — async runner.
  Production code uses this; test fixtures call it from
  `beforeEach(async () => { await runPkgMigrations(…) })`. There is
  no sync variant: every pkg's migrations participate in the same
  framework, and as of #122 some migrations declare async backfill
  hooks, so a sync runner cannot satisfy the full surface. See #133
  for the consolidation rationale.

Exported from `@emploke/workspace`.
