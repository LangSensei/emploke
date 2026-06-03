/**
 * Unit tests for `makeTaskKindHandler`. This is the sole module
 * that knows about all three of `@emploke/schedule`,
 * `@emploke/task`, and `@emploke/catalog` — see
 * `../../src/wiring/schedule-task-handler.ts`. Covers:
 *
 *   - `validate(data)` shape checks (agent / brief / details / runtime)
 *   - `validate(data, { changedKeys })` SKIPs catalog lookup when
 *     `agent` is not in `changedKeys` (the patch-when-catalog-down
 *     property the service preserves)
 *   - `validate` throws task-pkg's `AgentNotFoundError` on null
 *     catalog hit, and `AgentResolutionFailedError` on any other
 *     catalog throw
 *   - `mergePatch` RFC 7396 semantics + `changedKeys` accuracy
 *   - `dispatch` synthesises `origin: "schedule"` +
 *     `metadata: { scheduleId, firedAt }`, conditional-spreads
 *     `details` / `runtime`, returns `{ id }`
 *   - `hasInFlightForSchedule` / `deleteForSchedule` pass-through
 */

import type { CatalogService } from "@emploke/catalog";
import { AgentNotFoundError, AgentResolutionFailedError, type TaskService } from "@emploke/task";
import { describe, expect, it, vi } from "vitest";
import {
  makeTaskKindHandler,
  TaskScheduleTargetError,
} from "../../src/wiring/schedule-task-handler.js";

function stubDeps(
  opts: { agent?: unknown | null; getAgentThrows?: Error; dispatchReturn?: { id: string } } = {},
): {
  catalog: CatalogService;
  tasks: TaskService;
  getAgent: ReturnType<typeof vi.fn>;
  dispatch: ReturnType<typeof vi.fn>;
  hasInFlightForSchedule: ReturnType<typeof vi.fn>;
  deleteForSchedule: ReturnType<typeof vi.fn>;
} {
  const getAgent = vi.fn(async (_fqn: string) => {
    if (opts.getAgentThrows !== undefined) throw opts.getAgentThrows;
    return opts.agent === undefined ? { name: "default-agent" } : opts.agent;
  });
  const dispatch = vi.fn(async () => opts.dispatchReturn ?? { id: "task-xyz" });
  const hasInFlightForSchedule = vi.fn(async () => false);
  const deleteForSchedule = vi.fn(async () => ({ deletedCount: 0 }));
  const catalog = { getAgent } as unknown as CatalogService;
  const tasks = {
    dispatch,
    hasInFlightForSchedule,
    deleteForSchedule,
  } as unknown as TaskService;
  return { catalog, tasks, getAgent, dispatch, hasInFlightForSchedule, deleteForSchedule };
}

describe("makeTaskKindHandler.validate — shape checks", () => {
  it("accepts a minimal valid payload (agent + brief)", async () => {
    const deps = stubDeps();
    const h = makeTaskKindHandler({ catalog: deps.catalog, tasks: deps.tasks });
    const result = await h.validate({ agent: "writer", brief: "do x" });
    expect(result).toEqual({ agent: "writer", brief: "do x" });
  });

  it("preserves details + runtime when provided", async () => {
    const deps = stubDeps();
    const h = makeTaskKindHandler({ catalog: deps.catalog, tasks: deps.tasks });
    const result = await h.validate({
      agent: "writer",
      brief: "do x",
      details: "long body",
      runtime: "copilot",
    });
    expect(result).toEqual({
      agent: "writer",
      brief: "do x",
      details: "long body",
      runtime: "copilot",
    });
  });

  it("rejects non-object data", async () => {
    const deps = stubDeps();
    const h = makeTaskKindHandler({ catalog: deps.catalog, tasks: deps.tasks });
    await expect(h.validate(null)).rejects.toBeInstanceOf(TaskScheduleTargetError);
    await expect(h.validate("string")).rejects.toBeInstanceOf(TaskScheduleTargetError);
    await expect(h.validate([1, 2])).rejects.toBeInstanceOf(TaskScheduleTargetError);
  });

  it("rejects missing / empty agent", async () => {
    const deps = stubDeps();
    const h = makeTaskKindHandler({ catalog: deps.catalog, tasks: deps.tasks });
    await expect(h.validate({ brief: "x" })).rejects.toBeInstanceOf(TaskScheduleTargetError);
    await expect(h.validate({ agent: "", brief: "x" })).rejects.toBeInstanceOf(
      TaskScheduleTargetError,
    );
    await expect(h.validate({ agent: "   ", brief: "x" })).rejects.toBeInstanceOf(
      TaskScheduleTargetError,
    );
  });

  it("rejects missing / empty brief", async () => {
    const deps = stubDeps();
    const h = makeTaskKindHandler({ catalog: deps.catalog, tasks: deps.tasks });
    await expect(h.validate({ agent: "a" })).rejects.toBeInstanceOf(TaskScheduleTargetError);
    await expect(h.validate({ agent: "a", brief: "" })).rejects.toBeInstanceOf(
      TaskScheduleTargetError,
    );
  });

  it("rejects multi-line brief", async () => {
    const deps = stubDeps();
    const h = makeTaskKindHandler({ catalog: deps.catalog, tasks: deps.tasks });
    await expect(h.validate({ agent: "a", brief: "line1\nline2" })).rejects.toBeInstanceOf(
      TaskScheduleTargetError,
    );
    await expect(h.validate({ agent: "a", brief: "line1\rline2" })).rejects.toBeInstanceOf(
      TaskScheduleTargetError,
    );
  });

  it("rejects brief > 200 chars", async () => {
    const deps = stubDeps();
    const h = makeTaskKindHandler({ catalog: deps.catalog, tasks: deps.tasks });
    await expect(h.validate({ agent: "a", brief: "x".repeat(201) })).rejects.toBeInstanceOf(
      TaskScheduleTargetError,
    );
  });

  it("rejects non-string details", async () => {
    const deps = stubDeps();
    const h = makeTaskKindHandler({ catalog: deps.catalog, tasks: deps.tasks });
    await expect(h.validate({ agent: "a", brief: "b", details: 123 })).rejects.toBeInstanceOf(
      TaskScheduleTargetError,
    );
  });

  it("rejects empty runtime", async () => {
    const deps = stubDeps();
    const h = makeTaskKindHandler({ catalog: deps.catalog, tasks: deps.tasks });
    await expect(h.validate({ agent: "a", brief: "b", runtime: "" })).rejects.toBeInstanceOf(
      TaskScheduleTargetError,
    );
  });
});

