import "reflect-metadata";
import { DatabaseSync } from "node:sqlite";
import { Container } from "inversify";
import { Mediator } from "mediatr-ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  composeWorkspaceModule,
  RegisterWorkspaceCommand,
  WorkspaceDb,
  WorkspaceQueries,
} from "../../src/index.js";
import { bootstrapWorkspaceRegistryDb } from "../../src/testing.js";

const UUID_A = "11111111-1111-4111-8111-111111111111";

/**
 * Minimal inversify-backed mediatr-ts resolver — mirrors the
 * `InversifyResolver` that lives inside `@emploke/server` and
 * `@emploke/cli`. Inlined here so the workspace pkg's test doesn't
 * cross a package boundary just to share a 6-line bridge.
 */
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

let db: DatabaseSync;
let container: Container;

beforeEach(async () => {
  db = new DatabaseSync(":memory:");
  await bootstrapWorkspaceRegistryDb(db);
  container = new Container();
  const resolver = new TestInversifyResolver(container);
  // biome-ignore lint/suspicious/noExplicitAny: resolver shape matches mediatr-ts contract
  const mediator = new Mediator({ resolver: resolver as any });
  container.bind(Mediator).toConstantValue(mediator);
  container.bind(WorkspaceDb).toConstantValue(db);
  composeWorkspaceModule(container);
});

afterEach(() => {
  try {
    db.close();
  } catch {}
});

describe("composeWorkspaceModule — end-to-end wiring", () => {
  it("binds WorkspaceQueries and resolves a SqliteWorkspaceQueries instance", async () => {
    const q = container.get(WorkspaceQueries);
    expect(await q.list()).toEqual([]);
  });

  it("registers the RegisterWorkspaceCommand handler with the mediator", async () => {
    const mediator = container.get(Mediator);
    const queries = container.get(WorkspaceQueries);
    const result = await mediator.send(
      new RegisterWorkspaceCommand(UUID_A, "/tmp/emploke-wiring-test", "End-To-End"),
    );
    expect(result.id).toBe(UUID_A);
    const view = await queries.getById(UUID_A);
    expect(view?.name).toBe("End-To-End");
  });
});
