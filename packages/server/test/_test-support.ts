import "reflect-metadata";
import path from "node:path";
import type { Logger } from "@emploke/logger";
import { CopilotRuntime, RuntimeRegistry } from "@emploke/runtime";
import { WorkspaceQueries } from "@emploke/workspace";
import {
  openTestWorkspaceOrm,
  Workspace,
  WorkspaceDir,
  WorkspaceId,
  WorkspaceName,
} from "@emploke/workspace/testing";
import type { EntityManager, MikroORM } from "@mikro-orm/core";
import type { Container } from "inversify";
import { Mediator } from "mediatr-ts";
import { buildServerContainer } from "../src/bootstrap.js";
import { PerWorkspaceContainerCache } from "../src/per-workspace-container.js";

/**
 * Shared scaffolding for server-side tests that build a workspace
 * subsystem against an in-memory MikroORM-managed `global.db`. Phase
 * 2 / ADR-3 (#139) replaces the previous `DatabaseSync` +
 * `bootstrapWorkspaceRegistryDb` helper with a MikroORM `:memory:`
 * instance opened via `openTestWorkspaceOrm()`.
 *
 * Call `setupTestSubsystem({ scratch })`; the helper builds:
 *   - the root inversify container (binds Mediator, EntityManager,
 *     workspace pkg's repositories / handlers / queries, registers
 *     the workspace pkg bindings, installs
 *     TransactionBehavior)
 *   - a `CopilotRuntime`-only `RuntimeRegistry`
 *   - the per-workspace container cache
 * and returns everything the tests need.
 */
export interface ServerTestSubsystem {
  readonly orm: MikroORM;
  readonly em: EntityManager;
  readonly container: Container;
  readonly mediator: Mediator;
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
  const container = buildServerContainer({ globalOrm: orm });
  const mediator = container.get(Mediator);
  const queries = container.get(WorkspaceQueries);
  // `buildServerContainer` already registers the
  // `WorkspaceContext.saveEntities` already wires event dispatch, but our tests build many subsystems in
  // the same process — re-register so the per-test ORM instance has
  // its own subscriber wired. Idempotent.
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
  return {
    orm,
    em: orm.em as EntityManager,
    container,
    mediator,
    queries,
    runtimeRegistry,
    cache,
    defaultWorkspaceParent,
  };
}

/**
 * Tear down the subsystem. Closes the per-workspace cache (releases
 * SQLite handles on workspace.db files) AND the global ORM. Tests
 * MUST call this in afterEach so Windows can `rm -rf` the scratch
 * directory.
 */
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
 * Re-exports for tests that need direct access to the aggregate /
 * value objects. The legacy `bootstrapWorkspaceRegistryDb` helper is
 * gone — tests that previously imported it now use
 * {@link setupTestSubsystem} (which opens MikroORM internally).
 */
export { Workspace, WorkspaceDir, WorkspaceId, WorkspaceName };
