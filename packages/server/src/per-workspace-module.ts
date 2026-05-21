import { defineConfig } from "@mikro-orm/better-sqlite";
import { type EntityClass, EntityManager, MikroORM } from "@mikro-orm/core";
import type { EventSubscriber } from "@mikro-orm/core";
import { type Logger, silentLogger } from "@emploke/logger";
import { DomainEventDispatcher, UnitOfWork } from "@emploke/workspace";
import { WorkspaceContext } from "@emploke/workspace/testing";
import { Container } from "inversify";
import { Mediator } from "mediatr-ts";
import { InversifyResolver } from "./inversify-resolver.js";

/**
 * Composes a per-workspace inversify subtree on top of a parent
 * container. Every bounded context that lives in `workspace.db`
 * (catalog / session / task today; future BCs the same way) plugs
 * into the returned `childContainer` via its own `composeXxxModule`
 * function.
 *
 * ## Bindings on the child container
 *
 * The child container is created with `new Container({ parent })`
 * so it inherits every root-scope binding (CommandValidator
 * multi-bindings, runtime registry, clock, loggers, …) AND THEN
 * OVERRIDES the per-workspace-sensitive tokens so handlers resolved
 * through the child Mediator see the per-workspace world:
 *
 *   - `EntityManager`           → the workspace.db EM (parent has global.db)
 *   - `WorkspaceContext`        → a fresh wrapper around that EM
 *   - `UnitOfWork`              → same instance as WorkspaceContext
 *     (the shared `TransactionBehavior` injects this token)
 *   - `DomainEventDispatcher`   → a new singleton bound to the child
 *     Mediator (so events fired during child commands publish through
 *     the child's handler graph, never leaking into the root world)
 *   - `Mediator`                → a brand-new `Mediator` instance with
 *     its own `InversifyResolver(childContainer)`. Per-Mediator
 *     resolver materialisation is what makes the same
 *     `TransactionBehavior` class wrap parent commands with the root
 *     UoW and child commands with the per-workspace UoW — verified by
 *     `test/per-mediator-uow-spike.test.ts`.
 *
 * ## After-flush event dispatch
 *
 * The new `DomainEventDispatcher` is registered as a `beforeFlush`
 * subscriber on the workspace.db EM's event manager — so any
 * `em.flush()` (typically the implicit flush at the end of
 * `em.transactional` inside `TransactionBehavior`) auto-drains buffered
 * domain events from every tracked aggregate via
 * `mediator.publish(...)`. A throwing notification handler rolls back
 * the transaction (writes never become visible).
 *
 * ## What this composer does NOT do
 *
 * - **Schema management** — caller has already run the hand-rolled
 *   `MigrationCoordinator` against the SQLite file. We pass
 *   `allowGlobalContext: true` and never call `orm.schema.updateSchema()`.
 *   Eventual ORM-native migrations are a separate PR.
 * - **BC composition** — caller wires `composeCatalogModule(child)`,
 *   `composeSessionModule(child)`, `composeTaskModule(child)`
 *   themselves. Keeps the helper BC-agnostic so adding a new BC is
 *   just a new composer call at the call-site, not a change here.
 *
 * ## Disposal
 *
 * `dispose()` closes the ORM (which closes the underlying SQLite
 * connection) and `unbindAll()`s the child container so the cache
 * eviction path doesn't leak per-workspace state across reloads.
 * Idempotent within reason — calling twice on the same handle throws
 * from the inversify side.
 */
export interface PerWorkspaceModuleOptions {
  /** Root container the child inherits from. */
  parentContainer: Container;
  /** Absolute path to the workspace's SQLite DB file. */
  dbPath: string;
  /**
   * Concatenated entity classes from every BC that lives in this
   * workspace.db (catalog + session + task today). One MikroORM per
   * workspace, not one per BC — keeps em.transactional honest across
   * BC boundaries.
   */
  entities: EntityClass<unknown>[];
  /** Logger forwarded to ORM driver options + the dispatcher. Defaults to silentLogger. */
  logger?: Logger;
}

export interface PerWorkspaceModuleHandle {
  readonly childContainer: Container;
  readonly mediator: Mediator;
  readonly orm: MikroORM;
  readonly uow: UnitOfWork;
  dispose(): Promise<void>;
}

export async function composePerWorkspaceModule(
  opts: PerWorkspaceModuleOptions,
): Promise<PerWorkspaceModuleHandle> {
  const logger = opts.logger ?? silentLogger;

  // 1. Open the per-workspace MikroORM. allowGlobalContext: true is
  //    fine — we never use the global context; em.transactional()
  //    forks the EM via AsyncLocalStorage so handlers always see a
  //    request-scoped fork.
  const orm = await MikroORM.init(
    defineConfig({
      entities: opts.entities,
      dbName: opts.dbPath,
      allowGlobalContext: true,
    }),
  );

  // 2. Child container with overrides. inversify v7 `parent`
  //    option means lookups fall through to parent unless the child
  //    has its own binding for the token — same shape as a v6
  //    `parent.createChild()`.
  const childContainer: Container = new Container({ parent: opts.parentContainer });

  // 3. Override EntityManager so any @inject(EntityManager) inside
  //    child handlers / repositories resolves to workspace.db, not
  //    global.db. Required because parent's composeWorkspaceModule
  //    bound EntityManager to global.db EM.
  childContainer.bind(EntityManager).toConstantValue(orm.em as EntityManager);

  // 4. WorkspaceContext + UnitOfWork bound to the same instance.
  //    The shared TransactionBehavior @injects UnitOfWork; child
  //    handlers / repos that want the concrete handle can inject
  //    WorkspaceContext for the sqlEm escape hatch.
  const uow = new WorkspaceContext(orm.em as EntityManager);
  childContainer.bind(WorkspaceContext).toConstantValue(uow);
  childContainer.bind(UnitOfWork).toConstantValue(uow);

  // 5. Domain event dispatcher singleton on the child so it resolves
  //    the CHILD mediator (bound below) — events from child commands
  //    never bubble through the root Mediator's handler graph.
  childContainer.bind(DomainEventDispatcher).toSelf().inSingletonScope();

  // 6. Per-workspace Mediator with its own InversifyResolver. This is
  //    the lynchpin: per-Mediator resolver materialisation = per-
  //    Mediator behavior dependency injection (see
  //    per-mediator-uow-spike.test.ts).
  const childMediator = new Mediator({ resolver: new InversifyResolver(childContainer) });
  childContainer.bind(Mediator).toConstantValue(childMediator);

  // 7. Register the dispatcher AFTER the child Mediator is bound, so
  //    the singleton resolved here has the right mediator wired in.
  const dispatcher = childContainer.get(DomainEventDispatcher);
  orm.em.getEventManager().registerSubscriber(dispatcher as EventSubscriber);

  logger.debug(
    { dbPath: opts.dbPath, entities: opts.entities.length },
    "per-workspace module composed",
  );

  return {
    childContainer,
    mediator: childMediator,
    orm,
    uow,
    async dispose() {
      try {
        await orm.close(true);
      } catch (err) {
        logger.warn({ err }, "per-workspace orm.close threw — swallowing");
      }
      try {
        childContainer.unbindAll();
      } catch (err) {
        logger.warn({ err }, "per-workspace childContainer.unbindAll threw — swallowing");
      }
    },
  };
}
