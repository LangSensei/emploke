import { describe, expect, it } from "vitest";
import { InvalidTaskIdError, InvalidTransition } from "../src/errors.js";
import { Task } from "../src/task-entity.js";
import type { TaskStatus } from "../src/types.js";

const fixedNow = "2025-06-01T12:00:00.000Z";
const FIXED_ID = "20260101-aaaaaaaa";

const makeTask = (overrides: { metadata?: Readonly<Record<string, unknown>> } = {}): Task =>
  Task.create({
    id: FIXED_ID,
    agent: "a",
    brief: "go",
    createdAt: fixedNow,
    ...(overrides.metadata !== undefined ? { metadata: overrides.metadata } : {}),
  });

describe("Task.create", () => {
  it("starts in running with success/failure/cancellation unset and startedAt = createdAt", () => {
    const t = Task.create({ agent: "a", brief: "do", createdAt: fixedNow });
    expect(t.status).toBe("running");
    expect(t.success).toBeUndefined();
    expect(t.failure).toBeUndefined();
    expect(t.cancellation).toBeUndefined();
    expect(t.startedAt).toBe(fixedNow);
    expect(t.endedAt).toBeUndefined();
    expect(t.details).toBeUndefined();
    expect(t.origin).toBe("standalone");
  });

  it("captures details when provided", () => {
    const t = Task.create({ agent: "a", brief: "do", details: "Tone: warm.\nLength: short." });
    expect(t.details).toBe("Tone: warm.\nLength: short.");
  });

  it("rejects empty brief at the entity boundary", () => {
    expect(() => Task.create({ agent: "a", brief: "" })).toThrow(TypeError);
  });

  it("mints distinct canonical task ids by default", () => {
    const a = Task.create({ agent: "x", brief: "go" });
    const b = Task.create({ agent: "x", brief: "go" });
    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(/^\d{8}-[0-9a-f]{8}$/);
  });

  it("rejects an explicit non-canonical id", () => {
    expect(() => Task.create({ agent: "a", brief: "go", id: "fixed-id" })).toThrow(
      InvalidTaskIdError,
    );
  });

  it("honours an explicit createdAt override and mirrors into startedAt", () => {
    const stamp = "2025-12-31T23:59:59.999Z";
    const t = Task.create({ agent: "a", brief: "go", createdAt: stamp });
    expect(t.createdAt).toBe(stamp);
    expect(t.startedAt).toBe(stamp);
  });

  it("captures the explicit origin", () => {
    const t = Task.create({ agent: "a", brief: "go", origin: "workflow" });
    expect(t.origin).toBe("workflow");
  });

  it("defaults metadata to an empty object", () => {
    const t = Task.create({ agent: "a", brief: "go" });
    expect(t.metadata).toEqual({});
  });
});

describe("Task — happy paths", () => {
  it("complete: running → succeeded, captures success and endedAt", () => {
    const r = makeTask().complete({ output: "ok" }, { now: fixedNow });
    expect(r.status).toBe("succeeded");
    expect(r.success).toEqual({ output: "ok" });
    expect(r.endedAt).toBe(fixedNow);
    expect(r.failure).toBeUndefined();
  });

  it("fail: running → failed, captures the typed failure payload", () => {
    const r = makeTask().fail({ kind: "internal", message: "boom" }, { now: fixedNow });
    expect(r.status).toBe("failed");
    expect(r.failure).toEqual({ kind: "internal", message: "boom" });
    expect(r.success).toBeUndefined();
  });

  it("cancel: running → cancelled, captures the typed cancellation payload", () => {
    const r = makeTask().cancel({ kind: "user", message: "cancelled by user" }, { now: fixedNow });
    expect(r.status).toBe("cancelled");
    expect(r.endedAt).toBe(fixedNow);
    expect(r.cancellation).toEqual({ kind: "user", message: "cancelled by user" });
  });

  it("transition methods use a default `now` when not provided", () => {
    const before = Date.now();
    const r = makeTask().complete({ output: "" });
    const after = Date.now();
    const parsed = Date.parse(r.endedAt as string);
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);
  });

  it("transitions preserve brief + details + origin verbatim", () => {
    const t = Task.create({
      id: FIXED_ID,
      agent: "a",
      brief: "the brief",
      details: "long body",
      origin: "workflow",
      createdAt: fixedNow,
    });
    const r = t.complete({ output: "ok" }, { now: fixedNow });
    expect(r.brief).toBe("the brief");
    expect(r.details).toBe("long body");
    expect(r.origin).toBe("workflow");
  });
});