describe("makeTaskKindHandler.validate — catalog cross-check", () => {
  it("calls catalog.getAgent on the full validate path (no changedKeys)", async () => {
    const deps = stubDeps({ agent: { name: "writer" } });
    const h = makeTaskKindHandler({ catalog: deps.catalog, tasks: deps.tasks });
    await h.validate({ agent: "writer", brief: "x" });
    expect(deps.getAgent).toHaveBeenCalledTimes(1);
    expect(deps.getAgent).toHaveBeenCalledWith("writer");
  });

  it("SKIPS catalog.getAgent when changedKeys excludes 'agent' (e.g. brief-only patch)", async () => {
    const deps = stubDeps({ agent: { name: "writer" } });
    const h = makeTaskKindHandler({ catalog: deps.catalog, tasks: deps.tasks });
    await h.validate({ agent: "writer", brief: "new brief" }, { changedKeys: ["brief"] });
    // No catalog round-trip — preserves the patch-when-catalog-down
    // property the service exposes.
    expect(deps.getAgent).not.toHaveBeenCalled();
  });

  it("DOES call catalog.getAgent when changedKeys includes 'agent'", async () => {
    const deps = stubDeps({ agent: { name: "writer" } });
    const h = makeTaskKindHandler({ catalog: deps.catalog, tasks: deps.tasks });
    await h.validate({ agent: "writer", brief: "x" }, { changedKeys: ["agent"] });
    expect(deps.getAgent).toHaveBeenCalledTimes(1);
  });

  it("throws task-pkg's AgentNotFoundError when catalog returns null", async () => {
    const deps = stubDeps({ agent: null });
    const h = makeTaskKindHandler({ catalog: deps.catalog, tasks: deps.tasks });
    await expect(h.validate({ agent: "ghost", brief: "x" })).rejects.toBeInstanceOf(
      AgentNotFoundError,
    );
  });

  it("throws task-pkg's AgentResolutionFailedError on any other catalog throw", async () => {
    const deps = stubDeps({ getAgentThrows: new Error("DB exploded") });
    const h = makeTaskKindHandler({ catalog: deps.catalog, tasks: deps.tasks });
    const err = await h.validate({ agent: "writer", brief: "x" }).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(AgentResolutionFailedError);
    expect(err).not.toBeInstanceOf(AgentNotFoundError);
    expect((err as AgentResolutionFailedError).agent).toBe("writer");
  });
});

