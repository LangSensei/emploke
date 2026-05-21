/**
 * v4 (issue #119) round-trip: every TaskFailure / TaskCancellation
 * variant must survive save → read through the new JSON-column storage
 * shape with its discriminator + per-variant extras intact.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskEntity } from "../src/task-entity.js";
import { TaskRepository } from "../src/task-repository.js";
import { openTestTaskDb } from "../src/testing.js";
import type { TaskCancellation, TaskFailure } from "../src/types.js";

let orm: ReturnType<typeof openTestTaskDb>;
let repo: TaskRepository;

beforeEach(async () => {
  orm = openTestTaskDb();
  repo = new TaskRepository({ db: orm.db });
});
afterEach(async () => {
  orm.close();
});

const CREATED_AT = "2026-06-01T00:00:00.000Z";
const STARTED_AT = "2026-06-01T00:00:01.000Z";
const ENDED_AT = "2026-06-01T00:00:02.000Z";

function buildFailure(id: string, failure: TaskFailure): TaskEntity {
  return TaskEntity.fromStored({
    id,
    agent: "writer",
    brief: "do the thing",
    origin: "standalone",
    status: "failed",
    metadata: {},
    createdAt: CREATED_AT,
    startedAt: STARTED_AT,
    endedAt: ENDED_AT,
    failure,
  });
}

function buildCancellation(id: string, cancellation: TaskCancellation): TaskEntity {
  return TaskEntity.fromStored({
    id,
    agent: "writer",
    brief: "do the thing",
    origin: "standalone",
    status: "cancelled",
    metadata: {},
    createdAt: CREATED_AT,
    startedAt: STARTED_AT,
    endedAt: ENDED_AT,
    cancellation,
  });
}

describe("TaskFailure union — round-trip through SqliteTaskRepository", () => {
  const cases: { id: string; label: string; failure: TaskFailure }[] = [
    {
      id: "20260601-aaaaaaaa",
      label: "exited",
      failure: { kind: "exited", exit_code: 17, message: "exited with code 17" },
    },
    {
      id: "20260601-bbbbbbbb",
      label: "signal",
      failure: { kind: "signal", signal: "SIGTERM", message: "terminated by signal SIGTERM" },
    },
    {
      id: "20260601-cccccccc",
      label: "shutdown",
      failure: { kind: "shutdown", message: "server shutdown" },
    },
    {
      id: "20260601-dddddddd",
      label: "orphan",
      failure: { kind: "orphan", message: "orphaned (server crashed before this task ended)" },
    },
    {
      id: "20260601-eeeeeeee",
      label: "internal",
      failure: { kind: "internal", message: "exit watcher rejected: weird" },
    },
  ];

  for (const c of cases) {
    it(`preserves kind='${c.label}' across save → read`, async () => {
      const t = buildFailure(c.id, c.failure);
      await repo.save(t);
      const back = await repo.read(c.id);
      expect(back?.status).toBe("failed");
      expect(back?.failure).toEqual(c.failure);
    });
  }
});

describe("TaskCancellation union — round-trip through SqliteTaskRepository", () => {
  const cases: { id: string; label: string; cancellation: TaskCancellation }[] = [
    {
      id: "20260601-11111111",
      label: "user",
      cancellation: { kind: "user", message: "cancelled by user" },
    },
    {
      id: "20260601-22222222",
      label: "cascade",
      cancellation: {
        kind: "cascade",
        message: "cancelled (recovered from inconsistent state)",
      },
    },
  ];

  for (const c of cases) {
    it(`preserves kind='${c.label}' across save → read`, async () => {
      const t = buildCancellation(c.id, c.cancellation);
      await repo.save(t);
      const back = await repo.read(c.id);
      expect(back?.status).toBe("cancelled");
      expect(back?.cancellation).toEqual(c.cancellation);
    });
  }
});
