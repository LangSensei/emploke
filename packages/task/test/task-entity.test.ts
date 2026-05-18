import { describe, expect, it } from "vitest";
import { CorruptedTaskError, InvalidTaskIdError, InvalidTransition } from "../src/errors.js";
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
  it("starts in not_started with no result/failure/started/ended/details", () => {
    const t = Task.create({ agent: "a", brief: "do" });
    expect(t.status).toBe("not_started");
    expect(t.result).toBeUndefined();
    expect(t.failure).toBeUndefined();
    expect(t.startedAt).toBeUndefined();
    expect(t.endedAt).toBeUndefined();
    expect(t.details).toBeUndefined();
  });

  it("captures details when provided", () => {
    const t = Task.create({ agent: "a", brief: "do", details: "Tone: warm.\nLength: short." });
    expect(t.details).toBe("Tone: warm.\nLength: short.");
  });

  it("rejects empty brief at the entity boundary (defence-in-depth)", () => {
    // The route layer enforces non-empty + length + single-line at the
    // wire boundary, but the entity is the last line of defence
    // against in-process callers (tests, future orchestrators) that
    // would bypass the route. An empty brief would render as a blank
    // task title in the dashboard — the very bug this refactor exists
    // to prevent.
    expect(() => Task.create({ agent: "a", brief: "" })).toThrow(TypeError);
  });

  it("mints distinct canonical task ids by default (YYYYMMDD-xxxxxxxx)", () => {
    const a = Task.create({ agent: "x", brief: "go" });
    const b = Task.create({ agent: "x", brief: "go" });
    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(/^\d{8}-[0-9a-f]{8}$/);
  });

  it("honours an explicit canonical id override", () => {
    const t = Task.create({ agent: "a", brief: "go", id: FIXED_ID });
    expect(t.id).toBe(FIXED_ID);
  });

  it("rejects an explicit non-canonical id (matches the repo's storage contract)", () => {
    expect(() => Task.create({ agent: "a", brief: "go", id: "fixed-id" })).toThrow(
      InvalidTaskIdError,
    );
  });

  it("honours an explicit createdAt override", () => {
    const stamp = "2025-12-31T23:59:59.999Z";
    const t = Task.create({ agent: "a", brief: "go", createdAt: stamp });
    expect(t.createdAt).toBe(stamp);
  });

  it("defaults createdAt to a parseable ISO 8601 timestamp", () => {
    const before = Date.now();
    const t = Task.create({ agent: "a", brief: "go" });
    const after = Date.now();
    const parsed = Date.parse(t.createdAt);
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);
  });

  it("captures caller-supplied metadata", () => {
    const md = { creator: "alice", priority: 5 };
    const t = Task.create({ agent: "a", brief: "go", metadata: md });
    expect(t.metadata).toEqual(md);
  });

  it("defaults metadata to an empty object", () => {
    const t = Task.create({ agent: "a", brief: "go" });
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

  it("fail: running → failure, captures the typed failure payload", () => {
    const running = makeTask().start({ now: fixedNow });
    const r = running.fail({ kind: "internal", message: "boom" }, { now: fixedNow });
    expect(r.status).toBe("failure");
    expect(r.failure).toEqual({ kind: "internal", message: "boom" });
    expect(r.result).toBeUndefined();
  });

  it("cancel: running → cancelled, captures the typed cancellation payload", () => {
    const running = makeTask().start({ now: fixedNow });
    const r = running.cancel({ kind: "user", message: "cancelled by user" }, { now: fixedNow });
    expect(r.status).toBe("cancelled");
    expect(r.endedAt).toBe(fixedNow);
    expect(r.cancellation).toEqual({ kind: "user", message: "cancelled by user" });
  });

  it("cancel: not_started → cancelled (allowed for pre-flight failures)", () => {
    const r = makeTask().cancel({ kind: "user", message: "no go" }, { now: fixedNow });
    expect(r.status).toBe("cancelled");
    expect(r.startedAt).toBeUndefined();
    expect(r.endedAt).toBe(fixedNow);
    expect(r.cancellation).toEqual({ kind: "user", message: "no go" });
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

  it("transitions preserve brief + details verbatim", () => {
    const t = Task.create({
      id: FIXED_ID,
      agent: "a",
      brief: "the brief",
      details: "long body",
      createdAt: fixedNow,
    });
    const r = t.start({ now: fixedNow }).complete("ok", { now: fixedNow });
    expect(r.brief).toBe("the brief");
    expect(r.details).toBe("long body");
  });
});

describe("Task — invalid transitions", () => {
  it("rejects complete and fail while still in not_started", () => {
    const t = makeTask();
    expect(() => t.complete("x", { now: fixedNow })).toThrow(InvalidTransition);
    expect(() => t.fail({ kind: "internal", message: "x" }, { now: fixedNow })).toThrow(
      InvalidTransition,
    );
  });

  it("rejects start on a running task", () => {
    const running = makeTask().start({ now: fixedNow });
    expect(() => running.start({ now: fixedNow })).toThrow(InvalidTransition);
  });

  it("rejects every transition on a terminal success task", () => {
    const success = makeTask().start({ now: fixedNow }).complete("y", { now: fixedNow });
    expect(() => success.start({ now: fixedNow })).toThrow(InvalidTransition);
    expect(() => success.complete("x", { now: fixedNow })).toThrow(InvalidTransition);
    expect(() => success.fail({ kind: "internal", message: "x" }, { now: fixedNow })).toThrow(
      InvalidTransition,
    );
    expect(() => success.cancel({ kind: "user", message: "x" }, { now: fixedNow })).toThrow(
      InvalidTransition,
    );
  });

  it("rejects every transition on a terminal failure task", () => {
    const failed = makeTask()
      .start({ now: fixedNow })
      .fail({ kind: "internal", message: "no" }, { now: fixedNow });
    expect(() => failed.complete("x", { now: fixedNow })).toThrow(InvalidTransition);
    expect(() => failed.start({ now: fixedNow })).toThrow(InvalidTransition);
    expect(() => failed.cancel({ kind: "user", message: "x" }, { now: fixedNow })).toThrow(
      InvalidTransition,
    );
  });

  it("rejects every transition on a terminal cancelled task", () => {
    const cancelled = makeTask().cancel({ kind: "user", message: "no go" }, { now: fixedNow });
    expect(() => cancelled.start({ now: fixedNow })).toThrow(InvalidTransition);
    expect(() => cancelled.complete("x", { now: fixedNow })).toThrow(InvalidTransition);
    expect(() => cancelled.fail({ kind: "internal", message: "x" }, { now: fixedNow })).toThrow(
      InvalidTransition,
    );
    expect(() => cancelled.cancel({ kind: "user", message: "x" }, { now: fixedNow })).toThrow(
      InvalidTransition,
    );
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
    const failed = running.fail(
      { kind: "internal", message: "x" },
      { metadata: { lastSession: "abc" }, now: fixedNow },
    );
    expect(failed.metadata).toEqual({ lastSession: "abc" });

    const cancelled = makeTask().cancel(
      { kind: "user", message: "user-aborted" },
      {
        metadata: { reason: "user-aborted" },
        now: fixedNow,
      },
    );
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
    const r = t.withMetadata({ lastActiveAtRuntime: "2026-01-01T00:00:00.000Z" });
    expect(r.metadata).toEqual({ lastActiveAtRuntime: "2026-01-01T00:00:00.000Z" });
    expect(r.status).toBe("running");
    expect(r.startedAt).toBe(fixedNow);
    expect(r.id).toBe(t.id);
    expect(r.agent).toBe(t.agent);
    expect(r.brief).toBe(t.brief);
    expect(r.details).toBe(t.details);
    expect(r.createdAt).toBe(t.createdAt);
  });
});

describe("Task.fromStored", () => {
  it("rebuilds a task from a storage row", () => {
    const t = Task.fromStored({
      id: FIXED_ID,
      agent: "a",
      brief: "do",
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
    expect(t.details).toBeUndefined();
  });

  it("rebuilds with details when present", () => {
    const t = Task.fromStored({
      id: FIXED_ID,
      agent: "a",
      brief: "do",
      details: "long",
      status: "not_started",
      metadata: {},
      createdAt: fixedNow,
    });
    expect(t.details).toBe("long");
  });

  it("throws InvalidTaskIdError on a malformed id", () => {
    expect(() =>
      Task.fromStored({
        id: "../../etc",
        agent: "a",
        brief: "do",
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
        brief: "do",
        status: "invented" as TaskStatus,
        metadata: {},
        createdAt: fixedNow,
      }),
    ).toThrow(/status must be one of/);
  });

  it("throws CorruptedTaskError on empty brief", () => {
    expect(() =>
      Task.fromStored({
        id: FIXED_ID,
        agent: "a",
        brief: "",
        status: "not_started",
        metadata: {},
        createdAt: fixedNow,
      }),
    ).toThrow(CorruptedTaskError);
  });

  it("throws CorruptedTaskError on non-string details", () => {
    expect(() =>
      Task.fromStored({
        id: FIXED_ID,
        agent: "a",
        brief: "do",
        details: 42 as unknown as string,
        status: "not_started",
        metadata: {},
        createdAt: fixedNow,
      }),
    ).toThrow(/details, when present, must be a string/);
  });

  it("throws CorruptedTaskError on non-object metadata", () => {
    // Defence in depth: even when the repository sanitises metadata
    // first (parseRow throws before reaching the entity), the entity
    // factory still validates so callers that hand-build args can't
    // produce an entity in an invalid shape.
    expect(() =>
      Task.fromStored({
        id: FIXED_ID,
        agent: "a",
        brief: "do",
        status: "not_started",
        metadata: null as unknown as Record<string, unknown>,
        createdAt: fixedNow,
      }),
    ).toThrow(/metadata must be an object/);
    expect(() =>
      Task.fromStored({
        id: FIXED_ID,
        agent: "a",
        brief: "do",
        status: "not_started",
        metadata: [1, 2, 3] as unknown as Record<string, unknown>,
        createdAt: fixedNow,
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
      status: "not_started",
      metadata: { creator: "alice" },
      createdAt: fixedNow,
    });
  });

  it("omits optional details when undefined; includes when set", () => {
    const noDetails = JSON.parse(JSON.stringify(makeTask()));
    expect("details" in noDetails).toBe(false);
    const withDetails = Task.create({
      id: FIXED_ID,
      agent: "a",
      brief: "go",
      details: "extra",
      createdAt: fixedNow,
    });
    expect(JSON.parse(JSON.stringify(withDetails)).details).toBe("extra");
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
    expect(wire.cancellation).toBeUndefined();
  });

  it("includes the typed failure payload on serialised failure tasks", () => {
    const failed = makeTask()
      .start({ now: fixedNow })
      .fail({ kind: "exited", exitCode: 17, message: "exited with code 17" }, { now: fixedNow });
    const wire = JSON.parse(JSON.stringify(failed));
    expect(wire.failure).toEqual({ kind: "exited", exitCode: 17, message: "exited with code 17" });
    expect(wire.cancellation).toBeUndefined();
    expect(wire.result).toBeUndefined();
  });

  it("includes the typed cancellation payload on serialised cancelled tasks", () => {
    const cancelled = makeTask().cancel(
      { kind: "user", message: "cancelled by user" },
      { now: fixedNow },
    );
    const wire = JSON.parse(JSON.stringify(cancelled));
    expect(wire.cancellation).toEqual({ kind: "user", message: "cancelled by user" });
    expect(wire.failure).toBeUndefined();
    expect(wire.result).toBeUndefined();
  });
});

describe("Task.fromStored — typed payload invariants (ADR-001)", () => {
  it("rejects status='failure' without a failure payload", () => {
    expect(() =>
      Task.fromStored({
        id: FIXED_ID,
        agent: "a",
        brief: "do",
        status: "failure",
        metadata: {},
        createdAt: fixedNow,
        startedAt: fixedNow,
        endedAt: fixedNow,
      }),
    ).toThrow(/task.failure is required when status is 'failure'/);
  });

  it("rejects status='cancelled' without a cancellation payload", () => {
    expect(() =>
      Task.fromStored({
        id: FIXED_ID,
        agent: "a",
        brief: "do",
        status: "cancelled",
        metadata: {},
        createdAt: fixedNow,
        startedAt: fixedNow,
        endedAt: fixedNow,
      }),
    ).toThrow(/task.cancellation is required when status is 'cancelled'/);
  });

  it("rejects an out-of-union failure kind", () => {
    expect(() =>
      Task.fromStored({
        id: FIXED_ID,
        agent: "a",
        brief: "do",
        status: "failure",
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

  it("requires exitCode on failure.kind='exited'", () => {
    expect(() =>
      Task.fromStored({
        id: FIXED_ID,
        agent: "a",
        brief: "do",
        status: "failure",
        metadata: {},
        createdAt: fixedNow,
        startedAt: fixedNow,
        endedAt: fixedNow,
        // biome-ignore lint/suspicious/noExplicitAny: testing a corrupted shape
        failure: { kind: "exited", message: "no" } as any,
      }),
    ).toThrow(/exitCode must be a number/);
  });

  it("requires signal on failure.kind='signal'", () => {
    expect(() =>
      Task.fromStored({
        id: FIXED_ID,
        agent: "a",
        brief: "do",
        status: "failure",
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
