/**
 * R-10 / ADR-001 §3.8 #10 — T3 cancel-concurrent-same-id.
 *
 * Two concurrent cancel(id) calls for the same live task. The
 * implementation coordinates via the `wasFirstToCancel` guard
 * inside cancel(): the first call observes `killReason === null`
 * and "owns" the kill; subsequent callers observe the prior reason,
 * await the same `live.settled` promise, then throw
 * InvalidTransition('cancelled', 'cancel') — the route maps to 409
 * for the Nth caller.
 *
 * This pins the idempotency contract.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvalidTransition } from "../src/index.js";
import { type CancelFixture, setupCancelFixture, teardownCancelFixture } from "./cancel-fixture.js";

let fx: CancelFixture;

beforeEach(async () => {
  fx = await setupCancelFixture({ autoExitOnKill: true });
});
afterEach(async () => {
  await teardownCancelFixture(fx);
});

describe("TaskManager.cancel — concurrent same-id", () => {
  it("exactly one cancel resolves; the other throws InvalidTransition", async () => {
    const t = await fx.m.dispatch({ agent: "demo", brief: "race-with-myself" });

    // Issue both cancels in the same microtask before yielding —
    // they'll race inside cancel() against the wasFirstToCancel guard.
    const [a, b] = await Promise.allSettled([fx.m.cancel(t.id), fx.m.cancel(t.id)]);

    const fulfilled = [a, b].filter((r) => r.status === "fulfilled");
    const rejected = [a, b].filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const resolvedTask = fulfilled[0].status === "fulfilled" ? fulfilled[0].value : (null as never);
    expect(resolvedTask.status).toBe("cancelled");
    expect(resolvedTask.cancellation?.kind).toBe("user");

    const err = rejected[0].status === "rejected" ? rejected[0].reason : (null as never);
    expect(err).toBeInstanceOf(InvalidTransition);
    expect((err as InvalidTransition).eventType).toBe("cancel");

    // Subprocess was killed exactly once (the second cancel saw
    // killReason !== null and skipped its own kill() call).
    expect(fx.rt.handles[0].killCount).toBe(1);
  });
});
