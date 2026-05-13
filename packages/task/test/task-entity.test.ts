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
    instructions: "go",
    createdAt: fixedNow,
    ...(overrides.metadata !== undefined ? { metadata: overrides.metadata } : {}),
  });

describe("Task.create", () => {
  it("starts in not_started with no result/failure/started/ended", () => {
    const t = Task.create({ agent: "a", instructions: "do" });
    expect(t.status).toBe("not_started");
    expect(t.result).toBeUndefined();
    expect(t.failure).toBeUndefined();
    expect(t.startedAt).toBeUndefined();
    expect(t.endedAt).toBeUndefined();
  });

  it("mints distinct UUID v4 ids by default", () => {
    const a = Task.create({ agent: "x", instructions: "" });
    const b = Task.create({ agent: "x", instructions: "" });
    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("honours an explicit id override", () => {
    const t = Task.create({ agent: "a", instructions: "", id: "fixed-id" });
    expect(t.id).toBe("fixed-id");
  });

  it("honours an explicit createdAt override", () => {
    const stamp = "2025-12-31T23:59:59.999Z";
    const t = Task.create({ agent: "a", instructions: "", createdAt: stamp });
    expect(t.createdAt).toBe(stamp);
  });

  it("defaults createdAt to a parseable ISO 8601 timestamp", () => {
    const before = Date.now();
    const t = Task.create({ agent: "a", instructions: "" });
    const after = Date.now();
    const parsed = Date.parse(t.createdAt);
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);
  });

  it("captures caller-supplied metadata", () => {
    const md = { creator: "alice", priority: 5 };
    const t = Task.create({ agent: "a", instructions: "", metadata: md });
    expect(t.metadata).toEqual(md);
  });

  it("defaults metadata to an empty object", () => {
    const t = Task.create({ agent: "a", instructions: "" });
    expect(t.metadata).toEqual({});
  });
});

describe("Task — happy paths", () => {
  it("start: not_started → running, sets startedAt", () => {
    const r = makeTask().start({ now: fixedNow });
    expect(r.status).toBe("running");
    expect(r.startedAt).toBe(fixedNow);
    expect(r.endedAt).toBeUndefined();
  });

  it("complete: running → success, captures output and endedAt", () => {
    const running = makeTask().start({ now: fixedNow });
    const r = running.complete("ok", { now: fixedNow });
    expect(r.status).toBe("success");
    expect(r.result).toEqual({ output: "ok" });
    expect(r.endedAt).toBe(fixedNow);
    expect(r.failure).toBeUndefined();
  });

  it("fail: running → failure, captures error", () => {
    const running = makeTask().start({ now: fixedNow });
    const r = running.fail("boom", { now: fixedNow });
    expect(r.status).toBe("failure");
    expect(r.failure).toEqual({ error: "boom" });
    expect(r.result).toBeUndefined();
  });

  it("cancel: running → cancelled", () => {
    const running = makeTask().start({ now: fixedNow });
    const r = running.cancel({ now: fixedNow });
    expect(r.status).toBe("cancelled");
    expect(r.endedAt).toBe(fixedNow);
  });

  it("cancel: not_started → cancelled (allowed for pre-flight failures)", () => {
    const r = makeTask().cancel({ now: fixedNow });
    expect(r.status).toBe("cancelled");
    expect(r.startedAt).toBeUndefined();
    expect(r.endedAt).toBe(fixedNow);
  });

  it("transition methods use a default `now` when not provided", () => {
    const before = Date.now();
    const r = makeTask().start();
    const after = Date.now();
    expect(typeof r.startedAt).toBe("string");
    const parsed = Date.parse(r.startedAt as string);
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);
  });
});

describe("Task — invalid transitions", () => {
  it("rejects complete and fail while still in not_started", () => {
    const t = makeTask();
    expect(() => t.complete("x", { now: fixedNow })).toThrow(InvalidTransition);
    expect(() => t.fail("x", { now: fixedNow })).toThrow(InvalidTransition);
  });

  it("rejects start on a running task", () => {
    const running = makeTask().start({ now: fixedNow });
    expect(() => running.start({ now: fixedNow })).toThrow(InvalidTransition);
  });

  it("rejects every transition on a terminal success task", () => {
    const success = makeTask().start({ now: fixedNow }).complete("y", { now: fixedNow });
    expect(() => success.start({ now: fixedNow })).toThrow(InvalidTransition);
    expect(() => success.complete("x", { now: fixedNow })).toThrow(InvalidTransition);
    expect(() => success.fail("x", { now: fixedNow })).toThrow(InvalidTransition);
    expect(() => success.cancel({ now: fixedNow })).toThrow(InvalidTransition);
  });

  it("rejects every transition on a terminal failure task", () => {
    const failed = makeTask().start({ now: fixedNow }).fail("no", { now: fixedNow });
    expect(() => failed.complete("x", { now: fixedNow })).toThrow(InvalidTransition);
    expect(() => failed.start({ now: fixedNow })).toThrow(InvalidTransition);
    expect(() => failed.cancel({ now: fixedNow })).toThrow(InvalidTransition);
  });

  it("rejects every transition on a terminal cancelled task", () => {
    const cancelled = makeTask().cancel({ now: fixedNow });
    expect(() => cancelled.start({ now: fixedNow })).toThrow(InvalidTransition);
    expect(() => cancelled.complete("x", { now: fixedNow })).toThrow(InvalidTransition);
    expect(() => cancelled.fail("x", { now: fixedNow })).toThrow(InvalidTransition);
    expect(() => cancelled.cancel({ now: fixedNow })).toThrow(InvalidTransition);
  });

  it("InvalidTransition exposes from-status and event type", () => {
    try {
      makeTask().complete("", { now: fixedNow });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidTransition);
      expect((e as InvalidTransition).from).toBe("not_started");
      expect((e as InvalidTransition).eventType).toBe("complete");
    }
  });
});

