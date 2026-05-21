import { defineConfig } from "@mikro-orm/better-sqlite";
import { Migrator } from "@mikro-orm/migrations";
import { Workspace } from "./src/entity.js";

/**
 * MikroORM CLI / runtime config for the `workspace` pkg's global
 * registry DB (`<EMPLOKE_HOME>/global.db` in production).
 *
 * Use `mikro-orm migration:create` / `migration:up` against this config
 * to manage schema changes.
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
    // `pathTs` is where the MikroORM CLI writes new migration files
    // (`migration:create`); `path` is where the runtime reads compiled
    // migrations from. Migrations live in their own folder because
    // they're an append-only sequence with a tool-imposed layout, not
    // because there's a "layer" called infrastructure.
    path: "./dist/migrations",
    pathTs: "./src/migrations",
    // Keep the column-rename detection conservative — the diffing
    // engine guesses; we prefer explicit `migration:create --blank`
    // edits when a rename is intentional.
    snapshot: false,
  },
});