describe("Task — invalid transitions", () => {
  it("rejects every transition on a terminal succeeded task", () => {
    const ok = makeTask().complete({ output: "y" }, { now: fixedNow });
    expect(() => ok.complete({ output: "x" }, { now: fixedNow })).toThrow(InvalidTransition);
    expect(() => ok.fail({ kind: "internal", message: "x" }, { now: fixedNow })).toThrow(
      InvalidTransition,
    );
    expect(() => ok.cancel({ kind: "user", message: "x" }, { now: fixedNow })).toThrow(
      InvalidTransition,
    );
  });

  it("rejects every transition on a terminal failed task", () => {
    const failed = makeTask().fail({ kind: "internal", message: "no" }, { now: fixedNow });
    expect(() => failed.complete({ output: "x" }, { now: fixedNow })).toThrow(InvalidTransition);
    expect(() => failed.cancel({ kind: "user", message: "x" }, { now: fixedNow })).toThrow(
      InvalidTransition,
    );
  });

  it("rejects every transition on a terminal cancelled task", () => {
    const cancelled = makeTask().cancel({ kind: "user", message: "no go" }, { now: fixedNow });
    expect(() => cancelled.complete({ output: "x" }, { now: fixedNow })).toThrow(InvalidTransition);
    expect(() => cancelled.fail({ kind: "internal", message: "x" }, { now: fixedNow })).toThrow(
      InvalidTransition,
    );
    expect(() => cancelled.cancel({ kind: "user", message: "x" }, { now: fixedNow })).toThrow(
      InvalidTransition,
    );
  });

  it("InvalidTransition exposes from-status and event type", () => {
    const ok = makeTask().complete({ output: "x" }, { now: fixedNow });
    try {
      ok.complete({ output: "" }, { now: fixedNow });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidTransition);
      expect((e as InvalidTransition).from).toBe("succeeded");
      expect((e as InvalidTransition).eventType).toBe("complete");
    }
  });
});

describe("Task — metadata merge on transitions", () => {
  it("complete merges metadata into the task's existing metadata", () => {
    const t = makeTask({ metadata: { creator: "alice" } });
    const r = t.complete({ output: "ok" }, { metadata: { attempt: 2 }, now: fixedNow });
    expect(r.metadata).toEqual({ creator: "alice", attempt: 2 });
  });

  it("fail / cancel also accept metadata", () => {
    const failed = makeTask().fail(
      { kind: "internal", message: "x" },
      { metadata: { lastSession: "abc" }, now: fixedNow },
    );
    expect(failed.metadata).toEqual({ lastSession: "abc" });

    const cancelled = makeTask().cancel(
      { kind: "user", message: "user-aborted" },
      { metadata: { reason: "user-aborted" }, now: fixedNow },
    );
    expect(cancelled.metadata).toEqual({ reason: "user-aborted" });
  });

  it("transition without metadata leaves existing metadata untouched (and shares ref)", () => {
    const t = makeTask({ metadata: { creator: "alice" } });
    const r = t.complete({ output: "" }, { now: fixedNow });
    expect(r.metadata).toEqual({ creator: "alice" });
    expect(r.metadata).toBe(t.metadata);
  });
});

describe("Task — purity", () => {
  it("does not mutate the input task", () => {
    const t = makeTask({ metadata: { a: 1 } });
    const snapshot = JSON.stringify(t);
    t.complete({ output: "ok" }, { metadata: { b: 2 }, now: fixedNow });
    expect(JSON.stringify(t)).toBe(snapshot);
  });
});

