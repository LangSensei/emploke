/**
 * `TaskService.hasInFlightForSchedule(scheduleId)` is the
 * concurrency=1 guard the scheduler uses to skip firing while a
 * previous fire of the same schedule is still running, AND the guard
 * the delete-schedule path uses to refuse delete while a fired task
 * is in flight.
 *
 * Predicate is `origin = 'schedule' AND status = 'running' AND
 * metadata.scheduleId = ?`. The origin guard discriminates: a
 * standalone task that happens to carry `metadata.scheduleId` does
 * NOT count (no scheduler ever owns it).
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

describe("TaskRepository.hasInFlightForSchedule", () => {
  it("(a) returns false when no tasks exist", async () => {
    expect(await repo.hasInFlightForSchedule("sched-1")).toBe(false);
  });

  it("(b) returns true for a running schedule-origin task with the matching scheduleId", async () => {
    await seed({
      id: "20260519-aaaaaaaa",
      origin: "schedule",
      status: "running",
      scheduleId: "sched-1",
    });
    expect(await repo.hasInFlightForSchedule("sched-1")).toBe(true);
  });

  it("(c) returns false when all matching tasks are terminal (succeeded/failed/cancelled)", async () => {
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
    expect(await repo.hasInFlightForSchedule("sched-1")).toBe(false);
  });

  it("(d) returns false when only DIFFERENT scheduleIds have running tasks", async () => {
    await seed({
      id: "20260519-aaaaaaaa",
      origin: "schedule",
      status: "running",
      scheduleId: "sched-other",
    });
    expect(await repo.hasInFlightForSchedule("sched-1")).toBe(false);
  });

  it("(e) returns false when a standalone task carries metadata.scheduleId (origin guard discriminates)", async () => {
    await seed({
      id: "20260519-aaaaaaaa",
      origin: "standalone",
      status: "running",
      scheduleId: "sched-1",
    });
    // The origin guard is what makes this safe: a user who happens to
    // stuff `scheduleId` into a standalone task's metadata does NOT
    // confuse the scheduler's concurrency check.
    expect(await repo.hasInFlightForSchedule("sched-1")).toBe(false);
  });

  it("mixed: returns true if at least one running schedule-origin task matches, even alongside terminal ones", async () => {
    await seed({
      id: "20260519-aaaaaaaa",
      origin: "schedule",
      status: "succeeded",
      scheduleId: "sched-1",
      success: { output: "old" },
    });
    await seed({
      id: "20260519-bbbbbbbb",
      origin: "schedule",
      status: "running",
      scheduleId: "sched-1",
    });
    expect(await repo.hasInFlightForSchedule("sched-1")).toBe(true);
  });
});
