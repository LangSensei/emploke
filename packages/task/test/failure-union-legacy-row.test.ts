/**
 * R-10 / §3.12 #12 — legacy v2 rows (written before ADR-001) have
 * `failure_error` populated but `failure_kind` NULL. The repository's
 * read path synthesises `{ kind: 'internal', message: failure_error }`
 * and emits a one-line warn so operators can spot the pattern.
 *
 * The mirror case for cancelled rows is also covered here: no
 * pre-ADR-001 producer ever wrote a `cancelled` row, but a
 * hand-crafted legacy row with `status='cancelled'` and NULL
 * cancellation_* columns is defensively synthesised as
 * `{ kind: 'user', message: 'cancelled by user' }` so the entity
 * invariant survives.
 */

import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteTaskRepository } from "../src/index.js";

let db: DatabaseSync;

interface LoggerCall {
  msg: string;
  meta?: object;
}

function captureLogger(): {
  calls: LoggerCall[];
  logger: { warn: (m: object | string, s?: string) => void };
} {
  const calls: LoggerCall[] = [];
  return {
    calls,
    logger: {
      warn: (meta: object | string, msg?: string) => {
        if (typeof meta === "string") calls.push({ msg: meta });
        else calls.push({ msg: msg ?? "", meta });
      },
    },
  };
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
});
afterEach(() => {
  db.close();
});

describe("legacy v2 failure row read fallback", () => {
  it("synthesises { kind: 'internal', message: failure_error } and warns once", async () => {
    const id = "20260518-aaaaaaaa";
    // Construct a fresh v3 repo, then forge a row directly via SQL
    // that mimics the legacy v2 wire shape (failure_kind = NULL,
    // failure_error populated). The repo's read path is what we're
    // exercising.
    const cap = captureLogger();
    const repo = new SqliteTaskRepository({ db, logger: cap.logger });
    db.prepare(
      `INSERT INTO tasks (
         id, agent, runtime, status, brief, details, created_at, started_at,
         ended_at, result_output, failure_error, metadata
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      "writer",
      "copilot",
      "failure",
      "do the thing",
      null,
      "2026-05-18T00:00:00.000Z",
      "2026-05-18T00:00:01.000Z",
      "2026-05-18T00:00:05.000Z",
      null,
      "legacy boom",
      "{}",
    );
    const back = await repo.read(id);
    expect(back?.status).toBe("failure");
    expect(back?.failure).toEqual({ kind: "internal", message: "legacy boom" });

    const synthWarns = cap.calls.filter((c) => c.msg.includes("legacy failure row"));
    expect(synthWarns).toHaveLength(1);
  });
});

describe("legacy cancelled row read fallback", () => {
  it("synthesises { kind: 'user', message: 'cancelled by user' } and warns", async () => {
    const id = "20260518-bbbbbbbb";
    const cap = captureLogger();
    const repo = new SqliteTaskRepository({ db, logger: cap.logger });
    db.prepare(
      `INSERT INTO tasks (
         id, agent, runtime, status, brief, details, created_at, started_at,
         ended_at, result_output, failure_error, metadata
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      "writer",
      "copilot",
      "cancelled",
      "do the thing",
      null,
      "2026-05-18T00:00:00.000Z",
      "2026-05-18T00:00:01.000Z",
      "2026-05-18T00:00:05.000Z",
      null,
      null,
      "{}",
    );
    const back = await repo.read(id);
    expect(back?.status).toBe("cancelled");
    expect(back?.cancellation).toEqual({ kind: "user", message: "cancelled by user" });

    const synthWarns = cap.calls.filter((c) => c.msg.includes("legacy cancelled row"));
    expect(synthWarns).toHaveLength(1);
  });
});
