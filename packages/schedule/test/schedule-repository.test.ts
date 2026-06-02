import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvalidJsonPathError } from "../src/errors.js";
import { ScheduleEntity } from "../src/schedule-entity.js";
import { ScheduleRepository } from "../src/schedule-repository.js";
import { openTestScheduleDb } from "../src/testing.js";
import type { CreateScheduleArgs } from "../src/types.js";

/**
 * Repository smoke tests for the generic `dataEquals` list filter
 * + the partial JSON-extract index that engages when
 * `dataEquals.path = "$.agent"` + `kind = "task"` are both present.
 */
describe("ScheduleRepository.list({ kind, dataEquals }) — generic JSON-extract filter", () => {
  let db: ReturnType<typeof openTestScheduleDb>;
  let repo: ScheduleRepository;

  beforeEach(() => {
    db = openTestScheduleDb();
    repo = new ScheduleRepository({ db: db.db });
  });

  afterEach(() => {
    db.close();
  });

  function args(name: string, agent: string): CreateScheduleArgs {
    return {
      name,
      trigger: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
      target: { kind: "task", data: { agent, brief: `${name}-brief` } },
    };
  }

  function insert(
    id: string,
    a: CreateScheduleArgs,
    now: Date = new Date("2026-05-01T00:00:00.000Z"),
  ): Promise<void> {
    return repo.insert(ScheduleEntity.create(a, { id, now }));
  }

  it("returns only matching rows when multiple agents are present (kind + dataEquals on $.agent)", async () => {
    await insert("550e8400-e29b-41d4-a716-446655440000", args("a", "writer"));
    await insert("550e8400-e29b-41d4-a716-446655440001", args("b", "reviewer"));
    await insert("550e8400-e29b-41d4-a716-446655440002", args("c", "writer"));
    const writers = await repo.list({
      kind: "task",
      dataEquals: { path: "$.agent", value: "writer" },
    });
    expect(writers.map((e) => e.name).sort()).toEqual(["a", "c"]);
    const reviewers = await repo.list({
      kind: "task",
      dataEquals: { path: "$.agent", value: "reviewer" },
    });
    expect(reviewers.map((e) => e.name)).toEqual(["b"]);
  });

  it("EXPLAIN QUERY PLAN engages schedules_target_agent_idx when both predicates are present", async () => {
    await insert("550e8400-e29b-41d4-a716-446655440000", args("a", "writer"));
    const plan = db.sqlite
      .prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM schedules WHERE target_kind = 'task' AND json_extract(target_json, '$.agent') = ?",
      )
      .all("writer") as { detail: string }[];
    const planText = plan.map((p) => p.detail).join(" | ");
    // Best-effort: SQLite's planner output mentions the engaged index
    // when it picks one. If the partial-index predicates don't line
    // up the planner falls back to a SCAN and this fails loudly.
    expect(planText).toMatch(/USING (COVERING )?INDEX schedules_target_agent_idx/);
  });

  it("rejects an SQL-injection-shaped path with InvalidJsonPathError", async () => {
    await insert("550e8400-e29b-41d4-a716-446655440000", args("a", "writer"));
    // Anything that doesn't match `^\$(\.[a-zA-Z_][a-zA-Z0-9_]*)+$`
    // must throw BEFORE the SQL fragment is built — the path is
    // concatenated into json_extract's first argument because
    // Drizzle's `sql` template only parameterises the `?` slots.
    await expect(
      repo.list({
        kind: "task",
        dataEquals: { path: "'; DROP TABLE schedules; --", value: "writer" },
      }),
    ).rejects.toBeInstanceOf(InvalidJsonPathError);
  });

  it("accepts a nested $.workflow.id path (grammar allows multi-segment field reads)", async () => {
    // The grammar `^\$(\.[a-zA-Z_][a-zA-Z0-9_]*)+$` is multi-segment
    // by design so future kinds can store nested data and still
    // filter via the generic mechanism.
    await insert("550e8400-e29b-41d4-a716-446655440000", {
      name: "n",
      trigger: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
      target: { kind: "task", data: { workflow: { id: "wf-1" } } },
    });
    const matches = await repo.list({
      kind: "task",
      dataEquals: { path: "$.workflow.id", value: "wf-1" },
    });
    expect(matches.map((e) => e.name)).toEqual(["n"]);
  });
});
