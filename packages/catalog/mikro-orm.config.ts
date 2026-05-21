import { defineConfig } from "@mikro-orm/better-sqlite";
import { Migrator } from "@mikro-orm/migrations";
import {
  AgentFileRow,
  AgentMcpDepRow,
  AgentRow,
  AgentSkillDepRow,
  McpRow,
  SkillFileRow,
  SkillMcpDepRow,
  SkillRow,
  SkillSkillDepRow,
} from "./src/entity.js";

export default defineConfig({
  entities: [
    AgentRow,
    SkillRow,
    McpRow,
    AgentFileRow,
    SkillFileRow,
    AgentSkillDepRow,
    AgentMcpDepRow,
    SkillSkillDepRow,
    SkillMcpDepRow,
  ],
  dbName: process.env.EMPLOKE_WORKSPACE_DB_PATH || "./workspace.db",
  extensions: [Migrator],
  migrations: {
    path: "./dist/migrations",
    pathTs: "./src/migrations",
    snapshot: false,
  },
});
