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
    schema.ts                  Drizzle table defs (private; only types are exported)
    errors.ts                  Domain error classes (exported)
    types.ts                   Public DTOs + option shapes (exported)
    validate.ts                id regex + assertValidXxxId (+ other input validators)
    <entity>-repository.ts     Drizzle CRUD (PRIVATE — never exported from index)
    <entity>-service.ts        <Entity>Service — reads + writes, returns DTOs (exported)
    <entity>-entity.ts         <Entity>Entity class (OPTIONAL — only if BC needs it)
    compose.ts                 compose<Entity>Module({dbFile|db}) (exported)
    testing.ts                 openTest<Entity>Db() helper (exported via /testing)
    index.ts                   public barrel
  drizzle/                     generated SQL migrations (committed)
  drizzle.config.ts            drizzle-kit codegen config
  package.json                 depends on better-sqlite3 + drizzle-orm + pino
  tsconfig.json                extends ../../tsconfig.base.json
  vitest.config.ts
```

## File naming convention

> See `files/architecture-design.md` Section 10 for the full rationale.

**Files exposing a class get an `<entity>-<role>.ts` prefix**:

| file pattern | exports |
|---|---|
| `<entity>-service.ts` | `<Entity>Service` |
| `<entity>-repository.ts` | `<Entity>Repository` |
| `<entity>-entity.ts` | `<Entity>Entity` |

**Utility / glue files use bare role names** (no entity prefix):

`errors.ts`, `types.ts`, `validate.ts`, `schema.ts`, `paths.ts`, `compose.ts`,
`testing.ts`, `index.ts`, `projection.ts`, `plan-types.ts`,
`framing.ts`, `format.ts`.

Rationale: TypeScript imports always carry the full path, so file names
are the grep / IDE token for class location. NestJS, Cal.com, VS Code,
TypeORM, etc. all prefix the class-bearing files. Single-entity packages
in emploke (workspace, session, task) still prefix to keep the
convention uniform across the monorepo.

## Where DTOs live

> See `files/architecture-design.md` Section 11.

**ALL public types — DTOs, option shapes, enums, union types — live in
`types.ts`.** Every package has one, regardless of size.

Other files must NOT `export interface` or `export type` consumer-facing
types. The exceptions are:
- `schema.ts` can export `<Entity>Row` (Drizzle `$inferSelect` alias —
  internal, used by repository only)
- `errors.ts` exports Error subclasses (classes are values, not pure types)
- `<entity>-entity.ts` exports the class (a value)
- Multi-entity BCs' `facade/plan-types.ts` may export facade-internal types

This rule prevents the "where do I find the `Workspace` interface" drift
that plagued emploke before (DTOs scattered across `service.ts`,
`schema.ts`, separate `dto.ts`).

## Test file naming

Test files mirror the source file they test, with `.test.ts` appended.
Large suites split by feature with a `.<feature>` infix.

| source                          | test                                            |
| ------------------------------- | ----------------------------------------------- |
| `<entity>-service.ts`           | `<entity>-service.test.ts`                      |
| `<entity>-service.ts` (per-feature suite) | `<entity>-service.<feature>.test.ts`  |
| `<entity>-repository.ts`        | `<entity>-repository.test.ts`                   |
| `<entity>-repository.ts` (per-feature) | `<entity>-repository.<feature>.test.ts`  |
| `<entity>-entity.ts`            | `<entity>-entity.test.ts`                       |
| `validate.ts`                   | `validate.test.ts`                              |
| `paths.ts`                      | `paths.test.ts`                                 |
| `compose.ts`                    | `compose.test.ts`                               |

Examples in-tree:
- `workspace-service.register.test.ts`, `workspace-service.rename.test.ts`,
  `workspace-service.reads.test.ts` — per-feature splits of the same
  service class.
- `task-service.cancel-orphan.test.ts`, `task-service.delete-no-longer-kills.test.ts`
  — per-scenario splits.
- `task-repository.failure-union.test.ts`, `task-repository.origin-filter.test.ts`
  — per-feature splits of the repository.

Tests under a sub-folder mirror the source sub-folder:
`packages/catalog/src/agent/agent-service.ts` →
`packages/catalog/test/agent/agent-service.test.ts`.

NEVER name a test file by an old class name (`manager.test.ts` was wrong
after `SessionService` was renamed to `SessionService`) or by a non-source
concept word.

## Naming conventions

> See `files/architecture-design.md` Section 9 for the full rationale.

### Public types (exported from `index.ts`)

| concept            | name                                |
| ------------------ | ----------------------------------- |
| package name       | `@emploke/<pkg>`                    |
| **DTO** (wire shape)| `<Entity>` — bare noun             |
| list entry         | `<Entity>Entry` (only if it differs from DTO) |
| write+read surface | `<Entity>Service`                   |
| compose function   | `compose<Entity>Module`             |
| module options     | `<Entity>ModuleOptions`             |
| module result type | `<Entity>Module`                    |
| test-db helper     | `openTest<Entity>Db`                |

### Internal types (NOT exported)

| concept            | name                                |
| ------------------ | ----------------------------------- |
| Drizzle row        | `<Entity>Row`                       |
| repository class   | `<Entity>Repository`                |
| entity class (only if BC needs one) | `<Entity>Entity`     |

NEVER use these suffixes:
- `Manager` — replaced by `Service`
- `Queries` — merged into `Service`
- `View` / `Pojo` / `Dto` — replaced by bare-noun DTO

## DTO vs entity class

Every BC exports a **bare-noun DTO** (`Workspace`, `Session`, `Agent`).
Inside the package, that DTO is what `<Entity>Service` returns to its
callers. Drizzle rows (`<Entity>Row`) are private to the repository
layer.

An **entity class** (`<Entity>Entity`) is added ONLY when the BC has
non-trivial domain logic to encapsulate:

| Has entity class? | When |
|---|---|
| Yes | Non-trivial state transitions (`pending → running → succeeded`), invariant validation on every mutation, immutable functional updates |
| No  | Pure CRUD: change a name, set a timestamp |

Existing examples:

- `catalog`: `AgentEntity`, `SkillEntity`, `McpEntity` — encapsulate
  frontmatter validation, `acknowledgePrereqs()`, immutable updates.
- `task`: `TaskEntity` — owns the status-state-machine.
- `workspace`, `session`: no entity class.

The template ships WITHOUT an entity class (most BCs don't need one).
Add one when state transitions show up; place it in `src/<entity>-entity.ts`
and keep it un-exported from `index.ts`.

## Single service per BC

Every BC exposes exactly ONE public class:

- **`<Entity>Service`** — both reads (list / get / lookup) and writes
  (create / update / delete / state transitions). Returns DTOs.

The previous read/write class split (`<Entity>Queries` + `<Entity>Service`)
was retired: industry research (codex, NestJS, tRPC, Cal.com, Plane,
Coder) found everyone uses a single class per BC. The split added
indirection without payoff at emploke's scale.

If a downstream package only needs a narrow subset of methods, declare
a small **capability interface** in the downstream package and depend
on that, rather than importing the whole service type:

```typescript
// packages/runtime/src/types.ts — minimal surface for "resolve an agent"
export interface AgentContentSource {
  resolveAgent(fqn: string): Promise<AgentResolveResult>;
  // ... 3 more methods, total 4
}
```

The downstream pkg accepts `AgentContentSource`; the composition root
passes a `CatalogService` instance (which structurally implements the
interface). This is a real example from `@emploke/runtime`.

## Composition root

The composition root (`@emploke/core`'s `WorkspaceRuntimeCache.load`)
calls each `compose<Entity>Module({ dbFile })` once per workspace and
threads the `service` into downstream pkgs (either as-is or through a
capability interface).

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

The service imports from `paths.ts` instead of doing `path.join` inline.
Existing examples: `packages/session/src/paths.ts`,
`packages/task/src/paths.ts`.

### Multi-entity BCs → subfolder per entity + `facade/`

If the BC owns more than one rich entity that participates in
cross-entity orchestration (catalog owns Agent + Skill + Mcp), mirror
the standard layout into per-entity subfolders. **The file-naming
convention is the same — `<entity>-<role>.ts` even inside a subfolder**:

```
src/
  schema.ts                 cross-entity table definitions
  dto.ts                    cross-entity DTOs (bare nouns: Agent / Skill / Mcp)
  index.ts                  public barrel

  agent/
    agent-entity.ts         AgentEntity class (internal)
    agent-repository.ts     AgentRepository (internal)
    agent-service.ts        per-entity write logic (internal)
    errors.ts               per-entity errors (bare role file)
    validate.ts             per-entity input validators (bare role file)
    index.ts                subfolder barrel

  skill/  … mirror
  mcp/
    mcp-entity.ts
    mcp-repository.ts
    mcp-service.ts
    mcp-format.ts           entity-specific format helpers
    errors.ts
    validate.ts
    index.ts

  facade/
    catalog-service.ts      unified read+write surface across all entities
    plan-types.ts           shared cross-entity DTOs
    projection.ts           pure projection helpers (Row → DTO)
    errors.ts
    index.ts                facade barrel

  compose.ts                composeCatalogModule({...})
```

The per-entity `<entity>-service.ts` classes are **internal** to the
BC; they are not exported from the package barrel. External callers go
through the facade only. Existing example: `packages/catalog/`.

### Test seams (clock, randomness)

Service constructors accept an optional `{ now?: () => Date; randomBytes?: (n: number) => Buffer }`
opts object when the service touches the clock or generates ids. Pass
fakes from tests; production callers omit the opts to get the real ones.
The template's `__Entity__Service` shows the minimal `now?` pattern.