describe("Task.withMetadata", () => {
  it("replaces metadata wholesale, preserves status + timing + identity + origin", () => {
    const t = makeTask({ metadata: { keep: "no" } });
    const r = t.withMetadata({ lastActiveAtRuntime: "2026-01-01T00:00:00.000Z" });
    expect(r.metadata).toEqual({ lastActiveAtRuntime: "2026-01-01T00:00:00.000Z" });
    expect(r.status).toBe("running");
    expect(r.startedAt).toBe(fixedNow);
    expect(r.id).toBe(t.id);
    expect(r.agent).toBe(t.agent);
    expect(r.brief).toBe(t.brief);
    expect(r.details).toBe(t.details);
    expect(r.origin).toBe(t.origin);
    expect(r.createdAt).toBe(t.createdAt);
  });
});

describe("Task.fromStored", () => {
  it("rebuilds a task from a storage row", () => {
    const t = Task.fromStored({
      id: FIXED_ID,
      agent: "a",
      brief: "do",
      origin: "standalone",
      status: "succeeded",
      metadata: { pid: 100 },
      createdAt: fixedNow,
      startedAt: fixedNow,
      endedAt: fixedNow,
      success: { output: "ok" },
    });
    expect(t.status).toBe("succeeded");
    expect(t.success).toEqual({ output: "ok" });
    expect(t.metadata).toEqual({ pid: 100 });
    expect(t.details).toBeUndefined();
  });

  it("throws InvalidTaskIdError on a malformed id", () => {
    expect(() =>
      Task.fromStored({
        id: "../../etc",
        agent: "a",
        brief: "do",
        origin: "standalone",
        status: "running",
        metadata: {},
        createdAt: fixedNow,
        startedAt: fixedNow,
      }),
    ).toThrow(InvalidTaskIdError);
  });

  it("throws CorruptedTaskError on an unknown status", () => {
    expect(() =>
      Task.fromStored({
        id: FIXED_ID,
        agent: "a",
        brief: "do",
        origin: "standalone",
        status: "invented" as TaskStatus,
        metadata: {},
        createdAt: fixedNow,
        startedAt: fixedNow,
      }),
    ).toThrow(/status must be one of/);
  });

  it("throws CorruptedTaskError on an unknown origin", () => {
    expect(() =>
      Task.fromStored({
        id: FIXED_ID,
        agent: "a",
        brief: "do",
        origin: "alien" as never,
        status: "running",
        metadata: {},
        createdAt: fixedNow,
        startedAt: fixedNow,
      }),
    ).toThrow(/origin must be one of/);
  });

  it("throws CorruptedTaskError on non-object metadata", () => {
    expect(() =>
      Task.fromStored({
        id: FIXED_ID,
        agent: "a",
        brief: "do",
        origin: "standalone",
        status: "running",
        metadata: null as unknown as Record<string, unknown>,
        createdAt: fixedNow,
        startedAt: fixedNow,
      }),
    ).toThrow(/metadata must be an object/);
  });
});

describe("Task.toJSON", () => {
  it("serialises automatically via JSON.stringify with byte-identical wire shape", () => {
    const t = makeTask({ metadata: { creator: "alice" } });
    const wire = JSON.parse(JSON.stringify(t));
    expect(wire).toEqual({
      id: FIXED_ID,
      agent: "a",
      brief: "go",
      origin: "standalone",
      status: "running",
      metadata: { creator: "alice" },
      createdAt: fixedNow,
      startedAt: fixedNow,
    });
  });

  it("includes the success payload on serialised succeeded tasks", () => {
    const ok = makeTask().complete({ output: "ok" }, { now: fixedNow });
    const wire = JSON.parse(JSON.stringify(ok));
    expect(wire).toMatchObject({
      status: "succeeded",
      success: { output: "ok" },
      endedAt: fixedNow,
    });
    expect(wire.failure).toBeUndefined();
    expect(wire.cancellation).toBeUndefined();
  });

  it("includes the typed failure payload on serialised failed tasks", () => {
    const failed = makeTask().fail(
      { kind: "exited", exit_code: 17, message: "exited with code 17" },
      { now: fixedNow },
    );
    const wire = JSON.parse(JSON.stringify(failed));
    expect(wire.failure).toEqual({ kind: "exited", exit_code: 17, message: "exited with code 17" });
    expect(wire.cancellation).toBeUndefined();
    expect(wire.success).toBeUndefined();
  });

  it("includes the typed cancellation payload on serialised cancelled tasks", () => {
    const cancelled = makeTask().cancel(
      { kind: "user", message: "cancelled by user" },
      { now: fixedNow },
    );
    const wire = JSON.parse(JSON.stringify(cancelled));
    expect(wire.cancellation).toEqual({ kind: "user", message: "cancelled by user" });
    expect(wire.failure).toBeUndefined();
    expect(wire.success).toBeUndefined();
  });
});

