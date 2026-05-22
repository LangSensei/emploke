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

## Boundary

Downstream packages depend on `__Entity__Service` directly, OR on a
narrow capability interface declared in the downstream package itself
(e.g. `@emploke/runtime`'s `AgentContentSource`).
