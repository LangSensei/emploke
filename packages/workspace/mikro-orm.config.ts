import { defineConfig } from "@mikro-orm/better-sqlite";
import { Migrator } from "@mikro-orm/migrations";
import { Workspace } from "./src/domain/workspace.js";

/**
 * MikroORM CLI / runtime config for the `workspace` pkg's global
 * registry DB (`<EMPLOKE_HOME>/global.db` in production).
 *
 * Phase 2 / ADR-3 — replaces the deleted `WORKSPACE_MIGRATIONS`
 * surface. Use `mikro-orm migration:create` / `migration:up` against
 * this config to manage schema changes from this point on.
 *
 * `EMPLOKE_GLOBAL_DB_PATH` env override lets CI / scripted
 * `mikro-orm` invocations target a sandbox DB without editing this
 * file; production / dev resolve via the server's bootstrap which
 * passes `dbName` directly to `MikroORM.init`.
 */
export default defineConfig({
  entities: [Workspace],
  dbName: process.env.EMPLOKE_GLOBAL_DB_PATH || "./global.db",
  extensions: [Migrator],
  migrations: {
    path: "./migrations",
    pathTs: "./migrations",
    // Keep the column-rename detection conservative — the diffing
    // engine guesses; we prefer explicit `migration:create --blank`
    // edits when a rename is intentional.
    snapshot: false,
  },
});
