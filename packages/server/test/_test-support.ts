import path from "node:path";
import { CopilotRuntime, RuntimeRegistry } from "@emploke/runtime";
import type { WorkspaceService } from "@emploke/workspace";
import type { Logger } from "pino";
import { buildServerContainer } from "../src/bootstrap.js";
import type { PerWorkspaceContainerCache } from "../src/per-workspace-container.js";

/**
 * Shared scaffolding for server-side tests. Builds a `buildServerContainer`
 * around an in-memory workspace registry; the per-workspace runtime cache
 * opens its own per-workspace DB connections internally.
 */
export interface ServerTestSubsystem {
  readonly service: WorkspaceService;
  readonly runtimeRegistry: RuntimeRegistry;
  readonly cache: PerWorkspaceContainerCache;
  readonly defaultWorkspaceParent: string;
  /** Close the workspace registry's sqlite connection. */
  close(): Promise<void>;
}

export async function setupTestSubsystem(opts: {
  scratch: string;
  logger?: Logger;
}): Promise<ServerTestSubsystem> {
  const runtimeRegistry = new RuntimeRegistry();
  runtimeRegistry.register(
    new CopilotRuntime({ copilotConfigPath: path.join(opts.scratch, "copilot-config.json") }),
  );
  const composition = await buildServerContainer({
    workspace: { dbFile: ":memory:" },
    runtimeRegistry,
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
  });
  const defaultWorkspaceParent = path.join(opts.scratch, "default-workspaces");
  return {
    service: composition.workspaceService,
    runtimeRegistry,
    cache: composition.runtimes as PerWorkspaceContainerCache,
    defaultWorkspaceParent,
    async close() {
      await composition.close();
    },
  };
}

export async function teardownTestSubsystem(sys: ServerTestSubsystem): Promise<void> {
  try {
    await sys.cache.closeAll();
  } catch {
    // best-effort
  }
  try {
    await sys.close();
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
