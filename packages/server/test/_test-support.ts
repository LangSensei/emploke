import "reflect-metadata";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Logger } from "@emploke/logger";
import { CopilotRuntime, RuntimeRegistry } from "@emploke/runtime";
import { WorkspaceQueries } from "@emploke/workspace";
import {
  bootstrapWorkspaceRegistryDb,
  Workspace,
  WorkspaceDir,
  WorkspaceId,
  WorkspaceName,
} from "@emploke/workspace/testing";
import type { Container } from "inversify";
import { Mediator } from "mediatr-ts";
import { buildServerContainer } from "../src/bootstrap.js";
import { PerWorkspaceContainerCache } from "../src/per-workspace-container.js";

/**
 * Shared scaffolding for server-side tests that build a workspace
 * subsystem against an in-memory `global.db`. Centralised so the
 * suite isn't littered with copies of the same 15 lines of container
 * + cache plumbing.
 *
 * Call `setupTestSubsystem({ globalDb, scratch })` after creating the
 * DB and bootstrapping its schema; the helper builds:
 *   - the root inversify container (binds Mediator, WorkspaceDb,
 *     workspace pkg's repositories / handlers / queries)
 *   - a `CopilotRuntime`-only `RuntimeRegistry`
 *   - the per-workspace container cache
 * and returns everything the tests need.
 */
export interface ServerTestSubsystem {
  readonly container: Container;
  readonly mediator: Mediator;
  readonly queries: WorkspaceQueries;
  readonly runtimeRegistry: RuntimeRegistry;
  readonly cache: PerWorkspaceContainerCache;
  readonly defaultWorkspaceParent: string;
}

export function setupTestSubsystem(opts: {
  globalDb: DatabaseSync;
  scratch: string;
  logger?: Logger;
}): ServerTestSubsystem {
  const container = buildServerContainer({ workspaceDb: opts.globalDb });
  const mediator = container.get(Mediator);
  const queries = container.get(WorkspaceQueries);
  const runtimeRegistry = new RuntimeRegistry();
  runtimeRegistry.register(
    new CopilotRuntime({ copilotConfigPath: path.join(opts.scratch, "copilot-config.json") }),
  );
  const cache = new PerWorkspaceContainerCache({
    rootContainer: container,
    runtimeRegistry,
    queries,
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
  });
  const defaultWorkspaceParent = path.join(opts.scratch, "default-workspaces");
  return { container, mediator, queries, runtimeRegistry, cache, defaultWorkspaceParent };
}

/**
 * Convenience: register a workspace via the mediator and return its
 * canonical id. Saves callers from re-importing the command class for
 * every test that just needs "a workspace exists".
 */
export async function registerTestWorkspace(
  sys: ServerTestSubsystem,
  args: { id: string; workspaceDir: string; name: string },
): Promise<string> {
  // Lazy import keeps the helper a leaf dep — no circular imports.
  const { RegisterWorkspaceCommand } = await import("@emploke/workspace");
  const result = await sys.mediator.send(
    new RegisterWorkspaceCommand(args.id, args.workspaceDir, args.name),
  );
  return result.id;
}

/**
 * Re-exports for tests that only need the global-db bootstrap helper.
 * Saves a separate `@emploke/workspace/testing` import line.
 */
export { bootstrapWorkspaceRegistryDb, Workspace, WorkspaceDir, WorkspaceId, WorkspaceName };
