import "reflect-metadata";
import { composeCatalogModule } from "@emploke/catalog";
import { composeRuntimeModule } from "@emploke/runtime";
import { composeSessionModule } from "@emploke/session";
import { composeTaskModule } from "@emploke/task";
import {
  composeWorkspaceModule,
  TransactionBehavior,
  type WorkspaceModuleHandle,
  type WorkspaceModuleOptions,
} from "@emploke/workspace";
import { Container } from "inversify";
import { Mediator } from "mediatr-ts";
import { InversifyResolver } from "./inversify-resolver.js";

/**
 * Build the root inversify container for the server process and wire
 * the mediatr-ts dispatcher into it.
 *
 * After the P1-5 / encapsulation refactor, the **workspace package
 * owns its MikroORM instance**: callers pass a {@link WorkspaceModuleOptions}
 * (typically `{ dbFile }` for production, `{ orm }` for tests) and
 * the composer internally opens the ORM, registers the
 * `DomainEventDispatcher` on its event manager, and binds a
 * `WorkspaceContext` (the EM wrapper) into the container. The server
 * never imports `EntityManager` / `WORKSPACE_ENTITIES` /
 * `DomainEventDispatcher` directly anymore.
 *
 * Other `compose…Module` calls (`session` / `task` / `catalog` /
 * `runtime`) remain empty stubs — Phase 3-7 lands their analogous
 * MikroORM pivots, each with its own per-context EM (ADR-4).
 *
 * ## Pre-compose prerequisites
 *   - The composition root binds `Mediator` before any
 *     `compose…Module` call (so handlers + behaviours that
 *     `@inject(Mediator)` resolve cleanly).
 *
 * ## Pipeline behaviour registration
 *
 * `TransactionBehavior` is re-exported from `@emploke/workspace` (it
 * owns the workspace context's EM, per ADR-4 issue #141). Importing
 * it via the workspace pkg's index triggers the side-effect import
 * of `application/behaviors/transaction-behavior.js`, which runs the
 * `@pipelineBehavior()` decorator and registers the class on the
 * mediatr-ts module-level singleton. The `new Mediator({ resolver })`
 * call below walks `typeMappings.pipelineBehaviors` in its constructor
 * and calls `resolver.add(TransactionBehavior)` — which our
 * `InversifyResolver` translates to a `container.bind(...).toSelf()`
 * binding. From that point on every `mediator.send(...)` is wrapped
 * in `em.transactional`.
 *
 * Phase 3+ adds analogous TransactionBehaviour classes inside the
 * session / task / catalog pkgs (each bound to its own per-context
 * EM token under ADR-4). They'll get re-exported through their pkg
 * indexes the same way.
 */
export interface ServerComposition {
  readonly container: Container;
  /**
   * Closes anything composeXxxModule opened internally (today: just
   * the workspace pkg's MikroORM instance for `global.db`). Idempotent
   * within reason — call once during graceful shutdown.
   */
  close(): Promise<void>;
}

export async function buildServerContainer(opts: {
  workspace: WorkspaceModuleOptions;
}): Promise<ServerComposition> {
  // Touch the class so esbuild / Vitest cannot tree-shake the
  // workspace pkg's side-effect import of transaction-behavior.ts.
  // The `@pipelineBehavior()` decorator must run before `new Mediator(...)`
  // below, otherwise the mediator's resolver-prefetch loop misses it.
  void TransactionBehavior;

  const container = new Container();
  const resolver = new InversifyResolver(container);
  const mediator = new Mediator({ resolver });
  container.bind(Mediator).toConstantValue(mediator);

  // Per-module bindings + manual mediator registration. Order
  // doesn't matter today because mediator dispatch is late-bound; if
  // a future binding ever needs a sibling-context service at compose
  // time, revisit.
  const workspaceHandle: WorkspaceModuleHandle = await composeWorkspaceModule(
    container,
    opts.workspace,
  );
  composeSessionModule(container);
  composeTaskModule(container);
  composeCatalogModule(container);
  composeRuntimeModule(container);

  return {
    container,
    async close() {
      await workspaceHandle.close();
    },
  };
}
