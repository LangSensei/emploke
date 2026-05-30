/**
 * `TaskRepository.deleteTerminalForSchedule(scheduleId)` is the SQL
 * side of the schedule-cascade-delete feature: when the user removes
 * a schedule, every TERMINAL task with `origin = 'schedule' AND
 * metadata.scheduleId = ?` is purged in a single statement so the
 * historical task rows don't outlive the trigger that produced them.
 *
 * In-flight (non-terminal) tasks are deliberately untouched — the
 * service layer guarantees there are none via the
 * `hasInFlightForSchedule` guard (and re-checks for TOCTOU after the
 * cascade runs).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskEntity } from "../src/task-entity.js";
import { TaskRepository } from "../src/task-repository.js";
import { openTestTaskDb } from "../src/testing.js";
import type {
  TaskCancellation,
  TaskFailure,
  TaskOrigin,
  TaskStatus,
  TaskSuccess,
} from "../src/types.js";

let orm: ReturnType<typeof openTestTaskDb>;
let repo: TaskRepository;

beforeEach(() => {
  orm = openTestTaskDb();
  repo = new TaskRepository({ db: orm.db });
});
afterEach(() => {
  orm.close();
});

async function seed(args: {
  id: string;
  origin: TaskOrigin;
  status: TaskStatus;
  scheduleId?: string;
  success?: TaskSuccess;
  failure?: TaskFailure;
  cancellation?: TaskCancellation;
}): Promise<void> {
  const metadata: Record<string, unknown> = {};
  if (args.scheduleId !== undefined) metadata.scheduleId = args.scheduleId;
  await repo.save(
    TaskEntity.fromStored({
      id: args.id,
      agent: "demo",
      brief: "b",
      origin: args.origin,
      status: args.status,
      metadata,
      createdAt: "2026-05-19T01:00:00.000Z",
      startedAt: "2026-05-19T01:00:00.000Z",
      ...(args.status !== "running" ? { endedAt: "2026-05-19T02:00:00.000Z" } : {}),
      ...(args.success !== undefined ? { success: args.success } : {}),
      ...(args.failure !== undefined ? { failure: args.failure } : {}),
      ...(args.cancellation !== undefined ? { cancellation: args.cancellation } : {}),
    }),
  );
}

describe("TaskRepository.deleteTerminalForSchedule", () => {
  it("returns an empty array and is a no-op when no tasks match", async () => {
    expect(await repo.deleteTerminalForSchedule("sched-1")).toEqual([]);
  });

  it("removes every terminal status (succeeded / failed / cancelled) for the matching scheduleId", async () => {
    await seed({
      id: "20260519-aaaaaaaa",
      origin: "schedule",
      status: "succeeded",
      scheduleId: "sched-1",
      success: { output: "ok" },
    });
    await seed({
      id: "20260519-bbbbbbbb",
      origin: "schedule",
      status: "failed",
      scheduleId: "sched-1",
      failure: { kind: "internal", message: "boom" },
    });
    await seed({
      id: "20260519-cccccccc",
      origin: "schedule",
      status: "cancelled",
      scheduleId: "sched-1",
      cancellation: { kind: "user", message: "stop" },
    });
    const deleted = await repo.deleteTerminalForSchedule("sched-1");
    expect(deleted.map((t) => t.id).sort()).toEqual([
      "20260519-aaaaaaaa",
      "20260519-bbbbbbbb",
      "20260519-cccccccc",
    ]);
    // Confirm the rows are actually gone from the DB.
    expect(await repo.read("20260519-aaaaaaaa")).toBeNull();
    expect(await repo.read("20260519-bbbbbbbb")).toBeNull();
    expect(await repo.read("20260519-cccccccc")).toBeNull();
  });

  it("NEVER touches in-flight tasks — running rows are preserved even when matching scheduleId+origin", async () => {
    await seed({
      id: "20260519-aaaaaaaa",
      origin: "schedule",
      status: "succeeded",
      scheduleId: "sched-1",
      success: { output: "ok" },
    });
    await seed({
      id: "20260519-bbbbbbbb",
      origin: "schedule",
      status: "running",
      scheduleId: "sched-1",
    });
    const deleted = await repo.deleteTerminalForSchedule("sched-1");
    expect(deleted.map((t) => t.id)).toEqual(["20260519-aaaaaaaa"]);
    // The running task still exists.
    expect(await repo.read("20260519-bbbbbbbb")).not.toBeNull();
  });

  it("does NOT cross schedule boundaries — only tasks for the requested scheduleId are removed", async () => {
    await seed({
      id: "20260519-aaaaaaaa",
      origin: "schedule",
      status: "succeeded",
      scheduleId: "sched-1",
      success: { output: "ok" },
    });
    await seed({
      id: "20260519-bbbbbbbb",
      origin: "schedule",
      status: "succeeded",
      scheduleId: "sched-other",
      success: { output: "ok" },
    });
    const deleted = await repo.deleteTerminalForSchedule("sched-1");
    expect(deleted.map((t) => t.id)).toEqual(["20260519-aaaaaaaa"]);
    expect(await repo.read("20260519-bbbbbbbb")).not.toBeNull();
  });

  it("origin guard discriminates — standalone tasks with a stray metadata.scheduleId are NOT touched", async () => {
    // Defence-in-depth: a user who manually stuffed `scheduleId` into a
    // standalone task's metadata must not have their work silently
    // deleted when an unrelated schedule with the same id is removed.
    await seed({
      id: "20260519-aaaaaaaa",
      origin: "standalone",
      status: "succeeded",
      scheduleId: "sched-1",
      success: { output: "ok" },
    });
    const deleted = await repo.deleteTerminalForSchedule("sched-1");
    expect(deleted).toEqual([]);
    expect(await repo.read("20260519-aaaaaaaa")).not.toBeNull();
  });

  it("is idempotent — running it twice after the first sweep is a no-op", async () => {
    await seed({
      id: "20260519-aaaaaaaa",
      origin: "schedule",
      status: "succeeded",
      scheduleId: "sched-1",
      success: { output: "ok" },
    });
    await repo.deleteTerminalForSchedule("sched-1");
    expect(await repo.deleteTerminalForSchedule("sched-1")).toEqual([]);
  });
});
