import { composeCatalogModule } from "@emploke/catalog";
import { composeRuntimeModule } from "@emploke/runtime";
import { composeSessionModule } from "@emploke/session";
import { composeTaskModule } from "@emploke/task";
import {
  composeWorkspaceModule,
  type WorkspaceModule,
  type WorkspaceModuleOptions,
  type WorkspaceQueries,
  type WorkspaceService,
} from "@emploke/workspace";
import { Container } from "inversify";

/**
 * Build the server-process composition root.
 *
 * Post-de-DDD (this branch): the workspace package no longer uses
 * inversify, mediatr, or pipeline behaviours. It exposes a plain
 * `WorkspaceService` + `WorkspaceQueries` pair via `composeWorkspaceModule`,
 * and the service wraps each method in `em.transactional(...)` directly.
 * The server simply forwards HTTP requests to service methods — no
 * command/handler indirection.
 *
 * The root inversify `Container` is retained as scaffolding for the
 * per-workspace child containers (`PerWorkspaceContainerCache`) and the
 * still-empty `compose…Module(container)` calls on session / task /
 * catalog / runtime. Those Phase-0 stubs will be removed when those
 * packages get their own simplification pass.
 */
export interface ServerComposition {
  readonly container: Container;
  readonly service: WorkspaceService;
  readonly queries: WorkspaceQueries;
  /** Closes the workspace ORM opened internally by compose. Idempotent. */
  close(): Promise<void>;
}

export async function buildServerContainer(opts: {
  workspace: WorkspaceModuleOptions;
}): Promise<ServerComposition> {
  const container = new Container();

  const workspaceModule: WorkspaceModule = await composeWorkspaceModule(opts.workspace);

  // Phase-0 placeholder modules — no-op today, still called so future
  // phases can grow them without touching bootstrap wiring.
  composeSessionModule(container);
  composeTaskModule(container);
  composeCatalogModule(container);
  composeRuntimeModule(container);

  return {
    container,
    service: workspaceModule.service,
    queries: workspaceModule.queries,
    async close() {
      await workspaceModule.close();
    },
  };
}
