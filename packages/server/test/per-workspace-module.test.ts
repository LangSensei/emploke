/**
 * End-to-end architecture validation for `composePerWorkspaceModule`.
 *
 * Boots a parent + child container pair and asserts:
 *
 * 1. The shared `TransactionBehavior` wraps a child-Mediator dispatch
 *    in `uow.em.transactional` against the CHILD EM (workspace.db),
 *    not the parent's. Persisted rows land in the right DB.
 * 2. Domain events fired by aggregates publish through the CHILD
 *    mediator (DomainEventDispatcher subscriber resolved off child
 *    container).
 * 3. The after-commit queue drains AFTER the transaction commits.
 * 4. A rolled-back transaction DOES NOT drain after-commit callbacks.
 * 5. `dispose()` closes the per-workspace ORM cleanly.
 *
 * If this regresses, do NOT proceed with the catalog/session/task
 * DDD migration — the architecture has a hole.
 */

import { Entity, PrimaryKey, Property } from "@mikro-orm/core";
import {
  composeWorkspaceModule,
  TransactionBehavior,
  UnitOfWork,
  type WorkspaceModuleHandle,
} from "@emploke/workspace";
import { Entity as SeedworkEntity } from "@emploke/workspace/testing";
import { Container, inject, injectable } from "inversify";
import {
  Mediator,
  NotificationData,
  type NotificationHandler,
  notificationHandler,
  RequestData,
  type RequestHandler,
  requestHandler,
} from "mediatr-ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { InversifyResolver } from "../src/inversify-resolver.js";
import {
  composePerWorkspaceModule,
  type PerWorkspaceModuleHandle,
} from "../src/per-workspace-module.js";

// ── Test entity + domain event ────────────────────────────────

class ThingRecorded extends NotificationData {
  constructor(public readonly thingId: string) {
    super();
  }
}

@Entity({ tableName: "things" })
class Thing extends SeedworkEntity {
  @PrimaryKey()
  id!: string;

  @Property()
  label!: string;

  static record(id: string, label: string): Thing {
    const t = new Thing();
    t.id = id;
    t.label = label;
    t.addDomainEvent(new ThingRecorded(id));
    return t;
  }
}

// ── Command + handler + listener ──────────────────────────────

class RecordThingCommand extends RequestData<string> {
  constructor(
    public readonly id: string,
    public readonly label: string,
  ) {
    super();
  }
}

const observedNotifications: string[] = [];
const afterCommitObserved: string[] = [];

@injectable()
@requestHandler(RecordThingCommand)
class RecordThingHandler implements RequestHandler<RecordThingCommand, string> {
  constructor(@inject(UnitOfWork) private readonly uow: UnitOfWork) {}
  async handle(cmd: RecordThingCommand): Promise<string> {
    const thing = Thing.record(cmd.id, cmd.label);
    this.uow.em.persist(thing);
    this.uow.enqueueAfterCommit(() => {
      afterCommitObserved.push(`after:${cmd.id}`);
    });
    return cmd.id;
  }
}

@injectable()
@notificationHandler(ThingRecorded)
class ThingRecordedListener implements NotificationHandler<ThingRecorded> {
  async handle(evt: ThingRecorded): Promise<void> {
    observedNotifications.push(evt.thingId);
  }
}

// ── Test ──────────────────────────────────────────────────────

describe("composePerWorkspaceModule (architecture integration)", () => {
  let parentHandle: WorkspaceModuleHandle;
  let parentContainer: Container;
  let childHandle: PerWorkspaceModuleHandle;

  beforeAll(async () => {
    // Touch the side-effect import so vitest's tree-shaker doesn't
    // strip the @pipelineBehavior() decorator on TransactionBehavior.
    void TransactionBehavior;

    parentContainer = new Container();
    const parentMediator = new Mediator({
      resolver: new InversifyResolver(parentContainer),
    });
    parentContainer.bind(Mediator).toConstantValue(parentMediator);
    // Compose the workspace pkg's own module against an in-memory
    // global.db so the root container is wired the same way prod is.
    // This binds parent's WorkspaceContext + UnitOfWork to the
    // global.db EM — child will OVERRIDE these.
    parentHandle = await composeWorkspaceModule(parentContainer, {
      dbFile: ":memory:",
    });

    childHandle = await composePerWorkspaceModule({
      parentContainer,
      dbPath: ":memory:",
      entities: [Thing],
    });
    // Build the test schema on the child orm (tests bypass MigrationCoordinator).
    await childHandle.orm.schema.createSchema();
    // Register the child-side handler + listener on the child
    // container so the child Mediator can resolve them via its
    // InversifyResolver.
    childHandle.childContainer.bind(RecordThingHandler).toSelf();
    childHandle.childContainer.bind(ThingRecordedListener).toSelf();
  });

  afterAll(async () => {
    await childHandle.dispose();
    await parentHandle.close();
  });

  it("dispatches via child Mediator into the per-workspace EM", async () => {
    const id = await childHandle.mediator.send(new RecordThingCommand("t1", "alpha"));
    expect(id).toBe("t1");

    const row = await childHandle.orm.em.fork().findOne(Thing, { id: "t1" });
    expect(row).not.toBeNull();
    expect(row?.label).toBe("alpha");
  });

  it("publishes domain events through the CHILD mediator", () => {
    expect(observedNotifications).toContain("t1");
  });

  it("drains after-commit queue after em.transactional commits", () => {
    expect(afterCommitObserved).toEqual(["after:t1"]);
  });

  it("does NOT drain after-commit when the transaction rolls back", async () => {
    const before = afterCommitObserved.length;
    await expect(
      // Re-using PK forces a unique-violation on flush → rollback.
      childHandle.mediator.send(new RecordThingCommand("t1", "beta")),
    ).rejects.toThrow();
    expect(afterCommitObserved.length).toBe(before);
  });
});
