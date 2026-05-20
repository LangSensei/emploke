import "reflect-metadata";
import { EntityManager, type MikroORM } from "@mikro-orm/core";
import { Container, inject, injectable } from "inversify";
import { Mediator, type PipelineBehavior, pipelineBehavior, type RequestData } from "mediatr-ts";
import {
  composeWorkspaceModule,
  RegisterWorkspaceCommand,
  WorkspaceQueries,
} from "../src/index.js";
import { openTestWorkspaceOrm } from "../src/testing.js";

/**
 * Local mirror of `@emploke/server`'s `TransactionBehavior`. Lives in
 * the workspace pkg's test-support so the workspace pkg can be tested
 * end-to-end (mediator dispatch → em.transactional → em.flush →
 * DomainEventSubscriber → published events) without taking a runtime
 * dependency on `@emploke/server`. The production server uses the
 * server-pkg copy, which is byte-identical in behaviour.
 */
@injectable()
export class TestTransactionBehavior implements PipelineBehavior {
  constructor(@inject(EntityManager) private readonly em: EntityManager) {}

  async handle(_req: RequestData<unknown>, next: () => unknown): Promise<unknown> {
    return this.em.transactional(async () => next());
  }
}
// Register the behaviour at module load (mediatr-ts's
// `typeMappings.pipelineBehaviors` is a module-level singleton, so
// the registration is process-wide and only fires once thanks to ESM
// caching).
(pipelineBehavior() as ClassDecorator)(TestTransactionBehavior);

/**
 * Shared per-test scaffolding for the Phase 2 / MikroORM-backed
 * workspace pkg. Creates a fresh `:memory:` MikroORM, an inversify
 * container with `Mediator` + `EntityManager` + the workspace
 * compose-call wired, and registers the `DomainEventSubscriber` with
 * the ORM so domain events flow through the mediator.
 *
 * Tests that want to spy on `mediator.publish` for cross-context
 * event assertions can `vi.spyOn(mediator, "publish")` after this
 * helper returns — the subscriber is already wired so the publish
 * call happens inside `em.flush`, after the SQL write lands.
 */
export interface WorkspaceTestSubsystem {
  orm: MikroORM;
  container: Container;
  mediator: Mediator;
  queries: WorkspaceQueries;
}

class TestInversifyResolver {
  constructor(private readonly container: Container) {}
  resolve<T>(type: new (...args: unknown[]) => T): T {
    return this.container.get(type);
  }
  add<T>(type: new (...args: unknown[]) => T): void {
    if (this.container.isBound(type)) return;
    this.container.bind(type).toSelf();
  }
}

export async function setupWorkspaceTestSubsystem(): Promise<WorkspaceTestSubsystem> {
  const { DomainEventSubscriber } = await import("../src/index.js");

  const orm = await openTestWorkspaceOrm();
  const container = new Container();
  const resolver = new TestInversifyResolver(container);
  // biome-ignore lint/suspicious/noExplicitAny: resolver shape matches mediatr-ts contract
  const mediator = new Mediator({ resolver: resolver as any });
  container.bind(Mediator).toConstantValue(mediator);
  container.bind(EntityManager).toConstantValue(orm.em as EntityManager);

  composeWorkspaceModule(container);

  // Wire the DomainEventSubscriber into the ORM so flush triggers
  // event dispatch — mirrors what the server's bootstrap does in
  // production.
  orm.em.getEventManager().registerSubscriber(container.get(DomainEventSubscriber));

  const queries = container.get(WorkspaceQueries);
  return { orm, container, mediator, queries };
}

/**
 * Tear down the subsystem. Tests should call this in `afterEach` to
 * release the `:memory:` SQLite handle and prevent identity-map
 * leakage across test files.
 */
export async function teardownWorkspaceTestSubsystem(sys: WorkspaceTestSubsystem): Promise<void> {
  await sys.orm.close(true);
}

/**
 * Convenience: dispatch a `RegisterWorkspaceCommand`. Wraps the
 * common test boilerplate so tests can stay terse.
 */
export async function registerTestWorkspace(
  sys: WorkspaceTestSubsystem,
  args: { id: string; workspaceDir: string; name: string },
): Promise<string> {
  const result = await sys.mediator.send(
    new RegisterWorkspaceCommand(args.id, args.workspaceDir, args.name),
  );
  return result.id;
}
