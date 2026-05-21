# Service package template

This document describes the standard layout every BC-owning service
package in emploke follows. Examples in-tree: `@emploke/workspace`,
`@emploke/session`, `@emploke/task`, `@emploke/catalog`.

## Scaffold a new service package

```bash
pnpm new-pkg <pkg-name> <EntityName> <table_name>
# e.g.
pnpm new-pkg notebook Note notes
pnpm install
pnpm --filter @emploke/notebook db:generate
pnpm --filter @emploke/notebook test
```

The scaffolder copies `packages/_template/`, substitutes the placeholder
tokens (`__PKG__` / `__Entity__` / `__entity__` / `__entities__`), and
deletes the placeholder migration so drizzle-kit can regenerate it from
your schema.

## Layout

```
packages/<pkg>/
  src/
    schema.ts        Drizzle table defs (private; only types are exported)
    errors.ts        Domain error classes (exported)
    types.ts         Public DTOs + option shapes (exported)
    validate.ts      id regex + assertValidXxxId (+ other input validators)
    repository.ts    Drizzle CRUD (PRIVATE — never exported)
    queries.ts       <Entity>Queries — all reads, returns DTOs (exported)
    service.ts       <Entity>Service — all writes, returns DTOs (exported)
    compose.ts       compose<Entity>Module({dbFile|db}) (exported)
    testing.ts       openTest<Entity>Db() helper (exported via /testing)
    index.ts         public barrel
  drizzle/           generated SQL migrations (committed)
  drizzle.config.ts  drizzle-kit codegen config
  package.json       depends on better-sqlite3 + drizzle-orm + @emploke/logger
  tsconfig.json      extends ../../tsconfig.base.json
  vitest.config.ts
```

## Naming conventions

| concept            | name                                |
| ------------------ | ----------------------------------- |
| package name       | `@emploke/<pkg>`                    |
| main entity class  | `<Entity>` (PascalCase singular)    |
| Drizzle table      | `<entities>` (snake_case plural)    |
| write surface      | `<Entity>Service`                   |
| read surface       | `<Entity>Queries`                   |
| repository class   | `<Entity>Repository` (private)      |
| compose function   | `compose<Entity>Module`             |
| test-db helper     | `openTest<Entity>Db`                |
| module options    | `<Entity>ModuleOptions`              |
| module result type | `<Entity>Module`                     |

NEVER use the suffix `Manager` for new services. Manager-shaped legacy
classes (`SessionManager`, `TaskManager`) will be migrated to the
`Service` / `Queries` split incrementally.

## Read / write split

Every BC exposes exactly TWO public classes:

- **`<Entity>Service`** — writes (create / update / delete / state
  transitions). Returns wire-shape DTOs so callers don't need a follow-up
  read. NEVER add read-only methods here.
- **`<Entity>Queries`** — reads (list / get / lookup / resolve / preview).
  Returns DTOs. NEVER add mutations here.

Both share the same `<Entity>Repository` instance built by
`compose<Entity>Module`. Writes from the service are immediately visible
to subsequent queries calls — there is no in-memory cache to invalidate.

## Downstream dependencies

Downstream packages should declare their dependency on `<Entity>Queries`
(or a narrower capability interface), NOT on the concrete
`<Entity>Service`. The write surface is reserved for the composition
root (`@emploke/core`) and admin-style routes in `@emploke/server`.

Example (session pkg consuming catalog):

```typescript
// packages/session/src/types.ts
import type { CatalogQueries } from "@emploke/catalog";

export interface SessionManagerConfig {
  readonly catalog: CatalogQueries;  // narrows to reads only
  // ...
}
```

If a downstream pkg uses only one or two catalog methods, define a
narrow capability interface in the downstream pkg and depend on that
instead:

```typescript
// packages/runtime/src/types.ts — minimal surface for "resolve an agent"
export interface AgentResolver {
  resolveAgent(fqn: string): Promise<AgentResolveResult>;
}
```

## Composition root

