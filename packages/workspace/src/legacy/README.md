# `legacy/`

Code in this directory is **slated for removal**. It still ships with
`@emploke/workspace` because downstream packages (`session`, `task`,
`catalog`, `server`) still depend on it, but the workspace pkg itself
no longer uses any of it internally.

## Contents

- `migration/` — the hand-rolled `MigrationCoordinator` + per-pkg
  migration registry. Used by `session` / `task` / `catalog` to
  evolve their per-workspace SQLite schemas. Workspace pkg itself
  pivoted to MikroORM's schema generator and no longer runs this
  framework.

## Removal plan

Each subdirectory disappears once its consumers stop importing it.
For `migration/`: when session/task/catalog adopt MikroORM (or move
to a dedicated `@emploke/migration` pkg), delete `legacy/migration/`
along with the public re-exports in `src/index.ts`.
