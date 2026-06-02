import path from "node:path";
import { type Application, composeApplication } from "@emploke/core";
import { CopilotRuntime, RuntimeRegistry } from "@emploke/runtime";
import type { WorkspaceService } from "@emploke/workspace";
import type { Logger } from "pino";

/**
 * Shared scaffolding for server-side tests. Builds the full `Application`
 * composition root around an in-memory workspace registry.
 */
export interface ServerTestSubsystem {
  readonly application: Application;
  readonly service: WorkspaceService;
  readonly runtimeRegistry: RuntimeRegistry;
  readonly defaultWorkspaceParent: string;
  /** Close the workspace registry's sqlite connection and every per-workspace context. */
  close(): Promise<void>;
}

export async function setupTestSubsystem(opts: {
  readonly scratch: string;
  readonly logger?: Logger;
}): Promise<ServerTestSubsystem> {
  const runtimeRegistry = new RuntimeRegistry();
  runtimeRegistry.register(
    new CopilotRuntime({ copilotConfigPath: path.join(opts.scratch, "copilot-config.json") }),
  );
  const defaultWorkspaceParent = path.join(opts.scratch, "default-workspaces");
  const composition = await composeApplication({
    workspace: { dbFile: ":memory:" },
    runtimeRegistry,
    defaultWorkspaceParent,
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
  });
  return {
    application: composition,
    service: composition.workspaceService,
    runtimeRegistry,
    defaultWorkspaceParent,
    async close() {
      await composition.close();
    },
  };
}

export async function teardownTestSubsystem(sys: ServerTestSubsystem): Promise<void> {
  try {
    // `application.close()` closes the internal per-workspace context
    // registry first, then the global registry handle. Idempotent.
    await sys.close();
  } catch {
    // best-effort
  }
}

export async function registerTestWorkspace(
  sys: ServerTestSubsystem,
  args: { readonly id: string; readonly workspaceDir: string; readonly name: string },
): Promise<string> {
  const result = await sys.service.register({
    id: args.id,
    workspaceDir: args.workspaceDir,
    name: args.name,
  });
  return result.id;
}
