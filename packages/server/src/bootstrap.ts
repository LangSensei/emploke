import "reflect-metadata";
import { composeCatalogModule } from "@emploke/catalog";
import { composeRuntimeModule } from "@emploke/runtime";
import { composeSessionModule } from "@emploke/session";
import { composeTaskModule } from "@emploke/task";
import { composeWorkspaceModule, DomainEventSubscriber } from "@emploke/workspace";
import { EntityManager, type MikroORM } from "@mikro-orm/core";
import { Container } from "inversify";
import { Mediator } from "mediatr-ts";
import { TransactionBehavior } from "./infrastructure/transaction-behavior.js";
import { InversifyResolver } from "./inversify-resolver.js";

/**
 * Build the root inversify container for the server process and wire
 * the mediatr-ts dispatcher into it.
 *
 * Phase 2 of issue #135 / ADR-3 (#139) pivoted the workspace pkg to
 * MikroORM. The composition root opens a `MikroORM` instance against
 * `global.db` and passes it here so we can bind the canonical
 * {@link EntityManager} token, register the
 * {@link DomainEventSubscriber} with the ORM (so it fires on every
 * flush), and install the cross-cutting
 * {@link TransactionBehavior} on the mediator's pipeline.
 *
 * Other `compose…Module` calls (`session` / `task` / `catalog` /
 * `runtime`) remain empty stubs — Phase 3-7 lands their MikroORM
 * pivots.
 *
 * ## Pre-compose prerequisites
 *
 * The composition root binds shared services **before** calling any
 * `compose…Module`:
 *   - `Mediator` — the dispatcher itself.
 *   - `EntityManager` — the global-scope `MikroORM` EM for
 *     `global.db`, already migrated to the version the workspace
 *     pkg expects (the bootstrap runs `orm.migrator.up()` or
 *     `orm.schema.updateSchema` before this is called).
 *
 * ## Pipeline behaviour registration
 *
 * `TransactionBehavior` is imported above (transitively pulling in
 * the `@pipelineBehavior()` decorator that registers it on the
 * mediatr-ts module-level singleton). The `new Mediator({ resolver })`
 * call below walks `typeMappings.pipelineBehaviors` in its constructor
 * and calls `resolver.add(TransactionBehavior)` — which our
 * `InversifyResolver` translates to a `container.bind(...).toSelf()`
 * binding. From that point on every `mediator.send(...)` is wrapped
 * in `em.transactional`.
 *
 * Future shared bindings (`Logger`, a global outbox handle, etc.)
 * slot in here too — every compose call sees them.
 */
export function buildServerContainer(opts: { globalOrm: MikroORM }): Container {
  // Touch the class so esbuild / Vitest cannot tree-shake the
  // decorator side-effect. `TransactionBehavior`'s `@pipelineBehavior()`
  // decorator must run before `new Mediator(...)` below, otherwise the
  // mediator's resolver-prefetch loop misses it.
  void TransactionBehavior;

  const container = new Container();
  const resolver = new InversifyResolver(container);
  const mediator = new Mediator({ resolver });
  container.bind(Mediator).toConstantValue(mediator);
  container.bind(EntityManager).toConstantValue(opts.globalOrm.em as EntityManager);

  // Per-module bindings + manual mediator registration. Order
  // doesn't matter today because mediator dispatch is late-bound; if
  // a future binding ever needs a sibling-context service at compose
  // time, revisit.
  composeWorkspaceModule(container);
  composeSessionModule(container);
  composeTaskModule(container);
  composeCatalogModule(container);
  composeRuntimeModule(container);

  // Register the workspace pkg's `DomainEventSubscriber` with the ORM
  // AFTER `composeWorkspaceModule` has bound it (so `container.get`
  // here succeeds). The subscriber instance is now durable: every
  // future `em.flush` (on the root EM and any fork) fires its
  // `afterFlush` hook.
  opts.globalOrm.em.getEventManager().registerSubscriber(container.get(DomainEventSubscriber));

  return container;
}
