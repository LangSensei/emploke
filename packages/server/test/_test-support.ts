import path from "node:path";
import type { Logger } from "@emploke/logger";
import { CopilotRuntime, RuntimeRegistry } from "@emploke/runtime";
import type {
  WorkspaceQueries,
  WorkspaceService,
} from "@emploke/workspace";
import { openTestWorkspaceOrm } from "@emploke/workspace/testing";
import type { EntityManager, MikroORM } from "@mikro-orm/core";
import type { Container } from "inversify";
import { buildServerContainer } from "../src/bootstrap.js";
import { PerWorkspaceContainerCache } from "../src/per-workspace-container.js";

/**
 * Shared scaffolding for server-side tests that build a workspace
 * subsystem against an in-memory MikroORM-managed `global.db`.
 *
 * Post de-DDD: workspaces are mutated through `service.register/.open/
 * .rename/.unregister(...)` — no mediator, no commands, no value
 * objects. The root inversify `Container` is still exposed because the
 * per-workspace container cache scaffolding (and future per-pkg
 * compose hooks) depend on it.
 */
export interface ServerTestSubsystem {
  readonly orm: MikroORM;
  readonly em: EntityManager;
  readonly container: Container;
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
  const orm = await openTestWorkspaceOrm();
  const composition = await buildServerContainer({ workspace: { orm } });
  const runtimeRegistry = new RuntimeRegistry();
  runtimeRegistry.register(
    new CopilotRuntime({ copilotConfigPath: path.join(opts.scratch, "copilot-config.json") }),
  );
  const cache = new PerWorkspaceContainerCache({
    rootContainer: composition.container,
    runtimeRegistry,
    queries: composition.queries,
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
  });
  const defaultWorkspaceParent = path.join(opts.scratch, "default-workspaces");
  return {
    orm,
    em: orm.em as EntityManager,
    container: composition.container,
    service: composition.service,
    queries: composition.queries,
    runtimeRegistry,
    cache,
    defaultWorkspaceParent,
  };
}

export async function teardownTestSubsystem(sys: ServerTestSubsystem): Promise<void> {
  try {
    sys.cache.closeAll();
  } catch {
    // best-effort
  }
  try {
    await sys.orm.close(true);
  } catch {
    // best-effort
  }
}

/**
 * Convenience: register a workspace through the service and return its
 * canonical id. Saves callers from constructing the input shape.
 */
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
