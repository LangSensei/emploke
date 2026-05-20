import "reflect-metadata";
import type { MikroORM } from "@mikro-orm/core";
import { Container } from "inversify";
import { Mediator } from "mediatr-ts";
import {
  composeWorkspaceModule,
  RegisterWorkspaceCommand,
  WorkspaceQueries,
} from "../src/index.js";
import { openTestWorkspaceOrm } from "../src/testing.js";

/**
 * Shared per-test scaffolding for the Phase 2 / MikroORM-backed
 * workspace pkg.
 *
 * After the encapsulation refactor (P1-5 follow-up), the workspace
 * pkg owns the MikroORM instance internally — the helper opens an
 * in-memory ORM, hands it to `composeWorkspaceModule({ orm })` and
 * lets the composer wire the dispatcher / context / handlers. Tests
 * that want to spy on `mediator.publish` for cross-context event
 * assertions can `vi.spyOn(mediator, "publish")` after this helper
 * returns — the subscriber is already wired so the publish call
 * happens inside `em.flush`, after the SQL write lands.
 *
 * NB: The local `TestTransactionBehavior` mirror is gone. The
 * workspace pkg's own `TransactionBehavior` (registered via the
 * side-effect import in `index.ts`) wraps every dispatch in
 * `em.transactional` — exactly what production server does. There
 * is no longer a workspace-pkg-vs-server mismatch to paper over.
 */
export interface WorkspaceTestSubsystem {
  orm: MikroORM;
  container: Container;
  mediator: Mediator;
  queries: WorkspaceQueries;
  close(): Promise<void>;
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
  const orm = await openTestWorkspaceOrm();
  const container = new Container();
  const resolver = new TestInversifyResolver(container);
  // biome-ignore lint/suspicious/noExplicitAny: resolver shape matches mediatr-ts contract
  const mediator = new Mediator({ resolver: resolver as any });
  container.bind(Mediator).toConstantValue(mediator);

  const handle = await composeWorkspaceModule(container, { orm });

  const queries = container.get(WorkspaceQueries);
  return {
    orm,
    container,
    mediator,
    queries,
    async close() {
      await handle.close();
    },
  };
}

/**
 * Tear down the subsystem. Tests should call this in `afterEach` to
 * release the `:memory:` SQLite handle and prevent identity-map
 * leakage across test files.
 */
export async function teardownWorkspaceTestSubsystem(sys: WorkspaceTestSubsystem): Promise<void> {
  // composeWorkspaceModule({ orm }) does NOT own the ORM, so close()
  // is a no-op — we close the orm we created here.
  await sys.close();
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
