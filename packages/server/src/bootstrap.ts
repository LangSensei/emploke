import "reflect-metadata";
import type { DatabaseSync } from "node:sqlite";
import { composeCatalogModule } from "@emploke/catalog";
import { composeRuntimeModule } from "@emploke/runtime";
import { composeSessionModule } from "@emploke/session";
import { composeTaskModule } from "@emploke/task";
import { composeWorkspaceModule, WorkspaceDb } from "@emploke/workspace";
import { Container } from "inversify";
import { Mediator } from "mediatr-ts";
import { InversifyResolver } from "./inversify-resolver.js";

/**
 * Build the root inversify container for the server process and wire
 * the mediatr-ts dispatcher into it.
 *
 * Phase 1 of issue #135 (workspace pilot) brings real bindings into
 * the workspace module: `WorkspaceRepository` → `SqliteWorkspaceRepository`,
 * `WorkspaceQueries` → `SqliteWorkspaceQueries`, plus the 4 command
 * handlers + manual mediator registration. The other `compose…Module`
 * calls remain empty stubs (session / task / catalog / runtime
 * refactors land in Phases 3-7).
 *
 * ## Pre-compose prerequisites
 *
 * The composition root binds shared services **before** calling any
 * `compose…Module`:
 *   - `Mediator` — the dispatcher itself.
 *   - `WorkspaceDb` — the `DatabaseSync` for `global.db`, already
 *     coordinator-migrated to the version the workspace pkg expects.
 *
 * Future shared bindings (`Logger`, a global outbox handle, etc.) slot
 * in here too — every compose call sees them.
 */
export function buildServerContainer(opts: { workspaceDb: DatabaseSync }): Container {
  const container = new Container();
  const resolver = new InversifyResolver(container);
  const mediator = new Mediator({ resolver });
  container.bind(Mediator).toConstantValue(mediator);
  container.bind(WorkspaceDb).toConstantValue(opts.workspaceDb);

  // Per-module bindings + manual mediator registration. Order
  // doesn't matter today because mediator dispatch is late-bound; if
  // a future binding ever needs a sibling-context service at compose
  // time, revisit.
  composeWorkspaceModule(container);
  composeSessionModule(container);
  composeTaskModule(container);
  composeCatalogModule(container);
  composeRuntimeModule(container);

  return container;
}
