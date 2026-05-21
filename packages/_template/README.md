# @emploke/__PKG__

TODO: replace this README with a short description of what the
__PKG__ package owns.

## Layout

See `docs/pkg-template.md` for the full convention. Per-pkg layout:

```
src/
  schema.ts        Drizzle table definitions (private impl detail)
  errors.ts        Domain errors raised by service + queries
  types.ts         Public DTOs, options, manager-config shapes
  repository.ts    Drizzle-backed CRUD (private impl detail)
  queries.ts       __Entity__Queries — all reads, returns DTOs
  service.ts       __Entity__Service — all writes, returns DTOs
  compose.ts       compose__Entity__Module({dbFile|db, ...}) entry point
  testing.ts       openTest__Entity__Db() in-memory test helper
  index.ts         public barrel re-export
drizzle/           generated SQL migrations (committed)
drizzle.config.ts  drizzle-kit codegen config
```

## Naming

| concept            | name              |
| ------------------ | ----------------- |
| package name       | `@emploke/__PKG__`|
| main entity class  | `__Entity__`      |
| Drizzle table      | `__entities__`    |
| write surface      | `__Entity__Service` |
| read surface       | `__Entity__Queries` |
| repository class   | `__Entity__Repository` (private) |
| compose function   | `compose__Entity__Module` |
| test-db helper     | `openTest__Entity__Db` |
| schema re-export   | `schema` (namespace) |

## Boundary

Downstream packages should depend on `__Entity__Queries` (reads) or
narrow capability interfaces, NOT on the concrete `__Entity__Service`
class. The write surface is reserved for the composition root
(`@emploke/core` and admin routes in `@emploke/server`).
