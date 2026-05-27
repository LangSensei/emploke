/**
 * PR 1 of #61: `ListTaskOpts.scheduleId` filters to tasks whose
 * `metadata.scheduleId` matches the given value. AND-composes with
 * the other filters — in particular with `origin`, which is the
 * common dashboard combination ("recent fires for this schedule").
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskEntity } from "../src/task-entity.js";
import { TaskRepository } from "../src/task-repository.js";
import { openTestTaskDb } from "../src/testing.js";
import type { TaskOrigin } from "../src/types.js";

let orm: ReturnType<typeof openTestTaskDb>;
let repo: TaskRepository;

beforeEach(() => {
  orm = openTestTaskDb();
  repo = new TaskRepository({ db: orm.db });
});
afterEach(() => {
  orm.close();
});

async function seed(id: string, origin: TaskOrigin, scheduleId: string | null): Promise<void> {
  await repo.save(
    TaskEntity.fromStored({
      id,
      agent: "demo",
      brief: "b",
      origin,
      status: "running",
      metadata: scheduleId === null ? {} : { scheduleId },
      createdAt: "2026-05-19T01:00:00.000Z",
      startedAt: "2026-05-19T01:00:00.000Z",
    }),
  );
}

describe("TaskRepository.list — scheduleId filter", () => {
  beforeEach(async () => {
    await seed("20260519-aaaaaaaa", "schedule", "sched-A");
    await seed("20260519-bbbbbbbb", "schedule", "sched-B");
    await seed("20260519-cccccccc", "standalone", null);
  });

  it("scheduleId filter selects only tasks with the matching metadata.scheduleId", async () => {
    const matching = await repo.list({ scheduleId: "sched-A" });
    expect(matching.map((t) => t.id)).toEqual(["20260519-aaaaaaaa"]);
  });

  it("scheduleId combined with origin='schedule' returns the same matching set", async () => {
    const matching = await repo.list({ scheduleId: "sched-A", origin: "schedule" });
    expect(matching.map((t) => t.id)).toEqual(["20260519-aaaaaaaa"]);
  });

  it("scheduleId combined with origin='standalone' returns empty (AND semantics)", async () => {
    const matching = await repo.list({ scheduleId: "sched-A", origin: "standalone" });
    expect(matching).toEqual([]);
  });

  it("scheduleId with no matches returns empty", async () => {
    const matching = await repo.list({ scheduleId: "sched-unknown" });
    expect(matching).toEqual([]);
  });

  it("omitting scheduleId returns rows of every origin (filter disabled)", async () => {
    const all = await repo.list();
    expect(all.map((t) => t.id).sort()).toEqual([
      "20260519-aaaaaaaa",
      "20260519-bbbbbbbb",
      "20260519-cccccccc",
    ]);
  });
});
