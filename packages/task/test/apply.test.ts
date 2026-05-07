import { describe, expect, it } from "vitest";
import { apply } from "../src/apply.js";
import { create } from "../src/create.js";
import { InvalidTransition } from "../src/errors.js";
import type { Task, TaskEvent } from "../src/types.js";

const fixedNow = "2025-06-01T12:00:00.000Z";

const makeTask = (overrides: Partial<Task> = {}): Task => ({
  ...create({ agent: "a", instructions: "go", id: "t-1", createdAt: fixedNow }),
  ...overrides,
});

describe("apply — happy paths", () => {
  it("start: not_started → running, sets startedAt", () => {
    const t = makeTask();
    const r = apply(t, { type: "start" }, fixedNow);
    expect(r.status).toBe("running");
    expect(r.startedAt).toBe(fixedNow);
    expect(r.endedAt).toBeUndefined();
  });

  it("complete: running → success, captures output and endedAt", () => {
    const running = apply(makeTask(), { type: "start" }, fixedNow);
    const r = apply(running, { type: "complete", output: "ok" }, fixedNow);
    expect(r.status).toBe("success");
    expect(r.result).toEqual({ output: "ok" });
    expect(r.endedAt).toBe(fixedNow);
    expect(r.failure).toBeUndefined();
  });

  it("fail: running → failure, captures error", () => {
    const running = apply(makeTask(), { type: "start" }, fixedNow);
    const r = apply(running, { type: "fail", error: "boom" }, fixedNow);
    expect(r.status).toBe("failure");
    expect(r.failure).toEqual({ error: "boom" });
    expect(r.result).toBeUndefined();
  });

  it("cancel: running → cancelled", () => {
    const running = apply(makeTask(), { type: "start" }, fixedNow);
    const r = apply(running, { type: "cancel" }, fixedNow);
    expect(r.status).toBe("cancelled");
    expect(r.endedAt).toBe(fixedNow);
  });

  it("cancel: not_started → cancelled (allowed for pre-flight failures)", () => {
    const t = makeTask();
    const r = apply(t, { type: "cancel" }, fixedNow);
    expect(r.status).toBe("cancelled");
    expect(r.startedAt).toBeUndefined();
    expect(r.endedAt).toBe(fixedNow);
  });

  it("apply uses default `now` when not provided", () => {
    const before = Date.now();
    const r = apply(makeTask(), { type: "start" });
    const after = Date.now();
    expect(r.startedAt).toBeDefined();
    expect(typeof r.startedAt).toBe("string");
    const parsed = Date.parse(r.startedAt as string);
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);
  });
});

describe("apply — invalid transitions", () => {
  it.each(
    ["complete" as const, "fail" as const, "cancel" as const].map((type) => [type]),
  )("rejects %s while still in not_started", (type) => {
    const t = makeTask();
    // cancel is actually allowed from not_started — skip in this branch
    if (type === "cancel") {
      expect(() => apply(t, { type } as TaskEvent, fixedNow)).not.toThrow();
      return;
    }
    const event: TaskEvent =
      type === "complete" ? { type: "complete", output: "x" } : { type: "fail", error: "x" };
    expect(() => apply(t, event, fixedNow)).toThrow(InvalidTransition);
  });

  it("rejects start on a running task", () => {
    const running = apply(makeTask(), { type: "start" }, fixedNow);
    expect(() => apply(running, { type: "start" }, fixedNow)).toThrow(InvalidTransition);
  });

  it.each([
    { type: "start" } as const,
    { type: "complete", output: "x" } as const,
    { type: "fail", error: "x" } as const,
    { type: "cancel" } as const,
  ])("rejects $type on a terminal success task", (event) => {
    const success = apply(
      apply(makeTask(), { type: "start" }, fixedNow),
      { type: "complete", output: "y" },
      fixedNow,
    );
    expect(() => apply(success, event, fixedNow)).toThrow(InvalidTransition);
  });

  it("rejects events on a terminal failure task", () => {
    const failed = apply(
      apply(makeTask(), { type: "start" }, fixedNow),
      { type: "fail", error: "no" },
      fixedNow,
    );
    expect(() => apply(failed, { type: "complete", output: "x" }, fixedNow)).toThrow(
      InvalidTransition,
    );
  });

  it("rejects events on a terminal cancelled task", () => {
    const cancelled = apply(makeTask(), { type: "cancel" }, fixedNow);
    expect(() => apply(cancelled, { type: "start" }, fixedNow)).toThrow(InvalidTransition);
  });

  it("InvalidTransition exposes from-status and event type", () => {
    try {
      apply(makeTask(), { type: "complete", output: "" }, fixedNow);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidTransition);
      expect((e as InvalidTransition).from).toBe("not_started");
      expect((e as InvalidTransition).eventType).toBe("complete");
    }
  });
});

