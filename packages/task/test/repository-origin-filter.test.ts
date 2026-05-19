/**
 * Issue #119: SqliteTaskRepository.list accepts an `origin` filter,
 * either as a single TaskOrigin or as an array. Tasks of every other
 * origin are excluded.
 */

import { DatabaseSync } from "node:sqlite";
import { runPkgMigrationsSync } from "@emploke/workspace";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteTaskRepository, TASK_MIGRATIONS, Task } from "../src/index.js";
import type { TaskOrigin } from "../src/types.js";

let db: DatabaseSync;
let repo: SqliteTaskRepository;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  runPkgMigrationsSync(db, [{ pkg: "task", migrations: TASK_MIGRATIONS }]);
  repo = new SqliteTaskRepository({ db });
});
afterEach(() => {
  db.close();
});

async function seed(id: string, origin: TaskOrigin): Promise<void> {
  await repo.save(
    Task.fromStored({
      id,
      agent: "demo",
      brief: "b",
      origin,
      status: "running",
      metadata: {},
      createdAt: "2026-05-19T01:00:00.000Z",
      startedAt: "2026-05-19T01:00:00.000Z",
    }),
  );
}

describe("SqliteTaskRepository.list — origin filter", () => {
  beforeEach(async () => {
    await seed("20260519-aaaaaaaa", "standalone");
    await seed("20260519-bbbbbbbb", "standalone");
    await seed("20260519-cccccccc", "workflow");
  });

  it("undefined origin returns every row", async () => {
    const all = await repo.list();
    expect(all.map((t) => t.id).sort()).toEqual([
      "20260519-aaaaaaaa",
      "20260519-bbbbbbbb",
      "20260519-cccccccc",
    ]);
  });

  it("single-value origin filter selects only the matching rows", async () => {
    const std = await repo.list({ origin: "standalone" });
    expect(std.map((t) => t.id).sort()).toEqual(["20260519-aaaaaaaa", "20260519-bbbbbbbb"]);
    const wf = await repo.list({ origin: "workflow" });
    expect(wf.map((t) => t.id)).toEqual(["20260519-cccccccc"]);
  });

  it("array origin filter unions the listed origins", async () => {
    const both = await repo.list({ origin: ["standalone", "workflow"] });
    expect(both).toHaveLength(3);
    const onlyWf = await repo.list({ origin: ["workflow"] });
    expect(onlyWf.map((t) => t.id)).toEqual(["20260519-cccccccc"]);
  });

  it("empty array origin filter returns every row (filter disabled)", async () => {
    const all = await repo.list({ origin: [] });
    expect(all).toHaveLength(3);
  });
});