describe("Task.fromStored — typed payload invariants", () => {
  it("rejects status='failed' without a failure payload", () => {
    expect(() =>
      Task.fromStored({
        id: FIXED_ID,
        agent: "a",
        brief: "do",
        origin: "standalone",
        status: "failed",
        metadata: {},
        createdAt: fixedNow,
        startedAt: fixedNow,
        endedAt: fixedNow,
      }),
    ).toThrow(/task.failure is required when status is 'failed'/);
  });

  it("rejects status='cancelled' without a cancellation payload", () => {
    expect(() =>
      Task.fromStored({
        id: FIXED_ID,
        agent: "a",
        brief: "do",
        origin: "standalone",
        status: "cancelled",
        metadata: {},
        createdAt: fixedNow,
        startedAt: fixedNow,
        endedAt: fixedNow,
      }),
    ).toThrow(/task.cancellation is required when status is 'cancelled'/);
  });

  it("rejects status='succeeded' without a success payload", () => {
    expect(() =>
      Task.fromStored({
        id: FIXED_ID,
        agent: "a",
        brief: "do",
        origin: "standalone",
        status: "succeeded",
        metadata: {},
        createdAt: fixedNow,
        startedAt: fixedNow,
        endedAt: fixedNow,
      }),
    ).toThrow(/task.success is required when status is 'succeeded'/);
  });

  it("rejects an out-of-union failure kind", () => {
    expect(() =>
      Task.fromStored({
        id: FIXED_ID,
        agent: "a",
        brief: "do",
        origin: "standalone",
        status: "failed",
        metadata: {},
        createdAt: fixedNow,
        startedAt: fixedNow,
        endedAt: fixedNow,
        // biome-ignore lint/suspicious/noExplicitAny: testing a corrupted shape
        failure: { kind: "bogus", message: "no" } as any,
      }),
    ).toThrow(/task.failure.kind must be one of/);
  });

  it("rejects an out-of-union cancellation kind", () => {
    expect(() =>
      Task.fromStored({
        id: FIXED_ID,
        agent: "a",
        brief: "do",
        origin: "standalone",
        status: "cancelled",
        metadata: {},
        createdAt: fixedNow,
        startedAt: fixedNow,
        endedAt: fixedNow,
        // biome-ignore lint/suspicious/noExplicitAny: testing a corrupted shape
        cancellation: { kind: "ghost", message: "no" } as any,
      }),
    ).toThrow(/task.cancellation.kind must be one of/);
  });

  it("requires exit_code on failure.kind='exited'", () => {
    expect(() =>
      Task.fromStored({
        id: FIXED_ID,
        agent: "a",
        brief: "do",
        origin: "standalone",
        status: "failed",
        metadata: {},
        createdAt: fixedNow,
        startedAt: fixedNow,
        endedAt: fixedNow,
        // biome-ignore lint/suspicious/noExplicitAny: testing a corrupted shape
        failure: { kind: "exited", message: "no" } as any,
      }),
    ).toThrow(/exit_code must be a number/);
  });

  it("requires signal on failure.kind='signal'", () => {
    expect(() =>
      Task.fromStored({
        id: FIXED_ID,
        agent: "a",
        brief: "do",
        origin: "standalone",
        status: "failed",
        metadata: {},
        createdAt: fixedNow,
        startedAt: fixedNow,
        endedAt: fixedNow,
        // biome-ignore lint/suspicious/noExplicitAny: testing a corrupted shape
        failure: { kind: "signal", message: "no" } as any,
      }),
    ).toThrow(/signal must be a string/);
  });
});
