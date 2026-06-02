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

## Test layout convention

Every `packages/<pkg>/test/**/*.test.{ts,tsx}` file's location is
determined mechanically by its source imports. Enforced by
`packages/task/test/test-layout-convention.test.ts`.

**The rule**: for each test file, collect every non-type value-import
that resolves to a file under the same package's `src/` tree (resolve
relative to the test file's directory; exclude type-only imports,
`vi.mock(...)`, `vi.importActual(...)`, and imports of other workspace
packages or node builtins).

1. **Zero in-pkg value-imports** → flat at `test/<name>.test.{ts,tsx}`
   (cross-cutting / e2e / fs-walk audits).
2. **All value-imports share a common subdirectory under `src/`
   strictly deeper than `src/` itself** → MUST live at
   `test/<that-subdir>/<name>.test.{ts,tsx}`.
3. **Multiple value-imports with no common subdir below `src/`** →
   flat at `test/<name>.test.{ts,tsx}`.

Type-only imports (`import type { Foo } from "..."` and the `type`
modifier inside mixed `import { type Foo, bar }` specifiers) compile
away and do NOT count. `vi.mock("...")` and `vi.importActual("...")`
are harness, not subject, and do NOT count. Side-effect-only
`import "x"` DOES count — it executes top-level code.

**When source moves, tests move.** If `src/utils/x.ts` is relocated
to `src/x.ts`, the rule's verdict changes and the test must be
relocated in the same PR. The enforcement test fails until both
halves are in sync.

**Allowlisting**: a test whose actual location diverges from the
rule's required location but has a documented reason (umbrella
reflection test, in-flight migration, pre-existing per-area subdir
whose imports happen to span sibling top-level src files) may be
added to `ALLOWED_FLAT_EXCEPTIONS` with a one-line rationale. The
audit asserts the allowlist contains no stale entries (file gone)
and no idle entries (test the rule already passes for).

For worked-out classification examples and the parser self-tests, see
`packages/task/test/test-layout-convention.test.ts`.

## File naming convention

