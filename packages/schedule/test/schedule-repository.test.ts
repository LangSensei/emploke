import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScheduleEntity } from "../src/schedule-entity.js";
import { ScheduleRepository } from "../src/schedule-repository.js";
import { openTestScheduleDb } from "../src/testing.js";
import type { CreateTaskScheduleArgs } from "../src/types.js";

/**
 * Smoke tests for the agent-filter list path post-RFC #61 v2: the
 * `target_agent` column is gone and `list({ agent })` now hits the
 * functional partial index `schedules_target_agent_idx` (defined on
 * `json_extract(target_json, '$.agent')` WHERE `target_kind = 'task'`,
 * see `drizzle/0001_drop_target_agent_add_json_index.sql`).
 */
describe("ScheduleRepository.list({ agent }) — functional partial JSON-extract index", () => {
  let db: ReturnType<typeof openTestScheduleDb>;
  let repo: ScheduleRepository;

  beforeEach(() => {
    db = openTestScheduleDb();
    repo = new ScheduleRepository({ db: db.db });
  });

  afterEach(() => {
    db.close();
  });

  function args(name: string, agent: string): CreateTaskScheduleArgs {
    return {
      name,
      trigger: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
      target: { agent, brief: `${name}-brief` },
    };
  }

  function insert(
    id: string,
    a: CreateTaskScheduleArgs,
    now: Date = new Date("2026-05-01T00:00:00.000Z"),
  ): Promise<void> {
    return repo.insert(ScheduleEntity.create(a, { id, now }));
  }

  it("returns only matching rows when multiple agents are present", async () => {
    await insert("550e8400-e29b-41d4-a716-446655440000", args("a", "writer"));
    await insert("550e8400-e29b-41d4-a716-446655440001", args("b", "reviewer"));
    await insert("550e8400-e29b-41d4-a716-446655440002", args("c", "writer"));
    const writers = await repo.list({ agent: "writer" });
    expect(writers.map((e) => e.name).sort()).toEqual(["a", "c"]);
    const reviewers = await repo.list({ agent: "reviewer" });
    expect(reviewers.map((e) => e.name)).toEqual(["b"]);
  });

  it("EXPLAIN QUERY PLAN engages schedules_target_agent_idx for the agent filter", async () => {
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
});