describe("Task — metadata merge on transitions", () => {
  it("start merges metadata into the task's existing metadata", () => {
    const t = makeTask({ metadata: { creator: "alice" } });
    const r = t.start({ metadata: { pid: 1234 }, now: fixedNow });
    expect(r.metadata).toEqual({ creator: "alice", pid: 1234 });
  });

  it("later transitions overwrite earlier keys (last-wins)", () => {
    const t = makeTask().start({ metadata: { pid: 1, attempt: 1 }, now: fixedNow });
    const r = t.complete("ok", { metadata: { attempt: 2 }, now: fixedNow });
    expect(r.metadata).toEqual({ pid: 1, attempt: 2 });
  });

  it("transition without metadata leaves existing metadata untouched (and shares ref)", () => {
    const t = makeTask({ metadata: { creator: "alice" } });
    const r = t.start({ now: fixedNow });
    expect(r.metadata).toEqual({ creator: "alice" });
    // Implementation contract: when no patch is supplied, the metadata
    // reference is shared (Readonly is safe). Future refactors that
    // copy unconditionally would silently regress this.
    expect(r.metadata).toBe(t.metadata);
  });

  it("fail / cancel also accept metadata", () => {
    const running = makeTask().start({ now: fixedNow });
    const failed = running.fail("x", { metadata: { lastSession: "abc" }, now: fixedNow });
    expect(failed.metadata).toEqual({ lastSession: "abc" });

    const cancelled = makeTask().cancel({
      metadata: { reason: "user-aborted" },
      now: fixedNow,
    });
    expect(cancelled.metadata).toEqual({ reason: "user-aborted" });
  });

  it("undefined values in metadata are still merged (no special-case deletion)", () => {
    const t = makeTask({ metadata: { keep: "yes" } });
    const r = t.start({ metadata: { keep: undefined }, now: fixedNow });
    expect("keep" in r.metadata).toBe(true);
    expect(r.metadata.keep).toBeUndefined();
  });
});

describe("Task — purity", () => {
  it("does not mutate the input task", () => {
    const t = makeTask({ metadata: { a: 1 } });
    const snapshot = JSON.stringify(t);
    t.start({ metadata: { b: 2 }, now: fixedNow });
    expect(JSON.stringify(t)).toBe(snapshot);
  });

  it("returns a new metadata object when a transition supplies a patch", () => {
    const t = makeTask({ metadata: { a: 1 } });
    const r = t.start({ metadata: { b: 2 }, now: fixedNow });
    expect(r.metadata).not.toBe(t.metadata);
  });
});

describe("Task.withMetadata", () => {
  it("replaces metadata wholesale, preserves status + timing + identity", () => {
    const t = makeTask({ metadata: { keep: "no" } }).start({
      metadata: { pid: 7 },
      now: fixedNow,
    });
    const r = t.withMetadata({ title: "fresh" });
    expect(r.metadata).toEqual({ title: "fresh" });
    expect(r.status).toBe("running");
    expect(r.startedAt).toBe(fixedNow);
    expect(r.id).toBe(t.id);
    expect(r.agent).toBe(t.agent);
    expect(r.instructions).toBe(t.instructions);
    expect(r.createdAt).toBe(t.createdAt);
  });
});

describe("Task.fromStored", () => {
  it("rebuilds a task from a storage row", () => {
    const t = Task.fromStored({
      id: FIXED_ID,
      agent: "a",
      instructions: "do",
      status: "success",
      metadata: { pid: 100 },
      createdAt: fixedNow,
      startedAt: fixedNow,
      endedAt: fixedNow,
      result: { output: "ok" },
    });
    expect(t.status).toBe("success");
    expect(t.result).toEqual({ output: "ok" });
    expect(t.metadata).toEqual({ pid: 100 });
  });

  it("throws InvalidTaskIdError on a malformed id", () => {
    expect(() =>
      Task.fromStored({
        id: "../../etc",
        agent: "a",
        instructions: "do",
        status: "not_started",
        metadata: {},
        createdAt: fixedNow,
      }),
    ).toThrow(InvalidTaskIdError);
  });

  it("throws CorruptedTaskError on an unknown status", () => {
    expect(() =>
      Task.fromStored({
        id: FIXED_ID,
        agent: "a",
        instructions: "do",
        status: "invented" as TaskStatus,
        metadata: {},
        createdAt: fixedNow,
      }),
    ).toThrow(/status must be one of/);
  });
});

describe("Task.toJSON", () => {
  it("serialises automatically via JSON.stringify with byte-identical wire shape", () => {
    const t = makeTask({ metadata: { creator: "alice" } });
    const wire = JSON.parse(JSON.stringify(t));
    expect(wire).toEqual({
      id: FIXED_ID,
      agent: "a",
      instructions: "go",
      status: "not_started",
      metadata: { creator: "alice" },
      createdAt: fixedNow,
    });
  });

  it("includes optional fields only when present", () => {
    const success = makeTask().start({ now: fixedNow }).complete("ok", { now: fixedNow });
    const wire = JSON.parse(JSON.stringify(success));
    expect(wire).toMatchObject({
      status: "success",
      startedAt: fixedNow,
      endedAt: fixedNow,
      result: { output: "ok" },
    });
    expect(wire.failure).toBeUndefined();
  });
});