> See [docs/architecture.md § Per-package src layout](./architecture.md#per-package-src-layout) for the full rationale.

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

> See [docs/architecture.md § The three layers](./architecture.md#the-three-layers) for the Row / Entity / DTO split that motivates the single `types.ts` rule.

**ALL public types — DTOs, option shapes, enums, union types — live in
`types.ts`.** Every package has one, regardless of size.

Other files must NOT `export interface` or `export type` consumer-facing
types. The exceptions are:
- `schema.ts` MAY define `<Entity>Row` (Drizzle `$inferSelect` alias)
  but the type is **package-private** — never re-exported from
  `index.ts` even via `export * as schema`. See "Repository contract"
  below.
- `errors.ts` exports Error subclasses (classes are values, not pure types)
- `<entity>-entity.ts` exports the class (a value) for rich-domain BCs
- Multi-entity BCs' `facade/plan-types.ts` may export facade-internal types

This rule prevents the "where do I find the `Workspace` interface" drift
that plagued emploke before (DTOs scattered across `service.ts`,
`schema.ts`, separate `dto.ts`).

## Type placement (which package owns this type?)

> See [docs/architecture.md § The three layers](./architecture.md#the-three-layers) for the Row / Entity / DTO split inside one package. This section covers the orthogonal question: *which package* should host a given type.

The "Where DTOs live" section above governs *intra-package* type layout
(one `types.ts` per pkg). This section governs *inter-package* type
layout — given a new type, which of emploke's four type-owning location
kinds should host it.

The monorepo has four kinds of type-owning location. Use this decision
tree in order:

| Kind of type | Lives in | One-line test |
|---|---|---|
| A single BC's entity / DTO / error / option shape | the owning domain pkg's `types.ts` / `errors.ts` | "Does it belong to one BC only? Would you delete it if you deleted that BC?" |
| HTTP wire contract — request / response shape, ROUTES table, wire-side enum | `@emploke/api-types` | "Will it appear in a Network tab payload, or in a generated client?" |
| In-process composition / runtime container holding live service instances or callbacks | `@emploke/core` | "Does it own `Promise<Service>` or a `(c) => Service` resolver? Is it constructed once per workspace?" |
| HTTP-transport-internal type (`Hono.Context`-flavoured, route-resolver, middleware) | `@emploke/server` | "Does its signature reference `Hono.Context`, request bodies, or Express-style middleware?" |

### Decision rules (sharp edges)

1. **Crosses the HTTP boundary → `api-types`, never the originating domain pkg.**
   If a type appears in a request body, response body, or ROUTES table,
   it MUST live in `api-types`. Domain pkgs can `import type` from
   `api-types` when they need to project their internal DTO to the wire
   shape; the inverse direction (`api-types` importing values from a
   domain pkg) is FORBIDDEN — `api-types` is type-only and
   transport-internal.

2. **Holds a live function / instance / context → `core`, never `api-types`.**
   `core` is the composition root: it constructs `WorkspaceContext`,
   `Application`, per-workspace service instances. Types that carry
   `Promise<Service>`, `() => Service`, or compose-result shapes belong
   here. `api-types` is transport-only and never holds instances.

3. **Single domain's entity / DTO / error → that domain's pkg, never `core`.**
   If `Task` only makes sense as part of the task BC, it lives in
   `packages/task/src/types.ts`. `core` re-exports nothing — downstream
   consumers (server, cli) `import { type Task } from "@emploke/task"`
   directly. `core` only owns *cross-BC composition* types.

4. **Transport-specific glue → `server` (or the future transport pkg), never `core`.**
   A type whose signature mentions `Hono.Context`, `Request`, `Response`,
   or a route function is HTTP-specific and belongs in `server`. Promote
   to `core` only when a second transport (CLI direct-mode, MCP, gRPC)
   actually arrives and needs the same abstraction generically.
   *Premature generification is the bigger sin than late generification
   here.*

5. **Inter-domain-pkg dependencies must be `import type` ONLY.**
   `task` may `import type` from `catalog` (e.g. `AgentResolveResult`)
   because it talks to catalog *through a service-instance threaded by
   `core`*. It must NOT value-import from `catalog` — that would couple
   two BCs at runtime and violate the "core is the only composer"
   invariant. Enforced mechanically by
   `packages/task/test/inter-service-imports.test.ts`.

### Corollaries

- **Wire types vs domain types: when they diverge.** A domain pkg's
  internal `XxxEntity` and the wire `Xxx` DTO drift over time
  (`createdAt: Date` → `createdAt: string`, soft-delete fields hidden).
  When that happens, the wire shape moves to `api-types`; the entity
  stays in the domain. The service in the domain pkg owns the
  projection.

- **Errors that cross the wire.** If an error name appears in an HTTP
  error response (i.e. the client branches on it), its `name` literal
  is wire-shape and should be re-declared in `api-types`. The Error
  *class* stays in the domain pkg's `errors.ts`. Cross-pkg consumers
  that need to discriminate the error should branch on `err.name ===
  "AgentNotFoundError"` rather than `import`ing the class for
  `instanceof` — the latter introduces a runtime cross-BC dep that
  rule 5 forbids.

- **Resolvers (`(c: Hono.Context) => Service`) stay in `server`.**
  Their parameter type is HTTP-specific; promoting to `core` would
  require introducing a generic `ServiceResolver<RequestCtx, Service>`,
  which has no second consumer today.

- **Avoid pure-rename facades.** A file in pkg X that does nothing but
  `export type Foo = OriginalFoo` from pkg Y is a refactoring smell:
  it suggests either (a) X needs to own Foo for real (move the
  definition), or (b) consumers should import directly from Y (delete
  the facade). Existing example removed in this PR's commit 6:
  `server/src/bootstrap.ts` was a 14-line facade re-exporting `core`'s
  `composeApplication` under `buildServerContainer` — deleted in favour
  of consumers importing from `@emploke/core` directly.

### Pitfalls observed in real PRs

- Putting a wire shape in the originating domain pkg "because it's
  defined there" — couples the wire to the domain. **Fix:** move it
  to `api-types`; have the domain pkg `import type` it for projection.

- Putting an in-process resolver type in `api-types` "because it's
  used by routes" — pollutes the wire-types pkg with `Hono.Context`.
  **Fix:** keep in `server`.

- Adding a type to `core` "because multiple downstreams use it" when
  it's actually a single-domain concept — bloats `core`. **Fix:** put
  it in the owning domain pkg; let downstreams import the domain pkg.

- A domain pkg value-importing another domain pkg's service or error
  class — silently builds a runtime cross-BC dep. **Fix:** use
  `import type`; thread the live instance through `core`'s composer;
  for cross-BC error discrimination, branch on `err.name` instead of
  `instanceof`. Mechanically audited by `inter-service-imports.test.ts`.

## Splitting big files via facade + sibling subdir

### When to split

Default: keep one file per `<entity>-<role>.ts` (see naming convention above).

Split a single file ONLY when BOTH conditions hold:

1. The file is **≥ 600 LOC**.
2. The file genuinely contains **≥ 3 cohesive sub-concerns** (e.g. queries vs mutations vs lifecycle vs streaming).

A pure 800-LOC validator (one concern) does NOT split. A 400-LOC service touching 5 concerns does NOT split (too small). A 700-LOC service with reads / writes / lifecycle / streaming DOES split.

### Layout: facade + sibling subdir

```
packages/<pkg>/src/
  <entity>-<role>.ts          ← facade (public entry, ≤ ~250 LOC)
  <entity>-<role>/            ← subdir; basename MUST equal facade basename
    <concern-1>.ts            ← bare concern name; no entity prefix needed
    <concern-2>.ts
    …
```

Canonical reference implementation: `packages/task/src/task-service.ts` +
`packages/task/src/task-service/` introduced in PR #250 — the same PR
that introduces this convention.

### Hard rules

> **Scope.** These 7 rules apply ONLY when a subdir has a sibling `.ts` / `.tsx` file at the parent level (the SPLIT pattern — e.g. `task-service.ts` next to `task-service/`). Subdirs without a sibling file (CATEGORY dirs — e.g. `packages/catalog/src/agent/`, `packages/catalog/src/facade/`, `packages/server/src/routes/`) are a separate, pre-existing organisational pattern and are unaffected by these rules; they MAY contain an `index.ts` barrel and follow the multi-entity / per-route conventions documented elsewhere on this page.

1. **Subdir basename equals facade basename AND is a direct sibling.** `task-service.ts` ↔ `task-service/` in the same directory. Enforced mechanically — see the structural test in `packages/task/test/split-convention.test.ts`. The subdir MUST sit next to its facade; a subdir at any other path (e.g. `src/internal/<role>/`) is not a recognised SPLIT and forfeits the no-barrel and package-private guarantees this convention provides.
2. **No barrel re-export** inside the subdir (no `<entity>-<role>/index.ts`). The facade composes via direct relative imports (`./task-service/queries.js` etc.). Enforced by the same structural test.
3. **Subdir files are package-private.** They MUST NOT appear in the package's top-level `src/index.ts` barrel. The facade is the only public surface.
4. **Concern files use bare names** (`queries.ts`, `mutations.ts`, `shutdown.ts`) — the subdir name already supplies the entity context. Do NOT prefix (`task-queries.ts` inside `task-service/` is wrong).
5. **Each concern file ≤ ~450 LOC.** If a single concern grows beyond that, that concern itself needs further decomposition — but always keep at one level of nesting (do NOT nest `task-service/queries/by-id.ts`).
6. **Facade stays ≤ ~250 LOC** and contains only: constructor, ctx-object construction, and 1-line delegates to internals.
7. **Shared context.** The facade builds a `<Entity>ServiceCtx` (or similar) once and passes it to every internal — no `this`-casting, no widening of class field visibility. Each internal exports plain functions taking `(ctx, …args)` OR a small object that consumes ctx.

### When NOT to use this pattern

- **Cross-entity shared infrastructure** → use a `_shared.ts` file (or a `_*` subdir) — the structural test skips any directory whose name starts with `_`, and treats `_`-prefixed files as ordinary peer modules outside any SPLIT registry. In-tree examples: `packages/server/src/routes/_shared.ts`, `packages/terminal/src/_shared.ts`, `packages/server/src/routes/_error-policies/` (`_shared-bodies.ts` inside it). The leading underscore signals "package-private utility, not a facade-split peer".
- **Component organisation** (e.g. a page + its sub-components) → `packages/dashboard/src/components/tasks/TaskDetail.tsx` + `TaskDetail/` already does this; it is a related but distinct pattern (the subdir contains presentational sub-components, not concern splits of one class). The same structural rules (no `index.tsx` barrel, exact-case sibling) apply.
- **Different concerns belonging to different services** in the same package → keep them as separate top-level `<entity>-<role>.ts` files (current convention).

### Migration of existing big files

Pre-existing big files do NOT need preemptive splitting. Apply this convention WHEN a refactor of that file is otherwise needed (e.g. a feature change, a bug fix that touches many sections, an audit-flagged improvement). PRs that opportunistically split should reference this section in the PR body.

**Registry maintenance (mandatory).** When you split a previously-flat file under this convention, also update `packages/task/test/split-convention.test.ts`:

- Add the new subdir's repo-relative path to `REQUIRED_SPLITS` so future PRs cannot silently delete the facade (the structural test asserts every entry still classifies as SPLIT). If you remove or collapse a SPLIT, drop the entry in the same PR — the test treats `REQUIRED_SPLITS` as the *exact* set of on-disk SPLITs and will fail on either drift direction.
- Remove the subdir from `EXPECTED_CATEGORY_DIRS_AT_CONVENTION_INTRODUCTION` if it was previously a CATEGORY (the SPLIT promotion turns the same path into a SPLIT, so leaving it in the snapshot would trip the "must still be CATEGORY" assertion).

The two registries together are the mechanical record of every applied SPLIT and every surveyed CATEGORY; they must move in lock-step with the source tree.

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
after `SessionManager` was renamed to `SessionService`) or by a non-source
concept word.

## Naming conventions

> See [docs/architecture.md § Coding conventions](./architecture.md#coding-conventions) for the full rationale.

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

## Repository contract

> Industry research: Codex (Rust) `ThreadStore` returns plain
> `Stored*` structs (single domain type per concept; no separate
> wire DTO). Trigger.dev / Cal.com / Prisma consume ORM-inferred
> types directly. NestJS / Spring textbook splits Entity ↔ DTO
> across the repo/service boundary explicitly.
>
> emploke takes the **explicit 3-layer split** for consistency across
> rich (`catalog`, `task`) and anemic (`workspace`, `session`) BCs.
> The Entity layer makes the contract uniform; the row stays
> ORM-private; the DTO stays wire-stable.

### The 3 layers

| Layer | Lives in | Suffix | Visibility | Role |
|---|---|---|---|---|
| **Row** | `schema.ts` | `*Row` | pkg-private | Drizzle `$inferSelect` shape; tracks the table |
| **Entity** | `<entity>-entity.ts` | `*Entity` | pkg-private (NOT re-exported from index.ts) | Pkg-owned domain shape; `interface` for anemic BCs, `class` for rich (state machine / invariants) |
| **DTO** | `types.ts` | **bare noun** (no suffix) | exported from index.ts | Wire shape; what `<Entity>Service` returns; stable contract for HTTP / CLI / other pkgs |

### Repository contract (hard rule)

> **`<Entity>Repository`'s public read methods return the pkg-owned
> `<Entity>Entity` type. They MUST NOT return `<Entity>Row`.**
>
> **`<Entity>Service`'s public methods return the wire `<Entity>` DTO.**

### Projection helpers — write them only when they earn their keep

For **anemic BCs** where Row and Entity are structurally identical,
the row assigns directly to `Entity` via TypeScript structural
typing — no `rowToEntity` helper needed:

```ts
async findById(id: string): Promise<WorkspaceEntity | undefined> {
  return this.db.select().from(workspaces).where(eq(workspaces.id, id)).get();
}
```

Similarly, when Entity → DTO is a trivial spread + 1-line
normalisation, inline it at each service read call site rather
than extracting a helper:

```ts
async getById(id: string): Promise<Workspace | null> {
  const entity = await this.repo.findById(id);
  return entity ? { ...entity, lastOpenedAt: entity.lastOpenedAt ?? entity.createdAt } : null;
}
```

Extract a `rowToEntity` / `entityToDto` helper when:
- Row gains columns that must NOT bleed into Entity (e.g.
  soft-delete `deletedAt`), OR
- Multiple service methods do the same non-trivial projection, OR
- The projection is async / requires cross-pkg context (e.g.
  `SessionEntity` + workdir computation + live runtime metadata
  → `Session` DTO — see `session-service.ts draftFromEntity`).

### When Entity is a class (rich BC)

Add `<entity>-entity.ts` as a `class` instead of an `interface`
when the BC needs:
- Non-trivial state transitions (`running → succeeded`)
- Invariant validation on every mutation
- Immutable functional updates (`entity.withMetadata(...)`)

In-tree examples: `catalog/agent/agent-entity.ts` (frontmatter
validation, `acknowledgePrereqs`), `task/task-entity.ts` (FSM).
Repository still returns the Entity class instance; service
projects to DTO at the wire boundary.

### Why this shape

1. **Single mental model across rich and anemic BCs.** Every
   repository returns `Entity`; every service returns DTO. New
   contributors learn one pattern.
2. **No ORM leak.** `*Row` never crosses the repository boundary;
   swapping Drizzle for something else only touches
   `schema.ts` + `<entity>-repository.ts`.
3. **No type lies.** Wire-side normalisation (`string | null` →
   `string`, composite assembly from row + cross-pkg fetch) has a
   designated home in the service, not scattered across consumers.
4. **Anemic BCs pay zero ceremony today.** The Entity is just a
   typed alias of the row's structural shape; no class, no
   helper functions, no boilerplate. The naming separation
   carries the contract.
5. **Growth path is clear.** If workspace gains a state machine
   tomorrow, `workspace-entity.ts` flips from `interface` to
   `class` and the repository signature stays the same.



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

```sh
pnpm -F @emploke/<pkg> db:generate
```

After drizzle-kit writes a new `drizzle/NNNN_*.sql`, **add a one-line
import + array entry to `src/migrations.ts`** so the new file is
embedded into the runtime bundle. The `migrations-inventory` test (per
pkg) fails immediately if `migrations.ts` drifts from `drizzle/`. CI
also runs `db:generate` against `schema.ts` and fails if it produces a
diff (catches forgotten regeneration).

```ts
// src/migrations.ts — hand-maintained
// @ts-expect-error  "?raw" is Vite syntax, resolved by esbuild plugin
import sql_0001 from "../drizzle/0001_new_thing.sql?raw";

export const MIGRATIONS = [
  // existing entries...
  { name: "0001_new_thing.sql", sql: sql_0001 },
];
```

At runtime, `compose.ts`'s `runPendingMigrations()` walks `MIGRATIONS`
in order, skipping anything already recorded in `__drizzle_migrations`.
SQL is embedded as a string in the JS bundle (via Vite's `?raw` /
esbuild's `rawSuffixPlugin`) — no filesystem reads at runtime. Same
applies in `testing.ts` so in-memory test DBs see the same schema.

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
