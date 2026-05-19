/**
 * R-10 / §3.12 #11 — round-trip every TaskFailure / TaskCancellation
 * variant through SQLite to pin that the columnar storage shape
 * preserves the discriminant + per-variant extras.
 */

import { DatabaseSync } from "node:sqlite";
import { runPkgMigrationsSync } from "@emploke/workspace";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteTaskRepository, TASK_MIGRATIONS, Task } from "../src/index.js";
import type { TaskCancellation, TaskFailure } from "../src/types.js";

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

const CREATED_AT = "2026-06-01T00:00:00.000Z";
const STARTED_AT = "2026-06-01T00:00:01.000Z";
const ENDED_AT = "2026-06-01T00:00:02.000Z";

function buildFailure(id: string, failure: TaskFailure): Task {
  return Task.fromStored({
    id,
    agent: "writer",
    brief: "do the thing",
    status: "failure",
    metadata: {},
    createdAt: CREATED_AT,
    startedAt: STARTED_AT,
    endedAt: ENDED_AT,
    failure,
  });
}

function buildCancellation(id: string, cancellation: TaskCancellation): Task {
  return Task.fromStored({
    id,
    agent: "writer",
    brief: "do the thing",
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
      failure: { kind: "exited", exitCode: 17, message: "exited with code 17" },
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
      expect(back?.status).toBe("failure");
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
      label: "orphan",
      cancellation: {
        kind: "orphan",
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
