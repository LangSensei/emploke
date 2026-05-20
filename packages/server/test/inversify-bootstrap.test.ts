import "reflect-metadata";
import { DatabaseSync } from "node:sqlite";
import { Mediator } from "mediatr-ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServerContainer } from "../src/bootstrap.js";
import { bootstrapWorkspaceRegistryDb } from "./_test-support.js";

let globalDb: DatabaseSync;

beforeEach(async () => {
  globalDb = new DatabaseSync(":memory:");
  await bootstrapWorkspaceRegistryDb(globalDb);
});

afterEach(() => {
  try {
    globalDb.close();
  } catch {
    // already closed
  }
});

describe("inversify bootstrap (Phase 1 of #135)", () => {
  it("constructs a container with the mediator wired", () => {
    const container = buildServerContainer({ workspaceDb: globalDb });
    const mediator = container.get(Mediator);
    expect(mediator).toBeInstanceOf(Mediator);
  });

  it("calls every package's composeXxxModule without throwing", () => {
    expect(() => buildServerContainer({ workspaceDb: globalDb })).not.toThrow();
  });

  it("returns a fresh container per call (no hidden process-wide singleton)", () => {
    const a = buildServerContainer({ workspaceDb: globalDb });
    const b = buildServerContainer({ workspaceDb: globalDb });
    expect(a).not.toBe(b);
    expect(a.get(Mediator)).not.toBe(b.get(Mediator));
  });
});
