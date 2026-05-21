import { defineConfig } from "@mikro-orm/better-sqlite";
import { Migrator } from "@mikro-orm/migrations";
import { Session } from "./src/entity.js";

/**
 * MikroORM CLI / runtime config for the session pkg's slice of the
 * per-workspace `workspace.db`. The session pkg owns the `sessions`
 * table; other pkgs (task, catalog_*) own their own tables in the
 * same file.
 */
export default defineConfig({
  entities: [Session],
  dbName: process.env.EMPLOKE_WORKSPACE_DB_PATH || "./workspace.db",
  extensions: [Migrator],
  migrations: {
    path: "./dist/migrations",
    pathTs: "./src/migrations",
    snapshot: false,
  },
});
