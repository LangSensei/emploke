# @emploke/__PKG__

TODO: replace this README with a short description of what the
__PKG__ package owns.

## Layout

See `docs/pkg-template.md` for the full convention. Per-pkg layout:

```
src/
  schema.ts                          Drizzle table definitions (private impl detail)
  errors.ts                          Domain errors raised by the service
  types.ts                           Public DTOs + option shapes (exported)
  __entity-kebab__-repository.ts     Drizzle-backed CRUD (private impl detail)
  __entity-kebab__-service.ts        __Entity__Service — reads + writes, returns DTOs
  compose.ts                         compose__Entity__Module({dbFile|db, ...}) entry point
  testing.ts                         openTest__Entity__Db() in-memory test helper
  index.ts                           public barrel re-export
drizzle/                             generated SQL migrations (committed)
drizzle.config.ts                    drizzle-kit codegen config
```

Add `src/__entity-kebab__-entity.ts` (`class __Entity__Entity`) ONLY
if the BC has non-trivial state transitions or invariants to
encapsulate. The template ships without one because most BCs don't
need it.

**When a service file grows beyond ~600 LOC AND ~3 cohesive
concerns**, split it via the **facade + sibling subdir** convention.
See `docs/pkg-template.md § Splitting big files via facade + sibling
subdir`. Canonical reference: `packages/task/src/task-service.ts` +
`packages/task/src/task-service/`. For a self-contained illustrated
example with placeholder names you can rename when applying, see
`packages/_template/_examples/split-layout/`. The scaffold stays flat
— new packages start with one `<entity>-service.ts` file and only
split later if the file actually outgrows the thresholds.

### Catch-block convention

Do NOT create `src/utils/errors.ts` or any helper file for catch-block
error normalization (`errorMessage`, `isAbortError`, etc.). Use the
inline form at each `catch (e) { ... }` site:

    const msg = e instanceof Error ? e.message : String(e);

For abort-error detection:

    if (e instanceof Error && e.name === "AbortError") return;

Rationale: these checks are tiny, stateless, and benefit from local
readability over a shared abstraction. Backend packages do not use a
`src/utils/` subfolder — keep `src/` flat. (Dashboard's `src/utils/`
is a frontend convention with multiple files like `fqn.ts`, `time.ts`;
that pattern is fine for the dashboard, but error normalization stays
inline there too.)

## Naming

### Public (exported from `index.ts`)

| concept            | name                                     |
| ------------------ | ---------------------------------------- |
| package name       | `@emploke/__PKG__`                       |
| DTO (wire shape)   | `__Entity__` (bare noun)                 |
| service surface    | `__Entity__Service` (reads + writes)     |
| compose function   | `compose__Entity__Module`                |
| test-db helper     | `openTest__Entity__Db`                   |
| schema re-export   | `schema` (namespace)                     |

### Internal (NOT exported)

| concept            | name                                     |
| ------------------ | ---------------------------------------- |
| Drizzle row        | `__Entity__Row`                          |
| repository class   | `__Entity__Repository`                   |
| entity class (opt) | `__Entity__Entity`                       |

NEVER use `Manager`, `Queries`, `View`, `Pojo`, or `Dto` suffixes.

## Naming check (enforced)

1. **Package folder + npm name are singular** (`task`, `session`, `workspace` — NOT `tasks`, `sessions`). Matches the BC noun.
2. **File names use the `<entity-kebab>-<kind>.ts` prefix** for entity / repository / service / aggregate files (see `packages/task/src/` for the canonical example).
3. **Container identifiers (service / repository / module / compose / journal) are singular**: `TaskService`, `composeTaskModule`, `__drizzle_migrations_task`. Plural is reserved for **collections-as-data** like `WORKFLOW_NODES_SUBDIR` (a directory holding many nodes) or `MIGRATIONS` (array of migrations).
4. PR review must mechanically diff new pkg's file tree against `packages/_template` + sibling pkgs' naming. Any divergence requires a written justification in the PR body.

## Boundary

Downstream packages depend on `__Entity__Service` directly, OR on a
narrow capability interface declared in the downstream package itself
(e.g. `@emploke/runtime`'s `AgentContentSource`).