The composition root (`@emploke/core`'s `WorkspaceRuntimeCache.load`)
calls each `compose<Entity>Module({ dbFile })` once per workspace and
threads the `queries` half into downstream pkgs. The `service` half
flows to admin routes via the per-workspace runtime container.

## Errors

All errors live in `src/errors.ts`. Convention:

```typescript
export class XxxError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = "XxxError";
  }
}

export class XxxNotFoundError extends XxxError {
  override readonly name = "XxxNotFoundError";
  constructor(public readonly id: string) {
    super(`Xxx "${id}" not found`);
  }
}
```

Two rules:
1. Every BC has a base `<Entity>Error` class; specific errors extend it.
   Same-realm callers can `catch (e) { if (e instanceof XxxError) … }`.
2. Subclasses declare `override readonly name = "..."` with a literal
   string equal to the class name. Do NOT use `this.name = new.target.name`
   — bundlers can name-mangle the class and break it.

Route / CLI layers should branch on `error.name` (string literal), NOT on
`instanceof XxxError` — bundlers can split the class definition across
chunks and `instanceof` will silently fail across package boundaries.

## Migrations

Drizzle migrations live under `drizzle/` and are committed. To
regenerate after a schema change:

```bash
pnpm --filter @emploke/<pkg> db:generate
```

The in-process migrator in `compose.ts` replays every `.sql` file in
lexicographic order, tracking applied names in a `__drizzle_migrations`
bookkeeping table. The same logic is duplicated in `testing.ts` so
in-memory test DBs see the same schema.

## Optional patterns

The standard skeleton above covers a single-entity BC with no extra
concerns. The patterns below appear in some real packages and are
documented here so newcomers know when and how to add them. **Do not
copy them into a new package unless the package actually needs them.**

### Filesystem-owning BCs → `src/paths.ts`

If the BC owns a directory layout under a root the composer hands it
(e.g. session owns `<workspace>/sessions/`, task owns `<workspace>/tasks/`),
add a small `src/paths.ts` that centralizes the path math:

```typescript
// src/paths.ts
import path from "node:path";

export function xxxDir(root: string, id: string): string {
  // SECURITY: refuses ids that try to escape via "..", absolute paths, etc.
  return safeJoinUnderRoot(root, id);
}

export function safeJoinUnderRoot(root: string, ...parts: string[]): string {
  // ... implementation; see packages/session/src/paths.ts for the canonical version
}
```

Service / queries import from `paths.ts` instead of doing `path.join`
inline. Existing examples: `packages/session/src/paths.ts`,
`packages/task/src/paths.ts`.

### Multi-entity BCs → subfolder per entity + `facade/`

If the BC owns more than one rich entity that participates in
cross-entity orchestration (catalog owns Agent + Skill + Mcp), mirror
the standard layout into per-entity subfolders:

```
src/
  schema.ts                 cross-entity table definitions
  errors.ts                 (optional) base error + cross-entity errors
  testing.ts                openTestXxxDb() — single test helper covering all tables
  index.ts                  public barrel

  agent/
    agent-entity.ts         rich entity class (if any)
    agent-repository.ts     interface
    drizzle-agent-repository.ts  impl
    agent-service.ts        per-entity write logic (internal)
    errors.ts               per-entity errors
    validate.ts             per-entity input validators
    index.ts                subfolder barrel

  skill/  … mirror
  mcp/    … mirror

  facade/
    catalog-service.ts      write surface across all entities
    catalog-queries.ts      read surface across all entities
    plan-types.ts           shared cross-entity DTOs
    projection.ts           pure projection helpers shared by service + queries
    index.ts                facade barrel

  compose.ts                composeCatalogModule({...}) — builds both halves
```

The per-entity `XxxService` classes are **internal** to the BC; they are
not exported from the package barrel. External callers go through the
facade only. Existing example: `packages/catalog/`.

### Test seams (clock, randomness)

Service constructors accept an optional `{ now?: () => Date; randomBytes?: (n: number) => Buffer }`
opts object when the service touches the clock or generates ids. Pass
fakes from tests; production callers omit the opts to get the real ones.
The template's `__Entity__Service` shows the minimal `now?` pattern.
