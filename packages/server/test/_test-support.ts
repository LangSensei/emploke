import path from "node:path";
import type { Database as BetterSqliteDatabase } from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { Logger } from "@emploke/logger";
import { CopilotRuntime, RuntimeRegistry } from "@emploke/runtime";
import type {
  WorkspaceQueries,
  WorkspaceService,
} from "@emploke/workspace";
import { openTestWorkspaceDb } from "@emploke/workspace/testing";
import { buildServerContainer } from "../src/bootstrap.js";
import { PerWorkspaceContainerCache } from "../src/per-workspace-container.js";

/**
 * Shared scaffolding for server-side tests.
 *
 * Post de-DDD + @emploke/core extraction: workspaces are mutated
 * through the workspace service exposed on the core composition.
 * The per-workspace runtime cache opens its own DB connections internally.
 */
export interface ServerTestSubsystem {
  readonly db: BetterSQLite3Database<Record<string, never>>;
  readonly sqlite: BetterSqliteDatabase;
  readonly service: WorkspaceService;
  readonly queries: WorkspaceQueries;
  readonly runtimeRegistry: RuntimeRegistry;
  readonly cache: PerWorkspaceContainerCache;
  readonly defaultWorkspaceParent: string;
}

export async function setupTestSubsystem(opts: {
  scratch: string;
  logger?: Logger;
}): Promise<ServerTestSubsystem> {
  const handle = openTestWorkspaceDb();
  const runtimeRegistry = new RuntimeRegistry();
  runtimeRegistry.register(
    new CopilotRuntime({ copilotConfigPath: path.join(opts.scratch, "copilot-config.json") }),
  );
  const composition = await buildServerContainer({
    workspace: { db: handle.db },
    runtimeRegistry,
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
  });
  const defaultWorkspaceParent = path.join(opts.scratch, "default-workspaces");
  return {
    db: handle.db as unknown as BetterSQLite3Database<Record<string, never>>,
    sqlite: handle.sqlite,
    service: composition.workspaceService,
    queries: composition.workspaceQueries,
    runtimeRegistry,
    cache: composition.runtimes as PerWorkspaceContainerCache,
    defaultWorkspaceParent,
  };
}

export async function teardownTestSubsystem(sys: ServerTestSubsystem): Promise<void> {
  try {
    await sys.cache.closeAll();
  } catch {
    // best-effort
  }
  try {
    sys.sqlite.close();
  } catch {
    // best-effort
  }
}

export async function registerTestWorkspace(
  sys: ServerTestSubsystem,
  args: { id: string; workspaceDir: string; name: string },
): Promise<string> {
  const result = await sys.service.register({
    id: args.id,
    workspaceDir: args.workspaceDir,
    name: args.name,
  });
  return result.id;
}
