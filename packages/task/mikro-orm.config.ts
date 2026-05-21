import { defineConfig } from "@mikro-orm/better-sqlite";
import { Migrator } from "@mikro-orm/migrations";
import { Task } from "./src/entity.js";

export default defineConfig({
  entities: [Task],
  dbName: process.env.EMPLOKE_WORKSPACE_DB_PATH || "./workspace.db",
  extensions: [Migrator],
  migrations: {
    path: "./dist/migrations",
    pathTs: "./src/migrations",
    snapshot: false,
  },
});