describe("makeTaskKindHandler.mergePatch", () => {
  it("absent patch fields keep existing values; no changedKeys", () => {
    const deps = stubDeps();
    const h = makeTaskKindHandler({ catalog: deps.catalog, tasks: deps.tasks });
    const out = h.mergePatch({ agent: "writer", brief: "old" }, {});
    expect(out.data).toEqual({ agent: "writer", brief: "old" });
    expect(out.changedKeys).toEqual([]);
  });

  it("setting agent / brief surfaces them in changedKeys", () => {
    const deps = stubDeps();
    const h = makeTaskKindHandler({ catalog: deps.catalog, tasks: deps.tasks });
    const out = h.mergePatch({ agent: "old", brief: "old-b" }, { agent: "new", brief: "new-b" });
    expect(out.data).toEqual({ agent: "new", brief: "new-b" });
    expect([...out.changedKeys].sort()).toEqual(["agent", "brief"]);
  });

  it("null on details deletes the field (RFC 7396)", () => {
    const deps = stubDeps();
    const h = makeTaskKindHandler({ catalog: deps.catalog, tasks: deps.tasks });
    const out = h.mergePatch(
      { agent: "a", brief: "b", details: "old", runtime: "node-22" },
      { details: null },
    );
    expect(out.data).toEqual({ agent: "a", brief: "b", runtime: "node-22" });
    expect(out.changedKeys).toContain("details");
  });

  it("null on details when already absent does NOT inflate changedKeys", () => {
    const deps = stubDeps();
    const h = makeTaskKindHandler({ catalog: deps.catalog, tasks: deps.tasks });
    const out = h.mergePatch({ agent: "a", brief: "b" }, { details: null });
    expect(out.data).toEqual({ agent: "a", brief: "b" });
    expect(out.changedKeys).toEqual([]);
  });

  it("string set on details adds the field to changedKeys", () => {
    const deps = stubDeps();
    const h = makeTaskKindHandler({ catalog: deps.catalog, tasks: deps.tasks });
    const out = h.mergePatch({ agent: "a", brief: "b" }, { details: "added" });
    expect(out.data).toEqual({ agent: "a", brief: "b", details: "added" });
    expect(out.changedKeys).toEqual(["details"]);
  });

  it("null on runtime deletes; string set adds (mirrors details)", () => {
    const deps = stubDeps();
    const h = makeTaskKindHandler({ catalog: deps.catalog, tasks: deps.tasks });
    const out1 = h.mergePatch({ agent: "a", brief: "b", runtime: "node-22" }, { runtime: null });
    expect(out1.data).toEqual({ agent: "a", brief: "b" });
    expect(out1.changedKeys).toEqual(["runtime"]);

    const out2 = h.mergePatch({ agent: "a", brief: "b" }, { runtime: "copilot" });
    expect(out2.data).toEqual({ agent: "a", brief: "b", runtime: "copilot" });
    expect(out2.changedKeys).toEqual(["runtime"]);
  });
});

describe("makeTaskKindHandler.dispatch", () => {
  it("synthesises origin: 'schedule' + metadata + returns { id }", async () => {
    const deps = stubDeps({ dispatchReturn: { id: "task-001" } });
    const h = makeTaskKindHandler({ catalog: deps.catalog, tasks: deps.tasks });
    const out = await h.dispatch({
      scheduleId: "sched-abc",
      firedAt: "2026-06-01T00:00:00.000Z",
      data: { agent: "writer", brief: "Summarize" },
    });
    expect(out).toEqual({ id: "task-001" });
    expect(deps.dispatch).toHaveBeenCalledTimes(1);
    const call = deps.dispatch.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.agent).toBe("writer");
    expect(call.brief).toBe("Summarize");
    expect(call.origin).toBe("schedule");
    expect(call.metadata).toEqual({ scheduleId: "sched-abc", firedAt: "2026-06-01T00:00:00.000Z" });
  });

  it("conditional-spreads details + runtime (omits when not on data)", async () => {
    const deps = stubDeps();
    const h = makeTaskKindHandler({ catalog: deps.catalog, tasks: deps.tasks });
    await h.dispatch({
      scheduleId: "s",
      firedAt: "t",
      data: { agent: "a", brief: "b" },
    });
    const call = deps.dispatch.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.hasOwn(call, "details")).toBe(false);
    expect(Object.hasOwn(call, "runtime")).toBe(false);
  });

  it("forwards details + runtime when present", async () => {
    const deps = stubDeps();
    const h = makeTaskKindHandler({ catalog: deps.catalog, tasks: deps.tasks });
    await h.dispatch({
      scheduleId: "s",
      firedAt: "t",
      data: { agent: "a", brief: "b", details: "long", runtime: "node" },
    });
    const call = deps.dispatch.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.details).toBe("long");
    expect(call.runtime).toBe("node");
  });
});

describe("makeTaskKindHandler.hasInFlightForSchedule + deleteForSchedule", () => {
  it("hasInFlightForSchedule passes through", async () => {
    const deps = stubDeps();
    deps.hasInFlightForSchedule.mockResolvedValueOnce(true);
    const h = makeTaskKindHandler({ catalog: deps.catalog, tasks: deps.tasks });
    expect(await h.hasInFlightForSchedule("sched-abc")).toBe(true);
    expect(deps.hasInFlightForSchedule).toHaveBeenCalledWith("sched-abc");
  });

  it("deleteForSchedule passes through the count", async () => {
    const deps = stubDeps();
    deps.deleteForSchedule.mockResolvedValueOnce({ deletedCount: 17 });
    const h = makeTaskKindHandler({ catalog: deps.catalog, tasks: deps.tasks });
    expect(await h.deleteForSchedule("sched-abc")).toEqual({ deletedCount: 17 });
    expect(deps.deleteForSchedule).toHaveBeenCalledWith("sched-abc");
  });
});