describe("apply — metadata merge", () => {
  it("start merges metadata into the task's existing metadata", () => {
    const t = makeTask({ metadata: { creator: "alice" } });
    const r = apply(t, { type: "start", metadata: { pid: 1234 } }, fixedNow);
    expect(r.metadata).toEqual({ creator: "alice", pid: 1234 });
  });

  it("later events overwrite earlier keys (last-wins)", () => {
    const t = apply(makeTask(), { type: "start", metadata: { pid: 1, attempt: 1 } }, fixedNow);
    const r = apply(t, { type: "complete", output: "ok", metadata: { attempt: 2 } }, fixedNow);
    expect(r.metadata).toEqual({ pid: 1, attempt: 2 });
  });

  it("event without metadata leaves existing metadata untouched", () => {
    const t = makeTask({ metadata: { creator: "alice" } });
    const r = apply(t, { type: "start" }, fixedNow);
    expect(r.metadata).toEqual({ creator: "alice" });
  });

  it("fail / cancel also accept metadata", () => {
    const running = apply(makeTask(), { type: "start" }, fixedNow);
    const failed = apply(
      running,
      { type: "fail", error: "x", metadata: { lastSession: "abc" } },
      fixedNow,
    );
    expect(failed.metadata).toEqual({ lastSession: "abc" });

    const cancelled = apply(
      makeTask(),
      { type: "cancel", metadata: { reason: "user-aborted" } },
      fixedNow,
    );
    expect(cancelled.metadata).toEqual({ reason: "user-aborted" });
  });

  it("undefined values in metadata are still merged (no special-case deletion)", () => {
    // Note: `undefined` would survive shallow spread; documenting intent.
    const t = makeTask({ metadata: { keep: "yes" } });
    const r = apply(t, { type: "start", metadata: { keep: undefined } }, fixedNow);
    expect("keep" in r.metadata).toBe(true);
    expect(r.metadata.keep).toBeUndefined();
  });
});

describe("apply — purity", () => {
  it("does not mutate the input task", () => {
    const t = makeTask({ metadata: { a: 1 } });
    const snapshot = JSON.stringify(t);
    apply(t, { type: "start", metadata: { b: 2 } }, fixedNow);
    expect(JSON.stringify(t)).toBe(snapshot);
  });

  it("returns a new metadata object when an event supplies a patch", () => {
    const t = makeTask({ metadata: { a: 1 } });
    const r = apply(t, { type: "start", metadata: { b: 2 } }, fixedNow);
    expect(r.metadata).not.toBe(t.metadata);
  });

  it("may share the metadata reference when no patch is supplied (Readonly is safe)", () => {
    const t = makeTask({ metadata: { a: 1 } });
    const r = apply(t, { type: "start" }, fixedNow);
    // Implementation detail: we permit reference sharing because metadata is
    // typed Readonly. The test pins the contract so future refactors stay
    // honest.
    expect(r.metadata).toBe(t.metadata);
  });
});
